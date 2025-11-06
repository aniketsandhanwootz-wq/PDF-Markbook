# services/api/routers/viewer.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, Dict, Any, List, Optional

from main import get_storage_adapter  # DI from main

router = APIRouter(prefix="/viewer", tags=["viewer"])

# DI alias (no default!)
Storage = Annotated[object, Depends(get_storage_adapter)]

def _bool(s: str | None) -> bool:
    return (s or "").strip().upper() == "TRUE"

def _marks_count_by_markset(storage) -> Dict[str, int]:
    """
    Count marks per mark_set_id efficiently using the marks sheet.
    Uses the adapter's private getter (OK within same service).
    """
    try:
        all_marks = storage._get_all_dicts("marks")
    except Exception:
        # fallback: no marks yet
        return {}
    counts: Dict[str, int] = {}
    for m in all_marks:
        msid = m.get("mark_set_id", "")
        if not msid:
            continue
        counts[msid] = counts.get(msid, 0) + 1
    return counts

def _master_mark_set_id(mark_sets: List[Dict[str, Any]]) -> Optional[str]:
    for ms in mark_sets:
        if _bool(ms.get("is_master")):
            return ms.get("mark_set_id")
    return None

@router.get("/bootstrap", status_code=status.HTTP_200_OK)
async def bootstrap(
    storage: Storage,
    project_name: str = Query(..., min_length=1),
    id: str = Query(..., min_length=1, description="Business id (ProjectName + PartName)"),
    part_number: str = Query(..., min_length=1),
    # Which marks to include? "none" | "master" | mark_set_id
    include: str = Query("none"),
):
    """
    Viewer entrypoint:
      • Resolve document by (project_name, id, part_number)
      • Return all mark-sets (Master first), with counts
      • Optionally include full marks for a chosen set (include=master or include=<mark_set_id>)
    """
    # 1) Resolve document
    doc = storage.get_document_by_business_key(
        project_name=project_name,
        external_id=id,
        part_number=part_number,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

    # 2) List mark-sets + compute master
    mark_sets = storage.list_mark_sets_by_document(doc["doc_id"])
    master_id = _master_mark_set_id(mark_sets)

    # 3) Marks count for each set
    counts = _marks_count_by_markset(storage)

    # 4) Sort: Master first, then created_at asc (string ISO sort is fine), then label
    def _key(ms: Dict[str, Any]):
        return (
            0 if _bool(ms.get("is_master")) else 1,
            ms.get("created_at", ""),
            ms.get("label", ""),
        )
    mark_sets_sorted = sorted(mark_sets, key=_key)

    # 5) Prepare minimal payload for list
    mark_sets_out = [
        {
            "mark_set_id": ms.get("mark_set_id"),
            "label": ms.get("label"),
            "is_master": _bool(ms.get("is_master")),
            "is_active": _bool(ms.get("is_active")),
            "created_by": ms.get("created_by", ""),
            "created_at": ms.get("created_at", ""),
            "updated_by": ms.get("updated_by", ""),
            "marks_count": counts.get(ms.get("mark_set_id", ""), 0),
        }
        for ms in mark_sets_sorted
    ]

    # 6) Optionally include marks of a chosen set
    include_marks_for: Optional[str] = None
    if include == "master" and master_id:
        include_marks_for = master_id
    elif include and include not in ("none", "master"):
        include_marks_for = include

    marks_payload: List[Dict[str, Any]] = []
    if include_marks_for:
        try:
            # Reuse main's pydantic model expectation: dict fields already in adapter format
            marks_payload = storage.list_marks(include_marks_for)
        except Exception:
            marks_payload = []

    return {
        "document": {
            "doc_id": doc["doc_id"],
            "project_name": doc.get("project_name", ""),
            "id": doc.get("external_id", ""),
            "part_number": doc.get("part_number", ""),
            "pdf_url": doc.get("pdf_url", ""),
            "page_count": doc.get("page_count", 0),
        },
        "mark_sets": mark_sets_out,
        "master_mark_set_id": master_id,
        "included_mark_set_id": include_marks_for,
        "marks": marks_payload,  # empty if include=none or not found
    }
