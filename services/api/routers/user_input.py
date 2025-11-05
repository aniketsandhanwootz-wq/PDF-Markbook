"""
User input management endpoints.
"""
from fastapi import APIRouter, HTTPException, status
from typing import List, Optional
import logging

from schemas.user_input import UserInputCreate, UserInputBatchCreate, UserInputOut, UserInputUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/user-input", tags=["user_input"])


def get_storage():
    """Get storage adapter from main app."""
    from main import storage_adapter
    return storage_adapter


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_user_input(data: UserInputCreate):
    """Create a single user input entry."""
    try:
        storage = get_storage()
        input_id = storage.create_user_input(
            mark_id=data.mark_id,
            mark_set_id=data.mark_set_id,
            user_value=data.user_value,
            submitted_by=data.submitted_by
        )
        return {"input_id": input_id, "status": "created"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating user input: {e}")
        raise HTTPException(status_code=500, detail="Failed to create user input")


@router.post("/batch", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_user_inputs_batch(data: UserInputBatchCreate):
    """Create multiple user input entries in batch."""
    try:
        storage = get_storage()
        count = storage.create_user_inputs_batch(
            mark_set_id=data.mark_set_id,
            entries=data.entries,
            submitted_by=data.submitted_by
        )
        return {"count": count, "status": "created"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating batch user inputs: {e}")
        raise HTTPException(status_code=500, detail="Failed to create user inputs")


@router.get("", response_model=List[dict])
async def get_user_inputs(mark_set_id: str, submitted_by: Optional[str] = None):
    """Get user inputs for a mark set, optionally filtered by user."""
    try:
        storage = get_storage()
        inputs = storage.get_user_inputs(mark_set_id=mark_set_id, submitted_by=submitted_by)
        return inputs
    except Exception as e:
        logger.error(f"Error fetching user inputs: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch user inputs")


@router.put("/{input_id}", response_model=dict)
async def update_user_input(input_id: str, data: UserInputUpdate):
    """Update a user input entry."""
    try:
        storage = get_storage()
        result = storage.update_user_input(input_id=input_id, user_value=data.user_value)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error updating user input: {e}")
        raise HTTPException(status_code=500, detail="Failed to update user input")


@router.delete("/{input_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_input(input_id: str):
    """Delete a user input entry."""
    try:
        storage = get_storage()
        storage.delete_user_input(input_id=input_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error deleting user input: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete user input")