# services/api/routers/mark_sets.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any


# ---- DI from main.py ----
def get_storage():
    # Mirror marks.py pattern so both use the same adapter
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())


router = APIRouter(prefix="/mark-sets", tags=["mark-sets"])


# ---------- Helpers ----------

def _bool(val: str | None) -> bool:
    return (val or "").strip().upper() == "TRUE"


def _user_can_edit_master(doc: Dict[str, Any], user_email: Optional[str]) -> bool:
    """
    Master permission rule:

    - If documents.master_editors is empty/missing -> allow everyone
      (backwards compatible).
    - If master_editors has emails -> user_email must be in that list.
    """
    editors_raw = (doc.get("master_editors") or "").strip()
    if not editors_raw:
        # No restriction configured -> open
        return True

    if not user_email:
        return False

    allowed = {e.strip().lower() for e in editors_raw.split(",") if e.strip()}
    return user_email.strip().lower() in allowed


def _load_markset_and_doc(storage, mark_set_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Helper to load:
      - the mark_set row
      - the corresponding document row

    Raises HTTPException on errors.
    """
    if not hasattr(storage, "_get_all_dicts"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="This operation is only supported with the Google Sheets backend",
        )

    ms_rows = storage._get_all_dicts("mark_sets")
    target = next((ms for ms in ms_rows if ms.get("mark_set_id") == mark_set_id), None)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MARK_SET_NOT_FOUND")

    doc_id = target.get("doc_id")
    if not doc_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="MARK_SET_HAS_NO_DOC_ID",
        )

    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="DOCUMENT_NOT_FOUND")

    return target, doc


# ---------- Schemas ----------

class MarkSetPatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    updated_by: str = Field(
        ...,
        min_length=3,
        description="Email or user id performing the update (used for permission check)",
    )


class MarkSetClone(BaseModel):
    new_label: str = Field(..., min_length=1, max_length=200)
    created_by: str | None = Field(
        default=None,
        description="Email or user id creating the clone (will be set as created_by of new markset)",
    )


# ---------- Mark set update / clone / delete ----------

@router.patch("/{mark_set_id}")
async def patch_mark_set(
    mark_set_id: str,
    body: MarkSetPatch,
    storage = Depends(get_storage),
):
    """
    Rename a mark set (and append to update_history) on Google Sheets.

    Permissions:
    - If is_master == TRUE:
        * Only users listed in documents.master_editors can edit.
    - If is_master == FALSE (QC markset):
        * Only mark_sets.created_by can edit.
    """
    try:
        if not hasattr(storage, "update_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="PATCH only supported with Google Sheets backend",
            )

        ms_row, doc = _load_markset_and_doc(storage, mark_set_id)

        is_master = _bool(ms_row.get("is_master"))
        owner = (ms_row.get("created_by") or "").strip().lower()
        user_email = (body.updated_by or "").strip().lower()

        if is_master:
            if not _user_can_edit_master(doc, user_email):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="USER_NOT_ALLOWED_TO_EDIT_MASTER_MARKSET",
                )
        else:
            if owner and owner != user_email:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="NOT_OWNER",
                )

        storage.update_mark_set(
            mark_set_id=mark_set_id,
            label=body.label,
            updated_by=body.updated_by,
        )
        return {"status": "ok", "mark_set_id": mark_set_id, "label": body.label}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to patch mark set: {e}")


@router.post("/{mark_set_id}/clone", status_code=status.HTTP_201_CREATED)
async def clone_mark_set(
    mark_set_id: str,
    body: MarkSetClone,
    storage = Depends(get_storage),
):
    """
    Deep-clone a **QC** mark set (rows in marks + mark_sets) on Google Sheets.
    Returns the new mark_set_id.

    Permissions:
    - If source is MASTER (is_master == TRUE):
        ❌ Not allowed at all (master markset cannot be cloned).
    - If source is QC markset (is_master == FALSE):
        ✅ Anyone can clone. (No ownership check.)
    """
    try:
        if not hasattr(storage, "clone_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Clone only supported with Google Sheets backend",
            )

        ms_row, _doc = _load_markset_and_doc(storage, mark_set_id)

        is_master = _bool(ms_row.get("is_master"))

        if is_master:
            # HARD RULE: master markset must never be cloned
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="CANNOT_CLONE_MASTER_MARKSET",
            )

        # QC markset -> no restriction on who can clone
        new_id = storage.clone_mark_set(
            mark_set_id=mark_set_id,
            new_label=body.new_label,
            created_by=body.created_by,
        )
        return {"status": "created", "mark_set_id": new_id, "label": body.new_label}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clone mark set: {e}")


@router.delete("/{mark_set_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mark_set(
    mark_set_id: str,
    user_mail: str = Query(
        ...,
        min_length=3,
        description="Email of user requesting deletion (must be the creator)",
    ),
    storage = Depends(get_storage),
):
    """
    Delete a non-master mark set.

    Rules (enforced mostly in SheetsAdapter.delete_mark_set):
    - Cannot delete if is_master == TRUE.
    - Only the user who created the markset (created_by) can delete it.
    - Also deletes marks, groups, user inputs, and inspection reports for that markset.
    """
    try:
        if not hasattr(storage, "delete_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Delete not supported by this backend",
            )

        storage.delete_mark_set(mark_set_id, requested_by=user_mail)
        return
    except ValueError as e:
        msg = str(e)
        if "MARK_SET_NOT_FOUND" in msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MARK_SET_NOT_FOUND")
        if "CANNOT_DELETE_MASTER" in msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="CANNOT_DELETE_MASTER")
        if "NOT_OWNER" in msg:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="NOT_OWNER")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete mark set: {e}",
        )


# ---------- Groups under a Mark Set (editor side) ----------

class MarkSetGroupCreate(BaseModel):
    """
    Payload to create a QC group for a specific mark_set_id.
    This is the shape the editor frontend POSTs to /mark-sets/{id}/groups.
    """
    page_index: int = Field(..., ge=0, description="0-based page index")
    name: str = Field(..., min_length=1, max_length=200)
    nx: float = Field(..., gt=0.0, le=1.0)
    ny: float = Field(..., gt=0.0, le=1.0)
    nw: float = Field(..., gt=0.0, le=1.0)
    nh: float = Field(..., gt=0.0, le=1.0)
    mark_ids: List[str] = Field(default_factory=list, description="List of master mark_ids in this group")
    created_by: Optional[str] = Field(None, description="User email creating the group")


class GroupOut(BaseModel):
    group_id: str
    name: str
    page_index: int
    nx: float
    ny: float
    nw: float
    nh: float
    mark_ids: List[str] = Field(default_factory=list)


@router.post("/{mark_set_id}/groups", status_code=status.HTTP_201_CREATED)
async def create_group_for_mark_set(
    mark_set_id: str,
    body: MarkSetGroupCreate,
    storage = Depends(get_storage),
):
    """
    Thin wrapper so the editor can POST /mark-sets/{id}/groups.

    It simply forwards to storage.create_group, which persists to Sheets.
    """
    try:
        if not hasattr(storage, "create_group"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Groups not supported by this backend",
            )

        group_id = storage.create_group(
            mark_set_id=mark_set_id,
            page_index=body.page_index,
            name=body.name,
            nx=body.nx,
            ny=body.ny,
            nw=body.nw,
            nh=body.nh,
            mark_ids=body.mark_ids,
            created_by=body.created_by or "",
        )
        return {"status": "created", "group_id": group_id}
    except ValueError as e:
        msg = str(e)
        if "MARK_SET_NOT_FOUND" in msg:
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")
        if msg.startswith("PAGE_INDEX_NOT_FOUND"):
            raise HTTPException(status_code=400, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create group: {e}")


@router.get("/{mark_set_id}/groups", response_model=List[GroupOut])
async def list_groups_for_mark_set(
    mark_set_id: str,
    storage = Depends(get_storage),
):
    """
    Return all groups for a mark set (QC marksets) for the Editor sidebar.

    Used by the Editor via:
      GET /mark-sets/{mark_set_id}/groups
    """
    try:
        # ✅ Use the same storage method name as groups.py
        if not hasattr(storage, "list_groups_for_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Groups not supported by this backend",
            )

        raw_groups = storage.list_groups_for_mark_set(mark_set_id)

        out: List[GroupOut] = []
        for g in raw_groups or []:
            mark_ids = g.get("mark_ids") or []
            # Allow comma-separated string in Sheets
            if isinstance(mark_ids, str):
                mark_ids = [m.strip() for m in mark_ids.split(",") if m.strip()]

            out.append(
                GroupOut(
                    group_id=g.get("group_id"),
                    name=g.get("name") or "",
                    page_index=int(g.get("page_index", 0)),
                    nx=float(g.get("nx")),
                    ny=float(g.get("ny")),
                    nw=float(g.get("nw")),
                    nh=float(g.get("nh")),
                    mark_ids=list(mark_ids),
                )
            )

        return out
    except ValueError as e:
        msg = str(e)
        if "MARK_SET_NOT_FOUND" in msg:
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")
        raise HTTPException(status_code=400, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch groups: {e}",
        )
