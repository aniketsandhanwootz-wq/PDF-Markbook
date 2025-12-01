from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, Body
from pydantic import BaseModel, Field
from typing import Annotated, Optional, Dict
from datetime import datetime
import httpx
import logging

from core.report_pdf import generate_report_pdf

# Set up logger
logger = logging.getLogger(__name__)

# DI
def get_storage():
    # pulls the global adapter from main.py
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())

router = APIRouter(prefix="/reports", tags=["reports"])

class ReportBundleLegacyBody(BaseModel):
    """
    Legacy body used by the Viewer to call /reports/generate-bundle.

    This is a thin compatibility wrapper around the new Excel-only
    /reports/bundle/generate endpoint.
    """
    mark_set_id: str = Field(..., min_length=8)
    entries: Dict[str, str] = {}           # mark_id -> value
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None
    padding_pct: float = 0.25
    office_variant: Optional[str] = None   # ignored here; kept for backward compat

    # 🔴 NEW: viewer metadata
    report_title: Optional[str] = None     # human-readable title from ReportTitlePanel
    report_id: Optional[str] = None        # unique QC submission ID from viewer



@router.post("/generate-bundle")
async def generate_bundle_legacy(
    body: Annotated[ReportBundleLegacyBody, Body(...)],
    request: Request,
    background_tasks: BackgroundTasks,
    storage = Depends(get_storage),
):
    """
    Backwards compatible wrapper for the old /reports/generate-bundle.

    Behaviour:
    - Saves entries to mark_user_input (if supported by storage).
    - Resolves doc_id for the given mark_set_id.
    - If user_email is present, internally calls the new
      /reports/bundle/generate endpoint to queue Excel-only email.
    - Returns a small JSON that the Viewer expects (email_status, etc.).
    """

    try:
        # 1) Persist entries (best-effort), same style as /reports/generate
        if body.entries:
            try:
                if hasattr(storage, "create_user_inputs_batch"):
                    storage.create_user_inputs_batch(
                        mark_set_id=body.mark_set_id,
                        entries=body.entries,
                        submitted_by=(body.user_email or "viewer_user"),
                        # 🔴 NEW: forward viewer's report_id into Sheets
                        report_id=body.report_id,
                    )
            except Exception as e:
                logger.warning(f"Failed to persist user inputs: {e}")
                # do not fail the request just because audit/write failed

        # 2) Resolve mark_set -> doc_id from Sheets (mark_sets tab)
        try:
            ms_all = storage._get_all_dicts("mark_sets")
        except AttributeError as e:
            logger.error(f"Storage adapter missing _get_all_dicts method: {e}")
            raise HTTPException(
                status_code=500, 
                detail="Storage adapter configuration error"
            )
        except Exception as e:
            logger.error(f"Failed to read mark_sets: {e}")
            raise HTTPException(
                status_code=500, 
                detail=f"Failed to read mark_sets: {str(e)}"
            )

        ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
        if not ms:
            raise HTTPException(
                status_code=404, 
                detail=f"MARK_SET_NOT_FOUND: {body.mark_set_id}"
            )

        doc_id = ms.get("doc_id")
        if not doc_id:
            raise HTTPException(
                status_code=400, 
                detail="DOC_ID_NOT_SET_FOR_MARK_SET"
            )

        # 3) If no email was provided, just return success without queuing mail
        if not body.user_email:
            return {
                "status": "ok",
                "email_status": "no_email",
                "message": "Entries saved, but no email was provided.",
            }

        # 4) Call the new Excel-only endpoint internally:
        #    POST /reports/bundle/generate
        base_url = str(request.base_url).rstrip("/")
        bundle_url = f"{base_url}/reports/bundle/generate"

        payload = {
            "doc_id": str(doc_id),
            "mark_set_id": body.mark_set_id,
            "email_to": body.user_email,
            "submitted_by": body.user_email,
            # 🔴 NEW: use viewer's title/id in the new bundle endpoint
            "report_name": body.report_title,
            "report_id": body.report_id,
        }


        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(bundle_url, json=payload)
        except httpx.TimeoutException as e:
            logger.error(f"Timeout calling bundle endpoint: {e}")
            raise HTTPException(
                status_code=504, 
                detail="Request to report bundle service timed out"
            )
        except httpx.RequestError as e:
            logger.error(f"Failed to queue report bundle: {e}")
            raise HTTPException(
                status_code=502, 
                detail=f"Failed to queue report bundle: {str(e)}"
            )

        if resp.status_code >= 400:
            logger.error(f"Bundle endpoint returned error: {resp.status_code} - {resp.text}")
            raise HTTPException(
                status_code=resp.status_code, 
                detail=f"Report bundle service error: {resp.text}"
            )

        return {
            "status": "queued",
            "email_status": "queued",
            "message": "Report bundle generation has been queued (Excel-only).",
        }

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.exception(f"Unexpected error in generate_bundle_legacy: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )


@router.get("/{mark_set_id}")
async def list_reports(mark_set_id: str, storage = Depends(get_storage)):
    """List persisted report records for a mark set."""
    try:
        if not hasattr(storage, "list_reports"):
            raise HTTPException(
                status_code=501,
                detail="list_reports not implemented for this storage backend"
            )
        return storage.list_reports(mark_set_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to list reports for mark_set {mark_set_id}: {e}")
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to list reports: {str(e)}"
        )


class ReportGenerateBody(BaseModel):
    mark_set_id: str
    entries: Dict[str, str] = {}
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None
    padding_pct: float = 0.25
    title: Optional[str] = None
    author: Optional[str] = None


@router.post("/generate")
async def generate_report(body: ReportGenerateBody, storage = Depends(get_storage)):
    """
    Alias of: /mark-sets/{mark_set_id}/submissions/report

    Behaviour:
    - If 'entries' is provided: save them to mark_user_input (Sheets) and render report.
    - If 'entries' is empty: render using latest saved inputs (your existing behaviour).
    - pdf_url can be provided; otherwise it is resolved from the mark_set -> document.
    """
    try:
        # 1) Resolve mark set + document/pdf_url
        try:
            ms_all = storage._get_all_dicts("mark_sets")
        except AttributeError as e:
            logger.error(f"Storage adapter missing _get_all_dicts method: {e}")
            raise HTTPException(
                status_code=500,
                detail="Storage adapter configuration error"
            )
        except Exception as e:
            logger.error(f"Failed to read mark_sets: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to read mark_sets: {str(e)}"
            )

        ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
        if not ms:
            raise HTTPException(
                status_code=404, 
                detail=f"MARK_SET_NOT_FOUND: {body.mark_set_id}"
            )

        doc_id = ms.get("doc_id")
        if not doc_id:
            raise HTTPException(
                status_code=400,
                detail="DOC_ID_NOT_SET_FOR_MARK_SET"
            )

        try:
            doc = storage.get_document(doc_id)
        except Exception as e:
            logger.error(f"Failed to get document {doc_id}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to retrieve document: {str(e)}"
            )

        if not doc:
            raise HTTPException(
                status_code=404, 
                detail=f"DOCUMENT_NOT_FOUND: {doc_id}"
            )

        pdf_url = body.pdf_url or doc.get("pdf_url")
        if not pdf_url:
            raise HTTPException(
                status_code=400, 
                detail="pdf_url not found or resolvable"
            )

        # 2) Fetch marks
        try:
            marks = storage.list_marks(body.mark_set_id)
        except Exception as e:
            logger.error(f"Failed to list marks for {body.mark_set_id}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to retrieve marks: {str(e)}"
            )

        # 3) Decide which entries to render with
        entries: Dict[str, str]
        if body.entries:
            # Viewer is sending fresh values → (a) persist them (Sheets) then (b) use them
            try:
                if hasattr(storage, "create_user_inputs_batch"):
                    storage.create_user_inputs_batch(
                        mark_set_id=body.mark_set_id,
                        entries=body.entries,
                        submitted_by=(body.user_email or "viewer_user"),
                    )
            except Exception as e:
                logger.warning(f"Failed to persist user inputs: {e}")
                # do not fail report just because audit write failed
            entries = body.entries
        else:
            # No entries sent → fall back to latest saved inputs (your previous behaviour)
            try:
                rows = storage.get_user_inputs(body.mark_set_id, submitted_by=body.user_email)
            except Exception as e:
                logger.warning(f"Failed to get user inputs, using empty entries: {e}")
                rows = []

            latest: Dict[str, Dict] = {}
            for r in rows:
                try:
                    mid = r.get("mark_id")
                    ts = r.get("submitted_at") or ""
                    if not mid:
                        continue
                    prev = latest.get(mid)
                    if not prev or (ts > prev.get("submitted_at", "")):
                        latest[mid] = r
                except Exception as e:
                    logger.warning(f"Error processing user input row: {e}")
                    continue

            entries = {mid: r.get("user_value", "") for mid, r in latest.items()}

        # 4) Generate report PDF
        try:
            pdf_bytes = await generate_report_pdf(
                pdf_url=pdf_url,
                marks=marks,
                entries=entries,
                padding_pct=body.padding_pct,
                render_zoom=2.0,
                title=body.title,
                author=body.author or (body.user_email or "Viewer"),
            )
        except Exception as e:
            logger.exception(f"Report generation failed: {e}")
            raise HTTPException(
                status_code=500, 
                detail=f"Report generation failed: {str(e)}"
            )

        # 5) (Optional) persist a history record (URL placeholder for now)
        try:
            if hasattr(storage, "create_report_record"):
                storage.create_report_record(
                    mark_set_id=body.mark_set_id,
                    inspection_doc_url="",   # replace with uploaded URL if you later store the PDF
                    created_by=body.user_email or body.author or "",
                    # no explicit report_id here -> SheetsAdapter will generate one
                    report_title=body.title,
                    submitted_by=body.user_email or body.author or "",
                )
        except Exception as e:
            logger.warning(f"Failed to create report record: {e}")
            # Don't fail the request


        from fastapi.responses import StreamingResponse
        import io
        fname = f"inspection_{body.mark_set_id}.pdf"
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'}
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Unexpected error in generate_report: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )