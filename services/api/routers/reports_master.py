# services/api/routers/reports_master.py
"""
Master Report Router

Generates horizontal master inspection reports showing all marks × all runs.
"""

from __future__ import annotations

import logging
from typing import Optional
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.master_report_excel import generate_master_report_excel, MasterReportRun

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reports/master", tags=["reports-master"])


# ========== DI ==========
def get_storage():
    from main import get_storage_adapter, get_settings
    return get_storage_adapter(get_settings())


# ========== Schemas ==========
class MasterReportRequest(BaseModel):
    """Request body for master report generation"""
    project_name: str = Field(..., min_length=1)
    id: str = Field(..., min_length=1, description="Business ID (external_id)")
    part_number: str = Field(..., min_length=1)
    dwg_num: Optional[str] = Field(
        default=None,
        description="Drawing number (dwg_num) for this PDF; if omitted, legacy 3-part key is used",
    )
    report_title: Optional[str] = Field(None, description="Optional report title")
    max_runs: int = Field(100, ge=1, le=200, description="Max inspection runs to include")



# ========== Helpers ==========

def _find_master_mark_set_id(mark_sets: list[dict]) -> Optional[str]:
    """Find the master mark set ID from list of mark sets"""
    for ms in mark_sets:
        is_master = (ms.get("is_master") or "").strip().upper() == "TRUE"
        if is_master:
            return ms.get("mark_set_id")
    return None


def _build_master_child_map(storage, master_marks: list[dict]) -> dict[str, str]:
    """
    Build mapping from child mark_id -> master mark_id.
    
    Uses the `master_mark_id` field that should exist on QC marks.
    If not present, falls back to label-based matching.
    """
    # For now, assume mark_id IS the master_mark_id (simplest case)
    # If you have a separate `master_mark_id` column on QC marks, adjust logic here
    return {m.get("mark_id"): m.get("mark_id") for m in master_marks}


async def _fetch_runs_for_document(
    storage,
    doc_id: str,
    master_child_map: dict[str, str],
    max_runs: int,
) -> list[MasterReportRun]:
    """
    Fetch all inspection runs (QC marksets) for a document.
    
    Returns list of MasterReportRun objects with values mapped to master mark IDs.
    """
    # 1) Get all mark sets for this document
    mark_sets = storage.list_mark_sets_by_document(doc_id)
    
    # Filter to non-master marksets only
    qc_mark_sets = [
        ms for ms in mark_sets
        if (ms.get("is_master") or "").strip().upper() != "TRUE"
    ]
    
    if not qc_mark_sets:
        return []
    
    # Cap to max_runs
    qc_mark_sets = qc_mark_sets[:max_runs]
    
    runs: list[MasterReportRun] = []
    
    for ms in qc_mark_sets:
        mark_set_id = ms.get("mark_set_id")
        mark_set_name = ms.get("name", "") or ms.get("label", "")
        
        # 2) Find latest report for this markset
        try:
            reports = storage.list_reports(mark_set_id)
        except Exception as e:
            logger.warning(f"Failed to list reports for {mark_set_id}: {e}")
            reports = []
        
        if not reports:
            # No reports yet, skip this markset
            continue
        
        # Sort by created_at desc, take latest
        reports.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        latest_report = reports[0]
        
        report_id = latest_report.get("report_id")
        inspected_by = latest_report.get("submitted_by") or latest_report.get("created_by", "")
        inspected_at = latest_report.get("created_at", "")
        
        # 3) Fetch user inputs for this report
        try:
            user_inputs = storage.get_user_inputs(
                mark_set_id=mark_set_id,
                report_id=report_id,
            )
        except Exception as e:
            logger.warning(f"Failed to get user inputs for {mark_set_id}/{report_id}: {e}")
            user_inputs = []
        
        # 4) Build values dict: master_mark_id -> observed_value
        values: dict[str, str] = {}
        for ui in user_inputs:
            child_mark_id = ui.get("mark_id")
            if not child_mark_id:
                continue
            
            # Map child -> master
            master_mark_id = master_child_map.get(child_mark_id, child_mark_id)
            values[master_mark_id] = ui.get("user_value", "")
        
        runs.append(
            MasterReportRun(
                mark_set_id=mark_set_id,
                mark_set_name=mark_set_name,
                inspected_by=inspected_by,
                inspected_at=inspected_at,
                values=values,
            )
        )
    
    return runs


# ========== Endpoint ==========

@router.post("/generate", status_code=status.HTTP_200_OK)
async def generate_master_report(
    req: MasterReportRequest,
    storage=Depends(get_storage),
):
    """
    Generate master inspection report Excel for a document.
    
    Returns Excel file showing:
    - Rows: all master marks
    - Columns: all inspection runs (latest report per markset)
    """
    try:
        # 1) Resolve document (now aware of dwg_num when provided)
        doc = storage.get_document_by_business_key(
            project_name=req.project_name,
            external_id=req.id,
            part_number=req.part_number,
            dwg_num=req.dwg_num or "",
        )
        
        if not doc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="DOCUMENT_NOT_FOUND",
            )
        
        doc_id = doc.get("doc_id")
        
        # 2) Find master mark set
        mark_sets = storage.list_mark_sets_by_document(doc_id)
        master_mark_set_id = _find_master_mark_set_id(mark_sets)
        
        if not master_mark_set_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MASTER_MARK_SET_NOT_FOUND",
            )
        
        # 3) Fetch master marks
        try:
            master_marks = storage.list_marks(master_mark_set_id)
        except Exception as e:
            logger.error(f"Failed to fetch master marks: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to fetch master marks: {str(e)}",
            )
        
        if not master_marks:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="NO_MASTER_MARKS_FOUND",
            )
        
        # 4) Build master-child mapping
        master_child_map = _build_master_child_map(storage, master_marks)
        
        # 5) Fetch all runs
        runs = await _fetch_runs_for_document(
            storage=storage,
            doc_id=doc_id,
            master_child_map=master_child_map,
            max_runs=req.max_runs,
        )
        
        if not runs:
            logger.warning(f"No inspection runs found for document {doc_id}")
            # Still generate report, just with empty columns
        
        # 6) Generate Excel
        excel_bytes = await generate_master_report_excel(
            project_name=req.project_name,
            external_id=req.id,
            part_number=req.part_number,
            master_marks=master_marks,
            runs=runs,
            report_title=req.report_title,
            max_runs=req.max_runs,
            dwg_num=req.dwg_num or None,
        )
        
        # 7) Return as download
        if req.dwg_num:
            safe_dwg = req.dwg_num.replace("/", "-")
            filename = f"{req.part_number}_{safe_dwg}_master_report.xlsx"
        else:
            filename = f"{req.part_number}_master_report.xlsx"
        
        return StreamingResponse(
            BytesIO(excel_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to generate master report: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate master report: {str(e)}",
        )