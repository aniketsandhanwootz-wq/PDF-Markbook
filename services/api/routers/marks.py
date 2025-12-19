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

def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        s = str(v).strip()
        if not s:
            return default
        return int(float(s))
    except Exception:
        return default


def _bump_content_rev(storage: StorageAdapter, mark_set_id: str, updated_by: str | None) -> int | None:
    """
    Increments mark_sets.content_rev by 1 and sets content_updated_at + updated_by.
    Best-effort: if backend is not Sheets or columns missing, it silently does nothing.
    """
    if not hasattr(storage, "_find_row_by_value") or not hasattr(storage, "_update_cells"):
        return None

    row_idx = storage._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
    if not row_idx:
        return None

    # read current row (prefer fast helper if present)
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

    # Prefer adapter helper if available (faster, less sheet scanning)
    if hasattr(storage, "get_mark_set_row"):
        target = storage.get_mark_set_row(mark_set_id)
    else:
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

def _normalize_instrument(val: Any) -> Optional[str]:
    """
    Treat None, empty string and whitespace-only strings as the same (None).
    Also trims normal strings.
    """
    if val is None:
        return None
    if not isinstance(val, str):
        val = str(val)
    trimmed = val.strip()
    return trimmed or None


def _normalize_bool(val: Any) -> Optional[bool]:
    """
    Normalize various truthy/falsey representations from Sheets / API.

    Returns:
      - True / False when it can clearly decide
      - None when value is empty / unknown
    """
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)

    if isinstance(val, str):
        cleaned = val.strip().lower()
        if not cleaned:
            return None
        if cleaned in {"true", "yes", "y", "1"}:
            return True
        if cleaned in {"false", "no", "n", "0"}:
            return False

    # Fallback: Python truthiness
    return bool(val)

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
    Replace or extend marks in a MASTER mark set.

    Behaviour:
    - If caller is a master editor (documents.master_editors contains user_mail):
        → full rewrite allowed (add/move/delete marks).
    - If caller is NOT a master editor (QC flow):
        → append-only:
           * existing MASTER marks cannot be changed or deleted
           * request may contain copies of existing marks – those are ignored
           * only new marks (no existing mark_id) are appended at the end
    """
    if not hasattr(storage, "update_marks"):
        raise HTTPException(
            status_code=501,
            detail="Marks update not supported by this backend",
        )

    # --- 1) Load mark_set + document and enforce 'must be MASTER' ---
    ms_row, doc = _load_markset_and_doc(storage, mark_set_id)
    is_master = _bool(ms_row.get("is_master"))
    if not is_master:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="ONLY_MASTER_MARKSET_CAN_UPDATE_MARKS",
        )

    can_full_edit = _user_can_edit_master(doc, user_mail)

    # Always need current master marks
    if hasattr(storage, "list_marks"):
        existing_marks = storage.list_marks(mark_set_id)
    elif hasattr(storage, "get_marks"):
        existing_marks = storage.get_marks(mark_set_id)
    else:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Marks listing not supported by this backend",
        )

    marks_data = [mark.model_dump(exclude_unset=True) for mark in marks]

    if marks_data:
        sample = marks_data[0]
        logger.info(
            "[PUT marks] sample required_value_ocr=%r conf=%r final=%r keys=%s",
            sample.get("required_value_ocr"),
            sample.get("required_value_conf"),
            sample.get("required_value_final"),
            list(sample.keys()),
        )


    # ---------- MASTER EDITOR FLOW: full rewrite ----------
    if can_full_edit:
        ensure_unique_order_index(marks_data)
        for m in marks_data:
            validate_normalized_rect(m["nx"], m["ny"], m["nw"], m["nh"])

        logger.info(
            f"[MASTER EDIT] Updating {len(marks_data)} marks for set {mark_set_id} by {user_mail}"
        )
        try:
            storage.update_marks(mark_set_id, marks_data)
            _bump_content_rev(storage, mark_set_id, user_mail)
        except ValueError as e:
            if "MARK_SET_NOT_FOUND" in str(e):
                raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")
            raise HTTPException(status_code=400, detail=str(e))

        return {"status": "ok", "message": f"Updated {len(marks_data)} marks"}

    # ---------- QC FLOW: append-only into MASTER ----------
    # Map existing mark_ids for quick lookup
    existing_ids = {
        (m.get("mark_id") or "").strip()
        for m in existing_marks
        if (m.get("mark_id") or "").strip()
    }

    # Direct map: mark_id -> existing master mark row (raw / as stored)
    existing_by_id: dict[str, dict[str, Any]] = {
        (m.get("mark_id") or "").strip(): m
        for m in existing_marks
        if (m.get("mark_id") or "").strip()
    }

    # For QC:
    #   - existing marks: allow updating instrument / is_required ONLY
    #   - new marks: append at the end
    merged_existing: dict[str, dict[str, Any]] = {}
    new_marks: list[dict[str, Any]] = []

    for m in marks_data:
        mid = (m.get("mark_id") or "").strip()

        if mid and mid in existing_ids:
            # Existing master mark -> merge instrument / is_required / required_value_* only
            orig = existing_by_id[mid]

            # --- normalize original values ---
            orig_instr = _normalize_instrument(orig.get("instrument"))
            orig_req = _normalize_bool(orig.get("is_required"))

            # required values stored as strings in Sheets; treat "" as empty
            orig_rvo = (orig.get("required_value_ocr") or "").strip()
            orig_rvc = "" if orig.get("required_value_conf") is None else str(orig.get("required_value_conf")).strip()
            orig_rvf = (orig.get("required_value_final") or "").strip()

            # start from original normalized values
            new_instr = orig_instr
            new_req = orig_req
            new_rvo = orig_rvo
            new_rvc = orig_rvc
            new_rvf = orig_rvf

            # --- instrument update semantics ---
            if "instrument" in m:
                instr = m.get("instrument")
                new_instr = _normalize_instrument(instr)

            # --- is_required update semantics ---
            if "is_required" in m:
                req_val = m.get("is_required")
                if req_val is not None:
                    new_req = _normalize_bool(req_val)

            # --- required value OCR (string) ---
            if "required_value_ocr" in m:
                new_rvo = (m.get("required_value_ocr") or "").strip()

            # --- required value conf (store as string, SheetsAdapter will not care) ---
            if "required_value_conf" in m and m.get("required_value_conf") is not None:
                new_rvc = str(m["required_value_conf"])

            # --- required value final (string) ---
            if "required_value_final" in m:
                new_rvf = (m.get("required_value_final") or "").strip()

            # detect changes
            instrument_changed = new_instr != orig_instr
            req_changed = new_req != orig_req
            rvo_changed = new_rvo != orig_rvo
            rvc_changed = new_rvc != orig_rvc
            rvf_changed = new_rvf != orig_rvf

            if instrument_changed or req_changed or rvo_changed or rvc_changed or rvf_changed:
                updated = dict(orig)
                updated["instrument"] = new_instr
                updated["is_required"] = new_req
                updated["required_value_ocr"] = new_rvo
                updated["required_value_conf"] = new_rvc
                updated["required_value_final"] = new_rvf
                merged_existing[mid] = updated
        else:
            # Mark without an existing master ID -> treat as NEW
            new_marks.append(m)


    # Determine current max order_index in master (for NEW marks only)
    if existing_marks:
        max_order = max(int(m.get("order_index", 0)) for m in existing_marks)
    else:
        max_order = -1

    # Validate and assign order_index for NEW marks only
    for nm in new_marks:
        validate_normalized_rect(nm["nx"], nm["ny"], nm["nw"], nm["nh"])
        max_order += 1
        nm["order_index"] = max_order
        # Force backend to generate new IDs; don't reuse any client-provided id
        nm["mark_id"] = (nm.get("mark_id") or "").strip() or None

    # Rebuild the existing part, applying merged instrument/is_required
    combined_existing: list[dict[str, Any]] = []
    for ex in existing_marks:
        mid = (ex.get("mark_id") or "").strip()
        if mid and mid in merged_existing:
            combined_existing.append(merged_existing[mid])
        else:
            combined_existing.append(ex)

    combined = combined_existing + new_marks
    ensure_unique_order_index(combined)

    logger.info(
        f"[QC APPEND] Appending {len(new_marks)} new marks and updating "
        f"{len(merged_existing)} existing marks in master set {mark_set_id} by {user_mail}"
    )

    try:
        storage.update_marks(mark_set_id, combined)
        _bump_content_rev(storage, mark_set_id, user_mail)
    except ValueError as e:
        if "MARK_SET_NOT_FOUND" in str(e):
            raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "status": "ok",
        "message": (
            f"Appended {len(new_marks)} new marks and "
            f"updated {len(merged_existing)} existing marks in master"
        ),
    }

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
    _bump_content_rev(storage, mark_set_id, user_mail)
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
