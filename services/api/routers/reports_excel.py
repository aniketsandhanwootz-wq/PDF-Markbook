# services/api/routers/reports_excel.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Dict, Optional
from fastapi.responses import StreamingResponse
import io
import logging

from core.report_excel import generate_report_excel
from settings import get_settings
logger = logging.getLogger(__name__)


def get_storage():
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())

router = APIRouter(prefix="/reports-excel", tags=["reports-excel"])

class ExcelReportBody(BaseModel):
    mark_set_id: str = Field(..., min_length=8)
    entries: Dict[str, str] = {}
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None
    report_title: Optional[str] = None
    padding_pct: float = 0.25
    logo_url: Optional[str] = None  # allow override if needed

    # ✅ NEW: per-mark statuses (PASS/FAIL/DOUBT/"")
    statuses: Dict[str, str] = {}

@router.post("/generate")
async def generate_excel_report(body: ExcelReportBody, storage = Depends(get_storage)):
    # Resolve mark set and document
    ms_all = storage._get_all_dicts("mark_sets")
    ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
    if not ms:
        raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

    doc = storage.get_document(ms["doc_id"])
    if not doc:
        raise HTTPException(status_code=400, detail="DOCUMENT_NOT_FOUND")

    pdf_url = body.pdf_url or doc.get("pdf_url")
    if not pdf_url:
        raise HTTPException(status_code=400, detail="Missing pdf_url")

    marks = storage.list_marks(body.mark_set_id)
    entries = body.entries or {}

    # Enforce global cap on number of marks per report
    settings = get_settings()
    max_marks = getattr(settings, "max_marks_per_report", 300)
    if len(marks) > max_marks:
        logger.warning(
            f"Trimming marks for /reports-excel/generate: {len(marks)} → {max_marks} "
            f"(max_marks_per_report)"
        )
        marks = marks[:max_marks]

    try:
        excel_bytes = await generate_report_excel(
            pdf_url=pdf_url,
            marks=marks,
            entries=entries,
            user_email=body.user_email,
            mark_set_id=body.mark_set_id,
            mark_set_label=ms.get("name", "") or ms.get("label", ""),
            part_number=doc.get("part_number", "") or "",
            external_id=doc.get("external_id", "") or "",
            report_title=body.report_title or "",
            padding_pct=body.padding_pct,
            logo_url=body.logo_url or "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
            # ✅ NEW
            statuses=body.statuses,        
            )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"EXCEL_BUILD_FAILED: {e}")

    fname = f"submission_{body.mark_set_id}.xlsx"
    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'}
    )
