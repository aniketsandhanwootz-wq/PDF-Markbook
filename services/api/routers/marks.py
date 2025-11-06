"""
Mark set and mark management endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from typing import Annotated, List
import re
import urllib.parse
from logging import getLogger

from schemas import MarkSetCreate, MarkSetOut, MarkOut, MarkPatch
from core.validation import (
    validate_normalized_rect,
    ensure_unique_order_index,
    coerce_anchor
)
from adapters.base import StorageAdapter

logger = getLogger(__name__)
router = APIRouter(tags=["marks"])


def get_storage():
    """Dependency to get storage adapter from app state."""
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())


def clean_pdf_url(url: str) -> str:
    """Extract Google Storage URL from nested Cloudinary URLs"""
    if not url or 'cloudinary.com' not in url:
        return url
    
    # Decode URL
    decoded = url
    try:
        for _ in range(5):
            prev = decoded
            decoded = urllib.parse.unquote(decoded)
            if decoded == prev:
                break
    except:
        decoded = url
    
    # Extract Google Storage URL
    match = re.search(r'https://storage\.googleapis\.com/[^\s"\'<>)]+\.pdf', decoded, re.IGNORECASE)
    if match:
        return match.group(0).replace(' ', '%20')
    
    return url


@router.post("/mark-sets", response_model=MarkSetOut, status_code=201)
async def create_mark_set(
    mark_set: MarkSetCreate,
    storage: Annotated[StorageAdapter, Depends(get_storage)]
):
    """
    Create a new mark set with all its marks.
    
    A mark set is a collection of rectangular regions of interest on a PDF document.
    All marks are created atomically - either all succeed or none are created.
    
    **Coordinate system:** All coordinates (nx, ny, nw, nh) must be normalized
    to the range [0, 1] relative to the **unrotated** page dimensions.
    This ensures coordinates remain valid regardless of page rotation.
    """
    logger.info(f"Creating mark set: {mark_set.name}")
    
    # Clean URL before saving
    cleaned_url = clean_pdf_url(mark_set.pdf_url)
    logger.info(f"Original URL: {mark_set.pdf_url[:100]}...")
    logger.info(f"Cleaned URL: {cleaned_url}")
    
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
    
    # Get or create document with CLEANED URL
    doc_id = storage.get_or_create_document(cleaned_url)
    
    # Create mark set
    mark_set_id = storage.create_mark_set(
        doc_id=doc_id,
        name=mark_set.name
    )
    
    logger.info(f"Created mark set with ID: {mark_set_id}")
    
    return MarkSetOut(id=mark_set_id)


@router.get("/mark-sets/{mark_set_id}/marks", response_model=List[MarkOut])
async def list_marks(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends(get_storage)]
):
    """
    Get all marks in a mark set, ordered by navigation sequence.
    
    Returns marks with their page indices and normalized coordinates,
    ready for rendering in the viewer.
    """
    logger.info(f"Fetching marks for set {mark_set_id}")
    marks = storage.get_marks(mark_set_id)
    logger.info(f"Fetched {len(marks)} marks for set {mark_set_id}")
    return marks


@router.put("/mark-sets/{mark_set_id}/marks", status_code=200)
async def update_marks(
    mark_set_id: str,
    marks: List[MarkOut],
    storage: Annotated[StorageAdapter, Depends(get_storage)]
):
    """
    Replace all marks in a mark set.
    
    This is used by the editor to save mark changes.
    """
    logger.info(f"Updating {len(marks)} marks for set {mark_set_id}")
    
    marks_data = [mark.model_dump() for mark in marks]
    
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
    
    storage.update_marks(mark_set_id, marks_data)
    
    return {"status": "ok", "message": f"Updated {len(marks)} marks"}


@router.patch("/marks/{mark_id}", response_model=MarkOut)
async def patch_mark(
    mark_id: str,
    patch: MarkPatch,
    storage: Annotated[StorageAdapter, Depends(get_storage)]
):
    """
    Update display preferences for a mark.
    
    This allows users to save custom zoom levels, padding, and anchor points
    for individual marks. Only the provided fields are updated.
    """
    updated_mark = storage.patch_mark(mark_id, patch.model_dump(exclude_unset=True))
    return updated_mark


@router.post("/mark-sets/{mark_set_id}/activate", status_code=200)
async def activate_mark_set(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends(get_storage)]
):
    """
    Activate a mark set for its document.
    
    Only one mark set per document can be active at a time.
    This deactivates all other mark sets for the same document
    and activates the specified one.
    """
    storage.activate_mark_set(mark_set_id)
    return {"status": "ok", "message": "Mark set activated"}