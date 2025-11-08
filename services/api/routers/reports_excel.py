# services/api/routers/reports_excel.py
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Dict, Optional
from fastapi.responses import StreamingResponse
import io

# Import Excel generation logic
from core.report_excel import generate_report_excel

# Dependency Injection helper
def get_storage():
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())

# Router instance (top-level)
router = APIRouter(prefix="/reports-excel", tags=["reports-excel"])

class ExcelReportBody(BaseModel):
    mark_set_id: str = Field(..., min_length=8)
    entries: Dict[str, str] = {}
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None
    padding_pct: float = 0.25

@router.post("/generate")
async def generate_excel_report(body: ExcelReportBody, storage = Depends(get_storage)):
    """
    Generate Excel report from marks and entries.
    """
    # 1) Resolve mark set and document
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

    # 2) Fetch marks and entries
    marks = storage.list_marks(body.mark_set_id)
    entries = body.entries or {}

    # 3) Build workbook bytes
    try:
        excel_bytes = await generate_report_excel(
            pdf_url=pdf_url,
            marks=marks,
            entries=entries,
            user_email=body.user_email or "viewer_user",
            mark_set_id=body.mark_set_id,
            padding_pct=body.padding_pct,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Excel generation failed: {e}")

    # 4) Stream back
    fname = f"inspection_{body.mark_set_id}.xlsx"
    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename=\"{fname}\"'}
    )
