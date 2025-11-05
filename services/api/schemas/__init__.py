"""
Pydantic schemas for API request/response validation.
"""
from .document import DocumentCreate, DocumentInit, DocumentOut, DocumentWithMarkSets
from .user_input import UserInputCreate, UserInputBatchCreate, UserInputOut, UserInputUpdate

# Keep existing imports for backward compatibility
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


# ============ Page Schemas ============

class PageDimensions(BaseModel):
    """Dimensions for a single page."""
    idx: int = Field(..., ge=0, description="0-based page index")
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


# ============ Mark Schemas ============

class MarkCreate(BaseModel):
    """Single mark in a mark set creation request."""
    page_index: int = Field(..., ge=0, description="0-based page index")
    order_index: int = Field(..., ge=0, description="Sequential order for navigation")
    name: str = Field(..., min_length=1, max_length=200, description="User-friendly label")
    
    nx: float = Field(..., gt=0, le=1.0, description="Normalized x")
    ny: float = Field(..., gt=0, le=1.0, description="Normalized y")
    nw: float = Field(..., gt=0, le=1.0, description="Normalized width")
    nh: float = Field(..., gt=0, le=1.0, description="Normalized height")
    
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0, description="Custom zoom")
    padding_pct: Optional[float] = Field(0.1, ge=0, le=0.5, description="Padding")
    anchor: Optional[str] = Field("auto", description="Zoom anchor")
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: Optional[str]) -> str:
        if v is None:
            return "auto"
        valid_anchors = {"auto", "center", "top-left", "top-right", "bottom-left", "bottom-right"}
        if v.lower() not in valid_anchors:
            return "auto"
        return v.lower()
    
    @model_validator(mode='after')
    def validate_bounds(self) -> 'MarkCreate':
        if self.nx + self.nw > 1.0001:
            raise ValueError(f"Mark extends beyond page width")
        if self.ny + self.nh > 1.0001:
            raise ValueError(f"Mark extends beyond page height")
        area = self.nw * self.nh
        if area < 0.0001:
            raise ValueError(f"Mark area too small")
        return self


class MarkSetCreate(BaseModel):
    """Request to create a new mark set."""
    doc_id: str = Field(..., min_length=1, description="Document ID")
    label: Optional[str] = Field("v1", max_length=100, description="Version label")
    created_by: Optional[str] = Field(None, description="User ID of creator")
    marks: List[MarkCreate] = Field(..., min_length=1, max_length=500, description="List of marks")
    
    @model_validator(mode='after')
    def validate_and_normalize_order(self) -> 'MarkSetCreate':
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
    name: str
    nx: float
    ny: float
    nw: float
    nh: float
    zoom_hint: Optional[float] = None
    padding_pct: float = 0.1
    anchor: str = "auto"


class MarkPatch(BaseModel):
    """Partial update for mark display preferences."""
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0)
    padding_pct: Optional[float] = Field(None, ge=0, le=0.5)
    anchor: Optional[str] = Field(None)
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        valid_anchors = {"auto", "center", "top-left", "top-right", "bottom-left", "bottom-right"}
        if v.lower() not in valid_anchors:
            return "auto"
        return v.lower()


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