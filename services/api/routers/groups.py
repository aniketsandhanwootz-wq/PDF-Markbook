# services/api/routers/groups.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import Annotated, List, Optional
from pydantic import BaseModel, Field

from main import get_storage_adapter, get_settings  # DI helpers

router = APIRouter(prefix="/groups", tags=["groups"])


def get_storage():
  """
  Consistent DI wrapper so all routers build the same storage adapter.
  """
  return get_storage_adapter(get_settings())


Storage = Annotated[object, Depends(get_storage)]

def _safe_int(v, default: int = 0) -> int:
    try:
        if v is None:
            return default
        s = str(v).strip()
        if not s:
            return default
        return int(float(s))
    except Exception:
        return default


def _bump_content_rev(storage, mark_set_id: str, updated_by: str | None) -> int | None:
    """
    Increments mark_sets.content_rev by 1 and sets content_updated_at + updated_by.
    Best-effort (does nothing if not Sheets backend).
    """
    if not hasattr(storage, "_find_row_by_value") or not hasattr(storage, "_update_cells"):
        return None

    row_idx = storage._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
    if not row_idx:
        return None

    ms_row = None
    if hasattr(storage, "get_mark_set_row"):
        try:
            ms_row = storage.get_mark_set_row(mark_set_id)
        except Exception:
            ms_row = None

    if not ms_row and hasattr(storage, "_get_all_dicts"):
        try:
            ms_rows = storage._get_all_dicts("mark_sets")
            ms_row = next((ms for ms in ms_rows if ms.get("mark_set_id") == mark_set_id), None)
        except Exception:
            ms_row = None

    cur = _safe_int((ms_row or {}).get("content_rev"), 0)
    new_rev = cur + 1

    import time as _t
    now_iso = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime())

    storage._update_cells(
        "mark_sets",
        row_idx,
        {
            "content_rev": new_rev,
            "content_updated_at": now_iso,
            "updated_by": (updated_by or "").strip(),
        },
    )
    return new_rev


class GroupCreate(BaseModel):
    """Payload to create a QC group."""
    mark_set_id: str = Field(..., description="QC mark set id (not master)")
    page_index: int = Field(..., ge=0, description="0-based page index")
    name: str = Field(..., min_length=1, max_length=200)
    nx: float = Field(..., gt=0.0, le=1.0)
    ny: float = Field(..., gt=0.0, le=1.0)
    nw: float = Field(..., gt=0.0, le=1.0)
    nh: float = Field(..., gt=0.0, le=1.0)
    mark_ids: List[str] = Field(default_factory=list, description="List of master mark_ids in this group")
    created_by: Optional[str] = Field(None, description="User email creating the group")


class GroupUpdate(BaseModel):
    """Payload to update a QC group."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    page_index: Optional[int] = Field(None, ge=0)
    nx: Optional[float] = Field(None, gt=0.0, le=1.0)
    ny: Optional[float] = Field(None, gt=0.0, le=1.0)
    nw: Optional[float] = Field(None, gt=0.0, le=1.0)
    nh: Optional[float] = Field(None, gt=0.0, le=1.0)
    mark_ids: Optional[List[str]] = None


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_group(body: GroupCreate, storage: Storage):
    """
    Create a QC group rectangle on a QC markset and attach master marks to it.
    """
    try:
        group_id = storage.create_group(
            mark_set_id=body.mark_set_id,
            page_index=body.page_index,
            name=body.name,
            nx=body.nx,
            ny=body.ny,
            nw=body.nw,
            nh=body.nh,
            mark_ids=body.mark_ids,
            created_by=body.created_by or "",
        )
        _bump_content_rev(storage, body.mark_set_id, body.created_by or "")
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


@router.get("/{mark_set_id}", response_model=List[dict])
async def list_groups(mark_set_id: str, storage: Storage):
    """
    List all groups for a given QC markset.

    Note: storage implementation is expected to expose
      list_groups_for_mark_set(mark_set_id)
    """
    try:
        if not hasattr(storage, "list_groups_for_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Groups not supported by this backend",
            )
        groups = storage.list_groups_for_mark_set(mark_set_id)
        return groups
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list groups: {e}")


@router.patch("/{group_id}", response_model=dict)
async def update_group(
    group_id: str,
    body: GroupUpdate,
    storage: Storage,
    user_mail: str | None = Query(default=None, description="User email performing the update"),
):
    """
    Update group metadata or mark_ids.
    """
    try:
        updates = body.model_dump(exclude_unset=True)
        updated = storage.update_group(group_id, updates)
        # Best-effort bump: resolve mark_set_id from returned row
        msid = (updated.get("mark_set_id") or "").strip() if isinstance(updated, dict) else ""
        if msid:
            _bump_content_rev(storage, msid, user_mail)
        return updated
    except ValueError as e:
        if "GROUP_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="GROUP_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update group: {e}")


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    storage: Storage,
    user_mail: str | None = Query(default=None, description="User email performing the delete"),
):
    """
    Delete a group by id.
    """
    try:
        msid = ""
        try:
            if hasattr(storage, "_get_all_dicts"):
                rows = storage._get_all_dicts("groups")
                row = next((g for g in rows if g.get("group_id") == group_id), None)
                msid = (row.get("mark_set_id") or "").strip() if row else ""
        except Exception:
            msid = ""
        storage.delete_group(group_id)
        if msid:
            _bump_content_rev(storage, msid, user_mail) 
    except ValueError as e:
        if "GROUP_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="GROUP_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete group: {e}")
