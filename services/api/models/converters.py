from __future__ import annotations

import json
from typing import Any, Dict

from . import Document, MarkSet


def _bool_from_sheet(v: Any) -> bool:
    """
    Convert Sheets-style boolean cells to Python bool.
    Accepts: TRUE/FALSE, 1/0, yes/no, y/n (case-insensitive).
    """
    if v is None:
        return False
    s = str(v).strip().upper()
    return s in ("TRUE", "1", "YES", "Y")


def document_from_sheets(row: dict[str, Any]) -> Document:
    return Document(
        doc_id=row.get("doc_id", ""),
        pdf_url=row.get("pdf_url", ""),
        page_count=int(row.get("page_count") or 0),
        part_number=(row.get("part_number") or None),
        project_name=(row.get("project_name") or None),
        external_id=(row.get("external_id") or None),
        dwg_num=(row.get("dwg_num") or None),                 # 🔥 NEW
        drawing_type=row.get("drawing_type") or None,  # 👈 ADD THIS
        master_editors=(row.get("master_editors") or None),
        created_by=(row.get("created_by") or None),
        created_at=row.get("created_at") or "",
        updated_at=row.get("updated_at") or "",
    )


def markset_from_sheets(row: Dict[str, Any]) -> MarkSet:
    """
    Convert a raw dict from the `mark_sets` sheet into a MarkSet model.
    """
    history_raw = row.get("update_history") or "[]"
    history = []
    try:
        if isinstance(history_raw, str):
            history = json.loads(history_raw)
        elif isinstance(history_raw, list):
            history = history_raw
    except Exception:
        history = []

    return MarkSet(
        mark_set_id=row.get("mark_set_id", ""),
        doc_id=row.get("doc_id", ""),

        label=row.get("name") or row.get("label") or "",
        description=row.get("description") or None,

        is_active=_bool_from_sheet(row.get("is_active")),
        is_master=_bool_from_sheet(row.get("is_master")),

        created_by=row.get("created_by") or None,
        created_at=row.get("created_at") or None,
        updated_by=row.get("updated_by") or None,

        update_history=history,
    )
