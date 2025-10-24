"""
Pydantic schemas for mark sets with validation.
"""

from typing import Optional, List
from pydantic import BaseModel, Field, model_validator

from .mark import MarkCreate, MarkOut


class MarkSetBase(BaseModel):
    """Base mark set schema."""
    label: str = Field("v1", max_length=100, description="Mark set label/version")


class MarkSetCreate(MarkSetBase):
    """Schema for creating a mark set."""
    doc_id: str = Field(..., min_length=1, description="Document ID")
    created_by: Optional[str] = Field(None, description="Creator identifier")
    marks: List[MarkCreate] = Field(..., min_items=1, max_items=500, description="List of marks")
    
    @model_validator(mode='after')
    def validate_order_indexes(self) -> 'MarkSetCreate':
        """Ensure order_index values are unique and normalize to 0..n-1."""
        order_indexes = [m.order_index for m in self.marks]
        
        # Check for duplicates
        if len(order_indexes) != len(set(order_indexes)):
            raise ValueError("Duplicate order_index values found")
        
        # Auto-normalize to 0..n-1 (server handles reordering)
        sorted_marks = sorted(self.marks, key=lambda m: m.order_index)
        for i, mark in enumerate(sorted_marks):
            mark.order_index = i
        
        return self


class MarkSetOut(MarkSetBase):
    """Schema for mark set output."""
    mark_set_id: str = Field(..., description="Unique mark set identifier")
    doc_id: str
    is_active: bool = Field(False, description="Whether this is the active mark set")
    created_by: Optional[str] = None
    created_at: str = Field(..., description="Creation timestamp")

    class Config:
        from_attributes = True


class MarkSetWithMarks(MarkSetOut):
    """Schema for mark set with all its marks."""
    marks: List[MarkOut] = Field(..., description="All marks in this set")