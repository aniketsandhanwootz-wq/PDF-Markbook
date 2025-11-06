from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Annotated, Optional, Dict
from datetime import datetime

from core.report_pdf import generate_report_pdf

# DI
def get_storage():
    # pulls the global adapter from main.py
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())

router = APIRouter(prefix="/reports", tags=["reports"])

class ReportGenerateBody(BaseModel):
    mark_set_id: str = Field(..., min_length=8)
    user_email: Optional[str] = None      # if provided: report for that user’s inputs
    padding_pct: float = 0.25
    title: str = "Inspection Report"
    author: str = "PDF Viewer"

@router.get("/{mark_set_id}")
async def list_reports(mark_set_id: str, storage = Depends(get_storage)):
    """List persisted report records for a mark set."""
    try:
        return storage.list_reports(mark_set_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list reports: {e}")

@router.post("/generate")
async def generate_report(body: ReportGenerateBody, storage = Depends(get_storage)):
    """
    Build a PDF report on the server, using saved user inputs.
    Returns the PDF bytes as a StreamingResponse and persists a history record.
    """
    # 1) Resolve doc/pdf_url for this mark_set
    ms_all = storage._get_all_dicts("mark_sets")
    ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
    if not ms:
        raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

    doc = storage.get_document(ms["doc_id"])
    if not doc or not doc.get("pdf_url"):
        raise HTTPException(status_code=400, detail="Document or pdf_url not found for this mark set")

    pdf_url = doc["pdf_url"]

    # 2) Fetch marks
    marks = storage.list_marks(body.mark_set_id)  # raw dicts are fine for generator

    # 3) Fetch inputs (for a user or all)
    rows = storage.get_user_inputs(body.mark_set_id, submitted_by=body.user_email)
    # choose latest value per mark_id by submitted_at (ISO)
    latest: Dict[str, Dict] = {}
    for r in rows:
        mid = r.get("mark_id")
        ts = r.get("submitted_at") or ""
        if not mid:
            continue
        prev = latest.get(mid)
        if not prev or (ts > prev.get("submitted_at", "")):
            latest[mid] = r
    entries = {mid: r.get("user_value", "") for mid, r in latest.items()}

    # 4) Generate PDF
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
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    # 5) Persist a history row (URL can be filled later if you upload to storage)
    try:
        # If you later upload pdf_bytes to GCS/S3, replace "" with the file URL.
        storage.create_report_record(
            mark_set_id=body.mark_set_id,
            inspection_doc_url="",   # TODO: fill with uploaded URL if you store it
            created_by=body.user_email or body.author or "",
        )
    except Exception:
        # do not fail the request if history write fails
        pass

    from fastapi.responses import StreamingResponse
    import io
    fname = f"inspection_{body.mark_set_id}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'}
    )
