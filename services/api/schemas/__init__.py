"""
Pydantic schemas for API request/response validation.
These define the contract between frontend and backend.
"""
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator


# ============ Document Schemas ============

class DocumentCreate(BaseModel):
    """Request to create a new document."""
    pdf_url: str = Field(..., description="URL of the PDF document")
    created_by: Optional[str] = Field(None, description="User ID of creator")


class DocumentOut(BaseModel):
    """Response after creating a document."""
    doc_id: str


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
        """Ensure rotation is one of: 0, 90, 180, 270."""
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
        """Ensure dims list matches page_count."""
        page_count = info.data.get("page_count")
        if page_count and len(v) != page_count:
            raise ValueError(f"dims length ({len(v)}) must match page_count ({page_count})")
        return v


# ============ Mark Schemas ============

class MarkCreate(BaseModel):
    """Single mark in a mark set creation request."""
    page_index: int = Field(..., ge=0, description="0-based page index")
    order_index: int = Field(..., ge=0, description="Sequential order for navigation")
    name: str = Field(..., min_length=1, description="User-friendly label")
    
    # Normalized coordinates (0-1 range)
    nx: float = Field(..., ge=0, le=1, description="Normalized x (left edge)")
    ny: float = Field(..., ge=0, le=1, description="Normalized y (top edge)")
    nw: float = Field(..., gt=0, le=1, description="Normalized width")
    nh: float = Field(..., gt=0, le=1, description="Normalized height")
    
    # Optional display preferences
    zoom_hint: Optional[float] = Field(None, gt=0, description="Custom zoom multiplier")
    padding_pct: Optional[float] = Field(0.1, ge=0, le=1, description="Padding as percentage")
    anchor: Optional[str] = Field("auto", description="Zoom anchor point")


class MarkSetCreate(BaseModel):
    """Request to create a new mark set."""
    doc_id: str = Field(..., description="Document ID")
    label: Optional[str] = Field("v1", description="Version label for the mark set")
    created_by: Optional[str] = Field(None, description="User ID of creator")
    marks: List[MarkCreate] = Field(..., min_length=1, description="List of marks")


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
    """Partial update for a mark's display preferences."""
    zoom_hint: Optional[float] = Field(None, gt=0, description="Custom zoom multiplier")
    padding_pct: Optional[float] = Field(None, ge=0, le=1, description="Padding percentage")
    anchor: Optional[str] = Field(None, description="Zoom anchor point")


# ============ Health Check ============

class HealthCheck(BaseModel):
    """Health check response."""
    ok: bool = True
    backend: Optional[str] = None