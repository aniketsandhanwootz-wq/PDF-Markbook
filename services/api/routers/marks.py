"""
Mark set and mark management endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from typing import Annotated, List

from schemas import MarkSetCreate, MarkSetOut, MarkOut, MarkPatch
from core.validation import (
    validate_normalized_rect,
    ensure_unique_order_index,
    coerce_anchor
)
from adapters.base import StorageAdapter


router = APIRouter(tags=["marks"])


@router.post("/mark-sets", response_model=MarkSetOut, status_code=201)
async def create_mark_set(
    mark_set: MarkSetCreate,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Create a new mark set with all its marks.
    
    A mark set is a collection of rectangular regions of interest on a PDF document.
    All marks are created atomically - either all succeed or none are created.
    
    **Coordinate system:** All coordinates (nx, ny, nw, nh) must be normalized
    to the range [0, 1] relative to the **unrotated** page dimensions.
    This ensures coordinates remain valid regardless of page rotation.
    """
    # Convert marks to dictionaries for validation
    marks_data = [mark.model_dump() for mark in mark_set.marks]
    
    # Validate unique order_index
    ensure_unique_order_index(marks_data)
    
    # Validate each mark's coordinates
    for mark_data in marks_data:
        validate_normalized_rect(
            mark_data["nx"],
            mark_data["ny"],
            mark_data["nw"],
            mark_data["nh"]
        )
        # Coerce anchor to valid value
        mark_data["anchor"] = coerce_anchor(mark_data.get("anchor"))
    
    # Create mark set
    mark_set_id = storage.create_mark_set(
        doc_id=mark_set.doc_id,
        label=mark_set.label or "v1",
        marks=marks_data,
        created_by=mark_set.created_by
    )
    
    return MarkSetOut(mark_set_id=mark_set_id)


@router.get("/mark-sets/{mark_set_id}/marks", response_model=List[MarkOut])
async def list_marks(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Get all marks in a mark set, ordered by navigation sequence.
    
    Returns marks with their page indices and normalized coordinates,
    ready for rendering in the viewer.
    """
    marks = storage.list_marks(mark_set_id)
    return [MarkOut(**mark) for mark in marks]


@router.patch("/marks/{mark_id}", response_model=MarkOut)
async def patch_mark(
    mark_id: str,
    patch: MarkPatch,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Update display preferences for a mark.
    
    This allows users to save custom zoom levels, padding, and anchor points
    for individual marks. Only the provided fields are updated.
    """
    # Convert to dict, excluding None values
    data = patch.model_dump(exclude_none=True)
    
    # Coerce anchor if provided
    if "anchor" in data:
        data["anchor"] = coerce_anchor(data["anchor"])
    
    # Update mark
    updated = storage.patch_mark(mark_id, data)
    return MarkOut(**updated)


@router.post("/mark-sets/{mark_set_id}/activate", status_code=200)
async def activate_mark_set(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Activate a mark set for its document.
    
    Only one mark set per document can be active at a time.
    This deactivates all other mark sets for the same document
    and activates the specified one.
    """
    storage.activate_mark_set(mark_set_id)
    return {"status": "ok", "message": f"Mark set {mark_set_id} activated"}