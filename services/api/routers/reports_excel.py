# services/api/routers/reports_excel.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Dict, Optional
from fastapi.responses import StreamingResponse
import io

from core.report_excel import generate_report_excel


def get_storage():
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())


router = APIRouter(prefix="/reports-excel", tags=["reports-excel"])


class ExcelReportBody(BaseModel):
    mark_set_id: str = Field(..., min_length=8)
    entries: Dict[str, str] = {}
    pdf_url: Optional[str] = None
    user_email: Optional[str] = None
    padding_pct: float = 0.25


@router.post("/generate")
async def generate_excel_report(body: ExcelReportBody, storage=Depends(get_storage)):
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

    # Generate .xlsm (macro-enabled)
    excel_bytes = await generate_report_excel(
        pdf_url=pdf_url,
        marks=marks,
        entries=entries,
        user_email=body.user_email,
        mark_set_id=body.mark_set_id,
        mark_set_label=ms.get("label", ""),
        part_number=doc.get("part_number", ""),
        padding_pct=body.padding_pct,
    )

    fname = f"inspection_{body.mark_set_id}.xlsm"
    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.ms-excel.sheet.macroEnabled.12",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'}
    )
