# services/api/routers/groups.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
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
async def update_group(group_id: str, body: GroupUpdate, storage: Storage):
    """
    Update group metadata or mark_ids.
    """
    try:
        updates = body.model_dump(exclude_unset=True)
        updated = storage.update_group(group_id, updates)
        return updated
    except ValueError as e:
        if "GROUP_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="GROUP_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update group: {e}")


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(group_id: str, storage: Storage):
    """
    Delete a group by id.
    """
    try:
        storage.delete_group(group_id)
    except ValueError as e:
        if "GROUP_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="GROUP_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete group: {e}")
