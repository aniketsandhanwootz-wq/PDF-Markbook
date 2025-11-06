# services/api/routers/mark_sets.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

# ---- DI from main.py ----
def get_storage():
    from main import get_storage_adapter
    return get_storage_adapter()

router = APIRouter(prefix="/mark-sets", tags=["mark-sets"])

# ---------- Schemas ----------
class MarkSetPatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    updated_by: str = Field(..., min_length=3, description="Email or user id performing the update")

class MarkSetClone(BaseModel):
    new_label: str = Field(..., min_length=1, max_length=200)
    created_by: str | None = Field(default=None, description="Email or user id creating the clone")

# ---------- Endpoints ----------

@router.patch("/{mark_set_id}")
async def patch_mark_set(mark_set_id: str, body: MarkSetPatch, storage = Depends(get_storage)):
    """
    Rename a mark set (and append to updation_log) on Google Sheets.
    """
    try:
        # Ensure backend is Sheets
        if not hasattr(storage, "update_mark_set"):
            raise HTTPException(status_code=501, detail="PATCH only supported with Google Sheets backend")

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
async def clone_mark_set(mark_set_id: str, body: MarkSetClone, storage = Depends(get_storage)):
    """
    Deep-clone a mark set (rows in marks + mark_sets) on Google Sheets.
    Returns the new mark_set_id.
    """
    try:
        if not hasattr(storage, "clone_mark_set"):
            raise HTTPException(status_code=501, detail="Clone only supported with Google Sheets backend")

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
