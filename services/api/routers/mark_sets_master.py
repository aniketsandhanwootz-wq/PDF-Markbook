# services/api/routers/mark_sets_master.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import Annotated, Dict, Any, Optional

from main import get_storage_adapter, get_settings  # DI helpers

router = APIRouter(prefix="/mark-sets", tags=["mark-sets"])


def get_storage():
    """
    Same DI pattern as marks.py / mark_sets.py:
    grab settings, then build the storage adapter.
    """
    return get_storage_adapter(get_settings())


Storage = Annotated[object, Depends(get_storage)]


def _user_can_edit_master(doc: Dict[str, Any], user_email: Optional[str]) -> bool:
    """
    Permission rules for changing master mark-set:

    - If documents.master_editors is empty/missing:
        -> allow everyone (backwards compatible)
    - Else:
        -> user_email must be in that comma-separated list
    """
    editors_raw = (doc.get("master_editors") or "").strip()
    if not editors_raw:
        return True
    if not user_email:
        return False
    allowed = {e.strip().lower() for e in editors_raw.split(",") if e.strip()}
    return user_email.strip().lower() in allowed


@router.post("/{mark_set_id}/master", status_code=status.HTTP_200_OK)
async def make_master_mark_set(
    mark_set_id: str,
    storage: Storage,  # ✅ dependency comes from get_storage()
    user_mail: Optional[str] = Query(
        None,
        description="User email attempting to set this markset as master",
    ),
):
    """
    Mark this mark_set as the single Master for its document (is_master=TRUE).
    All siblings on the same doc become FALSE.

    Permission:
    - If documents.master_editors is non-empty, user_mail must be in that list.
    - If master_editors is empty, allow any user (backwards compatible).
    """
    try:
        # 1) validate mark_set exists
        rows = storage._get_all_dicts("mark_sets")
        target = next((ms for ms in rows if ms.get("mark_set_id") == mark_set_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

        doc_id = target.get("doc_id")
        if not doc_id:
            raise HTTPException(status_code=500, detail="MARK_SET_HAS_NO_DOC_ID")

        doc = storage.get_document(doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

        # 2) Permission check
        if not _user_can_edit_master(doc, user_mail):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="USER_NOT_ALLOWED_TO_EDIT_MASTER_MARKSET",
            )

        # 3) Flip is_master for siblings
        storage.set_master_mark_set(mark_set_id)
        return {"status": "master_set", "mark_set_id": mark_set_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
