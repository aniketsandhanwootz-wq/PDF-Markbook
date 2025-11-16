"""
Pydantic schemas for documents.
"""
from typing import Optional
from pydantic import BaseModel, Field


class DocumentBase(BaseModel):
    """Base document schema."""
    pdf_url: str = Field(..., description="URL of the PDF document")


class DocumentCreate(DocumentBase):
    """Schema for creating a document via API."""
    part_number: Optional[str] = Field(None, description="Part number")
    project_name: Optional[str] = Field(None, description="Project name")
    external_id: Optional[str] = Field(None, description="External business ID (Glide id)")
    master_editors: Optional[str] = Field(
        None,
        description="Comma-separated list of emails who can edit the master markset",
    )
    created_by: Optional[str] = Field(None, description="Creator email/ID")


class DocumentInit(BaseModel):
    """Schema for document initialization from Glide."""
    part_number: str = Field(..., description="Part number")
    id: str = Field(..., description="Project Name + Part Name (external id)")
    project_name: str = Field(..., description="Project name")
    user_mail: str = Field(..., description="User email")
    assembly_drawing: str = Field(..., description="Assembly drawing URL (JPEG)")


class DocumentOut(BaseModel):
    """Schema for document output."""
    doc_id: str = Field(..., description="Document ID")
    pdf_url: Optional[str] = None
    part_number: Optional[str] = None
    project_name: Optional[str] = None
    external_id: Optional[str] = None
    master_editors: Optional[str] = None

    class Config:
        from_attributes = True


class DocumentWithMarkSets(DocumentOut):
    """Schema for document with its mark sets."""
    mark_sets: list = Field(default_factory=list, description="List of mark sets")
