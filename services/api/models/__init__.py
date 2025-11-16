from __future__ import annotations

from typing import Optional, Any, List
from pydantic import BaseModel


class Document(BaseModel):
    """
    Domain model for a document row from the `documents` sheet.
    """
    doc_id: str
    pdf_url: str
    page_count: int = 0

    part_number: Optional[str] = None
    external_id: Optional[str] = None
    project_name: Optional[str] = None
    master_editors: Optional[str] = None

    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MarkSet(BaseModel):
    """
    Domain model for a mark_set row from the `mark_sets` sheet.
    """
    mark_set_id: str
    doc_id: str

    # UI label (maps to `name` in the sheet)
    label: str
    description: Optional[str] = None

    is_active: bool = False
    is_master: bool = False

    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_by: Optional[str] = None

    # Parsed JSON history from `update_history` column
    update_history: Optional[List[dict[str, Any]]] = None
