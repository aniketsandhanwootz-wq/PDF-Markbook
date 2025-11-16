# services/api/routers/viewer.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, Dict, Any, List, Optional

from main import get_storage_adapter  # DI from main
from models import Document, MarkSet
from models.converters import document_from_sheets, markset_from_sheets

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

@router.get("/groups/{mark_set_id}", status_code=status.HTTP_200_OK)
async def get_groups_with_marks(
    storage: Storage,
    mark_set_id: str,
):
    """
    Viewer helper:

    Given a QC mark_set_id:
    - Find its document
    - Resolve the master mark set for that document
    - Load:
        * groups for the QC markset
        * master marks
    - For each group, attach its marks (by mark_id), sorted by
      (instrument, label).
    """
    try:
        # 1) Resolve mark_set row and doc_id
        all_ms = storage._get_all_dicts("mark_sets")
        target = next((ms for ms in all_ms if ms.get("mark_set_id") == mark_set_id), None)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MARK_SET_NOT_FOUND")

        doc_id = target.get("doc_id")
        if not doc_id:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="MARK_SET_HAS_NO_DOC_ID")

        # 2) Find master markset for this doc
        master_ms = None
        for ms in all_ms:
            if ms.get("doc_id") == doc_id and _bool(ms.get("is_master")):
                master_ms = ms
                break
        if not master_ms:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MASTER_MARK_SET_NOT_FOUND")

        master_id = master_ms.get("mark_set_id")

        # 3) Load master marks and index by mark_id
        master_marks = storage.list_marks(master_id)
        mark_index = {m.get("mark_id"): m for m in master_marks if m.get("mark_id")}

        # 4) Load groups for the QC markset
        if not hasattr(storage, "list_groups_for_mark_set"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Groups are not supported by this backend",
            )

        groups = storage.list_groups_for_mark_set(mark_set_id)

        # 5) Attach marks to each group, sorted by instrument, then label
        result_groups: List[Dict[str, Any]] = []
        for g in groups:
            raw_ids = g.get("mark_ids", []) or []
            marks_for_group = [
                mark_index[mid] for mid in raw_ids if mid in mark_index
            ]

            marks_for_group.sort(
                key=lambda m: (
                    (m.get("instrument") or "").lower(),
                    m.get("label") or "",
                )
            )

            # copy group data and attach marks
            grp = dict(g)
            grp["marks"] = marks_for_group
            result_groups.append(grp)

        return {
            "doc_id": doc_id,
            "qc_mark_set_id": mark_set_id,
            "master_mark_set_id": master_id,
            "groups": result_groups,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch groups with marks: {e}",
        )

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
    # 1) Resolve document (Sheets → Domain)
    doc_raw = storage.get_document_by_business_key(
        project_name=project_name,
        external_id=id,
        part_number=part_number,
    )
    if not doc_raw:
        raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

    doc: Document = document_from_sheets(doc_raw)

    # 2) List mark-sets + convert to domain models
    mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
    mark_set_models: List[MarkSet] = [
        markset_from_sheets(ms) for ms in mark_sets_raw
    ]

    # 3) Compute master_id from domain models
    master_id = next((ms.mark_set_id for ms in mark_set_models if ms.is_master), None)

    # 4) Marks count for each set
    counts = _marks_count_by_markset(storage)

    # 5) Sort: Master first, then created_at asc, then label
    def _key(ms: MarkSet):
        return (
            0 if ms.is_master else 1,
            ms.created_at or "",
            ms.label or "",
        )

    mark_sets_sorted = sorted(mark_set_models, key=_key)

    # 6) Prepare minimal payload for list (Domain → dict)
    mark_sets_out = [
        {
            "mark_set_id": ms.mark_set_id,
            "label": ms.label or "",
            "is_master": ms.is_master,
            "is_active": ms.is_active,
            "created_by": ms.created_by or "",
            "created_at": ms.created_at or "",
            "updated_by": ms.updated_by or "",
            "marks_count": counts.get(ms.mark_set_id, 0),
        }
        for ms in mark_sets_sorted
    ]

    # 7) Optionally include marks of a chosen set
    include_marks_for: Optional[str] = None
    if include == "master" and master_id:
        include_marks_for = master_id
    elif include and include not in ("none", "master"):
        include_marks_for = include

    marks_payload: List[Dict[str, Any]] = []
    if include_marks_for:
        try:
            # storage.list_marks returns already-normalized dicts
            marks_payload = storage.list_marks(include_marks_for)
        except Exception:
            marks_payload = []

    return {
        "document": {
            "doc_id": doc.doc_id,
            "project_name": doc.project_name or "",
            "id": doc.external_id or "",
            "part_number": doc.part_number or "",
            "pdf_url": doc.pdf_url,
            "page_count": doc.page_count,
        },
        "mark_sets": mark_sets_out,
        "master_mark_set_id": master_id,
        "included_mark_set_id": include_marks_for,
        "marks": marks_payload,  # empty if include=none or not found
    }
