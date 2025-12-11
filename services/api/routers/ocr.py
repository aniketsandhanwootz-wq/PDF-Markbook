# services/api/routers/ocr.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from typing import Annotated, Dict, Any, Optional
import re
import urllib.parse
from logging import getLogger

from adapters.base import StorageAdapter
from schemas.mark import RequiredValueOCRRequest, RequiredValueOCRResponse
from core.vision_ocr import extract_required_value_from_pdf_region

logger = getLogger(__name__)

router = APIRouter(prefix="/ocr", tags=["ocr"])


def get_storage() -> StorageAdapter:
    """Dependency to get storage adapter from app state."""
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())



def _clean_pdf_url(url: str) -> str:
    """
    Extract direct GCS URL from nested Cloudinary URLs (same logic
    as marks.clean_pdf_url, duplicated here to avoid circular import).
    """
    if not url or "cloudinary.com" not in url:
        return url

    decoded = url
    try:
        for _ in range(5):
            prev = decoded
            decoded = urllib.parse.unquote(decoded)
            if decoded == prev:
                break
    except Exception:
        decoded = url

    match = re.search(
        r"https://storage\.googleapis\.com/[^\s\"'<>)]*\.pdf",
        decoded,
        re.IGNORECASE,
    )
    if match:
        return match.group(0).replace(" ", "%20")

    return url


def _resolve_doc_for_mark_set(storage: StorageAdapter, mark_set_id: str) -> Dict[str, Any]:
    """
    Resolve (mark_set_row, document_row) for a given mark_set_id using Sheets.
    """
    if not hasattr(storage, "_get_all_dicts"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="OCR resolution only supported with the Google Sheets backend",
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

    return doc


@router.post("/required-value", response_model=RequiredValueOCRResponse)
async def ocr_required_value(
    payload: RequiredValueOCRRequest,
    storage: Annotated[StorageAdapter, Depends(get_storage)],
):
    """
    Run OCR for a single mark region.

    IMPORTANT:
    - This DOES NOT persist anything to Sheets.
    - It only returns { required_value_ocr, required_value_conf }.
    - The editor will store these fields in mark state and later send them
      along with the full marks payload when saving.
    """
    try:
        doc = _resolve_doc_for_mark_set(storage, payload.mark_set_id)
        pdf_url_raw = doc.get("pdf_url") or ""
        pdf_url = _clean_pdf_url(pdf_url_raw)

        if not pdf_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="DOCUMENT_HAS_NO_PDF_URL",
            )

        value, conf = extract_required_value_from_pdf_region(
            pdf_url=pdf_url,
            page_index=payload.page_index,
            nx=payload.nx,
            ny=payload.ny,
            nw=payload.nw,
            nh=payload.nh,
        )

        logger.info(
            "[OCR] mark_set_id=%s page_index=%s bbox=(%.4f,%.4f,%.4f,%.4f) -> value=%s conf=%.1f",
            payload.mark_set_id,
            payload.page_index,
            payload.nx,
            payload.ny,
            payload.nw,
            payload.nh,
            value,
            conf,
        )

        # Always return a float (0.0 on failure)
        return RequiredValueOCRResponse(
            required_value_ocr=value,
            required_value_conf=conf if conf is not None else 0.0,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[OCR] Failed to run required-value OCR: {e}")
        # Graceful fallback: no value, 0 confidence
        return RequiredValueOCRResponse(required_value_ocr=None, required_value_conf=0.0)
