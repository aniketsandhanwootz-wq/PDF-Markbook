# services/api/routers/mark_sets_master.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from typing import Annotated
from main import get_storage_adapter  # DI helper

router = APIRouter(prefix="/mark-sets", tags=["mark-sets"])

Storage = Annotated[object, Depends(get_storage_adapter)]

@router.post("/{mark_set_id}/master", status_code=status.HTTP_200_OK)
async def make_master_mark_set(mark_set_id: str, storage: Storage):
    """
    Mark this mark_set as the single Master for its document (is_master=TRUE).
    All siblings on the same doc become FALSE.
    """
    try:
        # validate
        rows = storage._get_all_dicts("mark_sets")
        target = next((ms for ms in rows if ms.get("mark_set_id") == mark_set_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

        storage.set_master_mark_set(mark_set_id)
        return {"status": "master_set", "mark_set_id": mark_set_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
