"""
Pydantic schemas for user input (QC values).
"""
from typing import Optional
from pydantic import BaseModel, Field


class UserInputCreate(BaseModel):
    """Schema for creating user input."""
    mark_id: str = Field(..., description="Mark ID")
    mark_set_id: str = Field(..., description="Mark set ID")
    user_value: str = Field(..., description="Observed value")
    submitted_by: str = Field(..., description="User email/ID")


class UserInputBatchCreate(BaseModel):
    """Schema for batch creating user inputs."""
    mark_set_id: str = Field(..., description="Mark set ID")
    submitted_by: str = Field(..., description="User email/ID")
    entries: dict[str, str] = Field(..., description="Map of mark_id -> user_value")


class UserInputOut(BaseModel):
    """Schema for user input output."""
    input_id: str
    mark_id: str
    mark_set_id: str
    user_value: str
    submitted_at: str
    submitted_by: str

    class Config:
        from_attributes = True


class UserInputUpdate(BaseModel):
    """Schema for updating user input."""
    user_value: str = Field(..., description="Updated value")