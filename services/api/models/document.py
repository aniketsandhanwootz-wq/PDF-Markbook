from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class Document:
    """
    Domain model for a PDF document.

    This is a pure data object that is easy to map:
      - from Sheets rows (dict[str, str])
      - to Pydantic schemas (DocumentOut, etc.)
    """
    doc_id: str
    pdf_url: str

    page_count: int = 0

    part_number: Optional[str] = None
    project_name: Optional[str] = None
    external_id: Optional[str] = None      # business id (ProjectName+PartName)
    dwg_num: Optional[str] = None          # drawing number (assembly/part)
    drawing_type: Optional[str] = None     # type: Part/Fabrication/Assembly/...
    master_editors: Optional[str] = None   # comma-separated emails


    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
