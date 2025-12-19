# services/api/models/mark_set.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class MarkSet:
    """
    Domain model for a mark set.

    This represents one logical 'version' of marks for a document:
      - MASTER mark set: holds the universal marks
      - QC mark set: holds groups referencing master marks
    """
    mark_set_id: str
    doc_id: str

    label: str = "v1"                 # maps to `name` in Sheets
    description: Optional[str] = None

    is_active: bool = False
    is_master: bool = False

    created_by: Optional[str] = None
    created_at: str = ""
    updated_by: Optional[str] = None
    update_history: Optional[str] = None  # JSON string in Sheets

    # ✅ Save & Finish versioning fields
    content_rev: int = 0
    annotated_pdf_rev: int = 0
    annotated_pdf_url: Optional[str] = None
    annotated_pdf_updated_at: Optional[str] = None
   
