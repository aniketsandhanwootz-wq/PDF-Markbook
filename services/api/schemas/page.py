# services/api/schemas/page.py
from __future__ import annotations

from pydantic import BaseModel, Field, model_validator
from typing import List


class PageDim(BaseModel):
    """Single page geometry in PDF points (1/72 inch)."""
    idx: int = Field(ge=0, description="Zero-based page index")
    width_pt: float = Field(gt=0, description="Page width in points")
    height_pt: float = Field(gt=0, description="Page height in points")
    rotation_deg: int = Field(default=0, description="Rotation of the page (0/90/180/270)")

    @model_validator(mode="after")
    def _rotation_allowed(self):
        if self.rotation_deg not in (0, 90, 180, 270):
            raise ValueError("rotation_deg must be one of 0, 90, 180, 270")
        return self


class PagesBootstrap(BaseModel):
    """
    Payload for bootstrapping the pages of a document in storage.
    Typically used by /documents/init after we know page dims.
    """
    doc_id: str
    page_count: int = Field(ge=1, description="Total number of pages")
    dims: List[PageDim]
