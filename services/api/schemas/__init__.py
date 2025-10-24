"""
Pydantic schemas for API request/response validation.
These define the contract between frontend and backend.
✨ Enhanced with strict validation to prevent corrupt data.
"""
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


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


# ============ Mark Schemas (ENHANCED) ============

class MarkCreate(BaseModel):
    """
    Single mark in a mark set creation request.
    ✨ Enhanced with strict coordinate validation.
    """
    page_index: int = Field(..., ge=0, description="0-based page index")
    order_index: int = Field(..., ge=0, description="Sequential order for navigation")
    name: str = Field(..., min_length=1, max_length=200, description="User-friendly label")
    
    # ✨ ENHANCED: Stricter normalized coordinates (0-1 range)
    nx: float = Field(..., gt=0, le=1.0, description="Normalized x (left edge) - must be > 0 and ≤ 1")
    ny: float = Field(..., gt=0, le=1.0, description="Normalized y (top edge) - must be > 0 and ≤ 1")
    nw: float = Field(..., gt=0, le=1.0, description="Normalized width - must be > 0 and ≤ 1")
    nh: float = Field(..., gt=0, le=1.0, description="Normalized height - must be > 0 and ≤ 1")
    
    # Optional display preferences
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0, description="Custom zoom multiplier (0.1-10x)")
    padding_pct: Optional[float] = Field(0.1, ge=0, le=0.5, description="Padding as percentage (0-0.5)")
    anchor: Optional[str] = Field("auto", description="Zoom anchor point")
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: Optional[str]) -> str:
        """✨ NEW: Ensure anchor is in valid set."""
        if v is None:
            return "auto"
        valid_anchors = {"auto", "center", "top-left", "top-right", "bottom-left", "bottom-right"}
        if v.lower() not in valid_anchors:
            return "auto"
        return v.lower()
    
    @model_validator(mode='after')
    def validate_bounds(self) -> 'MarkCreate':
        """
        ✨ NEW: Ensure mark is within page bounds and has non-zero area.
        This prevents corrupt data from reaching the database.
        """
        # Check right edge (with small floating point tolerance)
        if self.nx + self.nw > 1.0001:
            raise ValueError(
                f"Mark extends beyond page width: "
                f"nx({self.nx:.4f}) + nw({self.nw:.4f}) = {self.nx + self.nw:.4f} > 1.0"
            )
        
        # Check bottom edge
        if self.ny + self.nh > 1.0001:
            raise ValueError(
                f"Mark extends beyond page height: "
                f"ny({self.ny:.4f}) + nh({self.nh:.4f}) = {self.ny + self.nh:.4f} > 1.0"
            )
        
        # Check minimum area (prevent invisible marks)
        area = self.nw * self.nh
        if area < 0.0001:  # Minimum 0.01% of page
            raise ValueError(
                f"Mark area too small ({area:.6f} < 0.0001). "
                f"Mark would be invisible or unclickable."
            )
        
        return self


class MarkSetCreate(BaseModel):
    """
    Request to create a new mark set.
    ✨ Enhanced with duplicate detection and auto-normalization.
    """
    doc_id: str = Field(..., min_length=1, description="Document ID")
    label: Optional[str] = Field("v1", max_length=100, description="Version label for the mark set")
    created_by: Optional[str] = Field(None, description="User ID of creator")
    marks: List[MarkCreate] = Field(
        ..., 
        min_length=1, 
        max_length=500,
        description="List of marks (1-500 marks)"
    )
    
    @model_validator(mode='after')
    def validate_and_normalize_order(self) -> 'MarkSetCreate':
        """
        ✨ NEW: Ensure order_index values are unique and normalize to 0..n-1.
        Server automatically reorders marks to prevent gaps or duplicates.
        """
        order_indexes = [m.order_index for m in self.marks]
        
        # Check for duplicates
        if len(order_indexes) != len(set(order_indexes)):
            duplicates = [idx for idx in set(order_indexes) if order_indexes.count(idx) > 1]
            raise ValueError(
                f"Duplicate order_index values found: {duplicates}. "
                f"Each mark must have a unique order_index."
            )
        
        # Auto-normalize to 0..n-1 (prevents gaps in sequence)
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
    """
    Partial update for a mark's display preferences.
    ✨ Enhanced with validation.
    """
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0, description="Custom zoom multiplier (0.1-10x)")
    padding_pct: Optional[float] = Field(None, ge=0, le=0.5, description="Padding percentage (0-0.5)")
    anchor: Optional[str] = Field(None, description="Zoom anchor point")
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: Optional[str]) -> Optional[str]:
        """✨ NEW: Ensure anchor is in valid set."""
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