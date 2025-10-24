"""
Pydantic schemas for marks with strict validation.
Ensures data integrity and prevents corrupt coordinates.
"""

from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator


class MarkBase(BaseModel):
    """Base mark schema with coordinate validation."""
    page_index: int = Field(..., ge=0, description="Page index (0-based)")
    order_index: int = Field(..., ge=0, description="Order in navigation sequence")
    name: str = Field(..., min_length=1, max_length=200, description="Mark name")
    
    # Normalized coordinates (0.0 to 1.0)
    nx: float = Field(..., gt=0.0, le=1.0, description="Normalized X (left)")
    ny: float = Field(..., gt=0.0, le=1.0, description="Normalized Y (top)")
    nw: float = Field(..., gt=0.0, le=1.0, description="Normalized width")
    nh: float = Field(..., gt=0.0, le=1.0, description="Normalized height")
    
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0, description="Zoom level hint")
    padding_pct: float = Field(0.1, ge=0.0, le=0.5, description="Padding percentage")
    anchor: str = Field("auto", description="Anchor position")
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: str) -> str:
        """Ensure anchor is in valid set."""
        valid_anchors = {"auto", "center", "top-left", "top-right", "bottom-left", "bottom-right"}
        if v not in valid_anchors:
            return "auto"
        return v
    
    @model_validator(mode='after')
    def validate_bounds(self) -> 'MarkBase':
        """Ensure mark is within page bounds and has non-zero area."""
        # Check right edge
        if self.nx + self.nw > 1.0001:  # Small tolerance for floating point
            raise ValueError(f"Mark extends beyond page width: nx({self.nx}) + nw({self.nw}) > 1.0")
        
        # Check bottom edge
        if self.ny + self.nh > 1.0001:
            raise ValueError(f"Mark extends beyond page height: ny({self.ny}) + nh({self.nh}) > 1.0")
        
        # Check area
        area = self.nw * self.nh
        if area < 0.0001:  # Minimum 0.01% of page
            raise ValueError(f"Mark area too small: {area:.6f} < 0.0001")
        
        return self


class MarkCreate(MarkBase):
    """Schema for creating a new mark."""
    pass


class MarkOut(MarkBase):
    """Schema for mark output (includes mark_id)."""
    mark_id: str = Field(..., description="Unique mark identifier")

    class Config:
        from_attributes = True


class MarkPatch(BaseModel):
    """Schema for updating mark display preferences."""
    zoom_hint: Optional[float] = Field(None, gt=0.1, le=10.0)
    padding_pct: Optional[float] = Field(None, ge=0.0, le=0.5)
    anchor: Optional[str] = None
    
    @field_validator('anchor')
    @classmethod
    def validate_anchor(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        valid_anchors = {"auto", "center", "top-left", "top-right", "bottom-left", "bottom-right"}
        if v not in valid_anchors:
            return "auto"
        return v