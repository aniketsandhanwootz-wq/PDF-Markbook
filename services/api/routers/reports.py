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
    # NEW: allow Viewer to send values directly (fresh run, no prefill)
    entries: Dict[str, str] = {}          # mark_id -> value
    # Optional helpers
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None      # who is submitting (for audit)
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
    Alias of: /mark-sets/{mark_set_id}/submissions/report

    Behaviour:
    - If 'entries' is provided: save them to mark_user_input (Sheets) and render report.
    - If 'entries' is empty: render using latest saved inputs (your existing behaviour).
    - pdf_url can be provided; otherwise it is resolved from the mark_set -> document.
    """
    # 1) Resolve mark set + document/pdf_url
    ms_all = storage._get_all_dicts("mark_sets")
    ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
    if not ms:
        raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

    doc = storage.get_document(ms["doc_id"])
    if not doc:
        raise HTTPException(status_code=400, detail="DOCUMENT_NOT_FOUND")

    pdf_url = body.pdf_url or doc.get("pdf_url")
    if not pdf_url:
        raise HTTPException(status_code=400, detail="pdf_url not found or resolvable")

    # 2) Fetch marks
    marks = storage.list_marks(body.mark_set_id)  # raw dicts OK for generator

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
        except Exception:
            # do not fail report just because audit write failed
            pass
        entries = body.entries
    else:
        # No entries sent → fall back to latest saved inputs (your previous behaviour)
        rows = storage.get_user_inputs(body.mark_set_id, submitted_by=body.user_email)
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
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    # 5) (Optional) persist a history record (URL placeholder for now)
    try:
        storage.create_report_record(
            mark_set_id=body.mark_set_id,
            inspection_doc_url="",   # replace with uploaded URL if you later store the PDF
            created_by=body.user_email or body.author or "",
        )
    except Exception:
        pass

    from fastapi.responses import StreamingResponse
    import io
    fname = f"inspection_{body.mark_set_id}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'}
    )
