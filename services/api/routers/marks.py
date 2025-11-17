"""
Mark set and mark management endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, List, Dict, Any, Optional
import re
import urllib.parse
from logging import getLogger

from schemas import MarkSetCreate, MarkSetOut, MarkOut, MarkPatch
from core.validation import (
    validate_normalized_rect,
    ensure_unique_order_index,
    coerce_anchor,
)
from adapters.base import StorageAdapter

logger = getLogger(__name__)
router = APIRouter(tags=["marks"])


def get_storage() -> StorageAdapter:
    """Dependency to get storage adapter from app state."""
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())


# ---------- Shared helpers (copied from mark_sets.py semantics) ----------

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


def _load_markset_and_doc(storage: StorageAdapter, mark_set_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
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


def clean_pdf_url(url: str) -> str:
    """Extract Google Storage URL from nested Cloudinary URLs"""
    if not url or "cloudinary.com" not in url:
        return url

    # Decode URL
    decoded = url
    try:
        for _ in range(5):
            prev = decoded
            decoded = urllib.parse.unquote(decoded)
            if decoded == prev:
                break
    except Exception:
        decoded = url

    # Extract Google Storage URL
    match = re.search(r"https://storage\.googleapis\.com/[^\s\"'<>)]*\.pdf", decoded, re.IGNORECASE)
    if match:
        return match.group(0).replace(" ", "%20")

    return url


# ---------- LEGACY: mark set creation ----------
# NOTE: This endpoint was written for an older backend (SQLite).
# For the Sheets-only path, markset creation is typically handled via
# the documents/viewer bootstrap flow. Keep this here for now, but
# avoid using it in new flows until we consciously refactor it for Sheets.


@router.post("/mark-sets", response_model=MarkSetOut, status_code=201)
async def create_mark_set(
    mark_set: MarkSetCreate,
    storage: Annotated[StorageAdapter, Depends(get_storage)],
):
    """
    Create a new mark set with all its marks.

    NOTE: This is legacy and may not work with the SheetsAdapter as-is.
    Prefer the document/bootstrap flow for creating mark sets.
    """
    logger.info(f"Creating mark set: {mark_set.name}")

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
            mark_data["nh"],
        )
        # Coerce anchor to valid value
        mark_data["anchor"] = coerce_anchor(mark_data.get("anchor"))

    # ---- LEGACY: this assumes a method that doesn't exist on SheetsAdapter ----
    # Kept only to avoid breaking any existing callers.
    if not hasattr(storage, "get_or_create_document"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Legacy mark-set creation is not supported with Sheets backend",
        )

    doc_id = storage.get_or_create_document(cleaned_url)

    # Also assumes a different create_mark_set signature
    mark_set_id = storage.create_mark_set(
        doc_id=doc_id,
        name=mark_set.name,
    )

    logger.info(f"Created mark set with ID: {mark_set_id}")

    return MarkSetOut(id=mark_set_id)


# ---------- Marks listing ----------


@router.get("/mark-sets/{mark_set_id}/marks", response_model=List[MarkOut])
async def list_marks(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends(get_storage)],
):
    """
    Get all marks in a mark set, ordered by navigation sequence.
    """
    logger.info(f"Fetching marks for set {mark_set_id}")

    # SheetsAdapter exposes list_marks / get_marks; fall back gracefully
    if hasattr(storage, "list_marks"):
        marks = storage.list_marks(mark_set_id)
    elif hasattr(storage, "get_marks"):
        marks = storage.get_marks(mark_set_id)
    else:
        raise HTTPException(
            status_code=501,
            detail="Marks listing not supported by this backend",
        )

    logger.info(f"Fetched {len(marks)} marks for set {mark_set_id}")
    return marks


# ---------- Master-only: replace all marks for a mark set ----------


@router.put("/mark-sets/{mark_set_id}/marks", status_code=200)
async def update_marks(
    mark_set_id: str,
    marks: List[MarkOut],
    storage: Annotated[StorageAdapter, Depends(get_storage)],
    user_mail: str = Query(
        ...,
        min_length=3,
        description="Email of user performing the update (must be allowed to edit master)",
    ),
):
    """
    Replace all marks in a mark set.

    For Sheets backend this rewrites all rows in the `marks` tab
    for the given mark_set_id.

    PERMISSIONS:
    - Only allowed if mark_set.is_master == TRUE AND
      user_mail is allowed by documents.master_editors.
    """
    if not hasattr(storage, "update_marks"):
        raise HTTPException(
            status_code=501,
            detail="Marks update not supported by this backend",
        )

    # Load mark_set + document and enforce master permissions
    ms_row, doc = _load_markset_and_doc(storage, mark_set_id)
    is_master = _bool(ms_row.get("is_master"))
    if not is_master:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="ONLY_MASTER_MARKSET_CAN_UPDATE_MARKS",
        )

    if not _user_can_edit_master(doc, user_mail):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="USER_NOT_ALLOWED_TO_EDIT_MASTER_MARKSET",
        )

    logger.info(f"Updating {len(marks)} marks for set {mark_set_id} by {user_mail}")

    marks_data = [mark.model_dump() for mark in marks]

    # Validate unique order_index
    ensure_unique_order_index(marks_data)

    # Validate each mark's coordinates
    for mark_data in marks_data:
        validate_normalized_rect(
            mark_data["nx"],
            mark_data["ny"],
            mark_data["nw"],
            mark_data["nh"],
        )

    try:
        storage.update_marks(mark_set_id, marks_data)
    except ValueError as e:
        if "MARK_SET_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))

    return {"status": "ok", "message": f"Updated {len(marks)} marks"}


# ---------- Master-only: patch a single mark (instrument / required) ----------


@router.patch("/marks/{mark_id}", response_model=MarkOut)
async def patch_mark(
    mark_id: str,
    patch: MarkPatch,
    storage: Annotated[StorageAdapter, Depends(get_storage)],
    user_mail: str = Query(
        ...,
        min_length=3,
        description="Email of user performing the update (must be allowed to edit master)",
    ),
):
    """
    Update mutable fields for a mark (like instrument, is_required).

    PERMISSIONS:
    - Only allowed if the owning mark_set is MASTER AND
      user_mail is allowed by documents.master_editors.
    """
    if not hasattr(storage, "_get_all_dicts"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Mark patching only supported with Sheets backend",
        )

    # Find the mark row to resolve its mark_set_id
    rows = storage._get_all_dicts("marks")
    mark_row = next((m for m in rows if m.get("mark_id") == mark_id), None)
    if not mark_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MARK_NOT_FOUND")

    mark_set_id = mark_row.get("mark_set_id")
    if not mark_set_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="MARK_HAS_NO_MARK_SET_ID",
        )

    # Load mark_set + doc and enforce master permissions
    ms_row, doc = _load_markset_and_doc(storage, mark_set_id)
    is_master = _bool(ms_row.get("is_master"))
    if not is_master:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="ONLY_MASTER_MARKSET_CAN_PATCH_MARKS",
        )

    if not _user_can_edit_master(doc, user_mail):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="USER_NOT_ALLOWED_TO_EDIT_MASTER_MARKSET",
        )

    updated_mark = storage.patch_mark(mark_id, patch.model_dump(exclude_unset=True))
    return updated_mark


@router.post("/mark-sets/{mark_set_id}/activate", status_code=200)
async def activate_mark_set(
    mark_set_id: str,
    storage: Annotated[StorageAdapter, Depends(get_storage)],
):
    """
    Activate a mark set for its document.

    Only one mark set per document can be active at a time.
    This deactivates all other mark sets for the same document
    and activates the specified one.
    """
    storage.activate_mark_set(mark_set_id)
    return {"status": "ok", "message": "Mark set activated"}
