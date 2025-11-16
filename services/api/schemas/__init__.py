"""
Pydantic schemas for API request/response validation.
"""
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .document import DocumentCreate, DocumentInit, DocumentOut, DocumentWithMarkSets
from .user_input import (
    UserInputCreate,
    UserInputBatchCreate,
    UserInputOut,
    UserInputUpdate,
)

# ============ Page Schemas ============


class PageDimensions(BaseModel):
    """Dimensions for a single page."""
    page_index: int = Field(..., ge=0, description="0-based page index")
    width_pt: float = Field(..., gt=0, description="Page width in points")
    height_pt: float = Field(..., gt=0, description="Page height in points")
    rotation_deg: int = Field(0, description="Page rotation in degrees")

    @field_validator("rotation_deg")
    @classmethod
    def validate_rotation(cls, v: int) -> int:
        if v not in (0, 90, 180, 270):
            raise ValueError(f"rotation_deg must be 0, 90, 180, or 270, got {v}")
        return v


class PagesBootstrap(BaseModel):
    """Request to bootstrap pages for a document."""
    page_count: int = Field(..., gt=0, description="Total number of pages")
    dims: List[PageDimensions] = Field(..., description="Dimensions for each page")

    @field_validator("dims")
    @classmethod
    def validate_dims_count(cls, v: List[PageDimensions], info) -> List[PageDimensions]:
        page_count = info.data.get("page_count")
        if page_count and len(v) != page_count:
            raise ValueError(f"dims length ({len(v)}) must match page_count ({page_count})")
        return v


# ============ Mark Schemas (API-facing) ============


class MarkCreate(BaseModel):
    """
    Single mark in a mark set creation request (master markset).

    NOTE:
    - We use `instrument` instead of a free-text mark name.
    - `label` may be omitted by client; server can generate A, B, C...
    """
    page_index: int = Field(..., ge=0, description="0-based page index")
    order_index: int = Field(..., ge=0, description="Sequential order for navigation")

    label: Optional[str] = Field(
        None,
        min_length=1,
        max_length=50,
        description="Fixed mark label like A, B, C",
    )
    instrument: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Instrument name for this mark",
    )
    is_required: bool = Field(
        True,
        description="Whether this mark is mandatory during QC",
    )

    nx: float = Field(..., gt=0, le=1.0, description="Normalized x")
    ny: float = Field(..., gt=0, le=1.0, description="Normalized y")
    nw: float = Field(..., gt=0, le=1.0, description="Normalized width")
    nh: float = Field(..., gt=0, le=1.0, description="Normalized height")

    @model_validator(mode="after")
    def validate_bounds(self) -> "MarkCreate":
        if self.nx + self.nw > 1.0001:
            raise ValueError("Mark extends beyond page width")
        if self.ny + self.nh > 1.0001:
            raise ValueError("Mark extends beyond page height")
        area = self.nw * self.nh
        if area < 0.0001:
            raise ValueError("Mark area too small")
        return self


class MarkSetCreate(BaseModel):
    """
    Request to create a new mark set.

    For master markset, this includes all marks.
    For QC marksets, we will later use different payloads (groups, etc.).
    """
    doc_id: str = Field(..., min_length=1, description="Document ID")
    name: Optional[str] = Field("v1", max_length=100, description="Mark set name/label")
    description: Optional[str] = Field(
        None,
        max_length=500,
        description="Short description for this mark set",
    )
    created_by: Optional[str] = Field(None, description="User ID of creator")
    marks: List[MarkCreate] = Field(
        ...,
        min_length=1,
        max_length=500,
        description="List of marks",
    )

    @model_validator(mode="after")
    def validate_and_normalize_order(self) -> "MarkSetCreate":
        order_indexes = [m.order_index for m in self.marks]
        if len(order_indexes) != len(set(order_indexes)):
            raise ValueError("Duplicate order_index values")
        sorted_marks = sorted(self.marks, key=lambda m: m.order_index)
        for i, mark in enumerate(sorted_marks):
            mark.order_index = i
        return self


class MarkSetOut(BaseModel):
    """Response after creating a mark set."""
    mark_set_id: str


class MarkOut(BaseModel):
    """Mark data for viewer consumption."""
    mark_id: str
    page_index: int
    order_index: int
    label: str
    instrument: str
    is_required: bool
    nx: float
    ny: float
    nw: float
    nh: float


class MarkPatch(BaseModel):
    """Partial update for mark fields."""
    instrument: Optional[str] = Field(
        None,
        min_length=1,
        max_length=200,
        description="Updated instrument",
    )
    is_required: Optional[bool] = Field(
        None,
        description="Updated required flag",
    )


# ============ Health Check ============


class HealthCheck(BaseModel):
    """Health check response."""
    ok: bool = True
    backend: Optional[str] = None


# Re-export all
__all__ = [
    "DocumentCreate",
    "DocumentInit",
    "DocumentOut",
    "DocumentWithMarkSets",
    "PageDimensions",
    "PagesBootstrap",
    "MarkCreate",
    "MarkSetCreate",
    "MarkSetOut",
    "MarkOut",
    "MarkPatch",
    "UserInputCreate",
    "UserInputBatchCreate",
    "UserInputOut",
    "UserInputUpdate",
    "HealthCheck",
]
