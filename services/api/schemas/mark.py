"""
Pydantic schemas for marks with strict validation.
Ensures data integrity and prevents corrupt coordinates.
"""

from typing import Optional
from pydantic import BaseModel, Field, model_validator


class MarkBase(BaseModel):
    """
    Base mark schema with coordinate validation.

    NOTE:
    - We no longer store a free-text "name" for marks.
    - Instead, each mark has:
        * label      → A, B, C, ... (generated, fixed)
        * instrument → which instrument is used for QC
        * is_required → whether this check is mandatory
    """
    page_index: int = Field(..., ge=0, description="Page index (0-based)")
    order_index: int = Field(..., ge=0, description="Order in navigation sequence")

    label: Optional[str] = Field(
        None,
        min_length=1,
        max_length=50,
        description="Fixed mark label like A, B, C (usually server-generated)",
    )
    instrument: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Instrument used for this mark",
    )
    is_required: bool = Field(
        True,
        description="Whether this mark is mandatory during QC",
    )

    # Normalized coordinates (0.0 to 1.0)
    nx: float = Field(..., gt=0.0, le=1.0, description="Normalized X (left)")
    ny: float = Field(..., gt=0.0, le=1.0, description="Normalized Y (top)")
    nw: float = Field(..., gt=0.0, le=1.0, description="Normalized width")
    nh: float = Field(..., gt=0.0, le=1.0, description="Normalized height")

    @model_validator(mode="after")
    def validate_bounds(self) -> "MarkBase":
        """Ensure mark is within page bounds and has non-zero area."""
        if self.nx + self.nw > 1.0001:  # Small tolerance for floating point
            raise ValueError(
                f"Mark extends beyond page width: nx({self.nx}) + nw({self.nw}) > 1.0"
            )

        if self.ny + self.nh > 1.0001:
            raise ValueError(
                f"Mark extends beyond page height: ny({self.ny}) + nh({self.nh}) > 1.0"
            )

        area = self.nw * self.nh
        if area < 0.0001:  # Minimum 0.01% of page
            raise ValueError(f"Mark area too small: {area:.6f} < 0.0001")

        return self


class MarkCreate(MarkBase):
    """
    Schema for creating a new mark.

    Typically:
    - client sends: page_index, instrument, is_required, coords
    - server can generate `label` and normalize `order_index`.
    """
    pass


class MarkOut(MarkBase):
    """Schema for mark output (includes mark_id)."""
    mark_id: str = Field(..., description="Unique mark identifier")

    class Config:
        from_attributes = True


class MarkPatch(BaseModel):
    """
    Schema for updating mark fields that are allowed to change.
    We only allow changing:
      - instrument
      - is_required
    """
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
