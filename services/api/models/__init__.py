"""
Domain models for PDF Markbook.
These are internal representations, separate from I/O schemas.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class Document:
    """Represents a PDF document in the system."""
    doc_id: str
    pdf_url: str
    page_count: Optional[int] = None
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class Page:
    """Represents a single page within a document."""
    page_id: str
    doc_id: str
    idx: int  # 0-based page index
    width_pt: float  # Page width in points (unrotated)
    height_pt: float  # Page height in points (unrotated)
    rotation_deg: int  # Rotation in degrees: 0, 90, 180, or 270


@dataclass
class MarkSet:
    """
    A collection of marks (regions of interest) for a document.
    Only one mark set per document can be active at a time.
    """
    mark_set_id: str
    doc_id: str
    label: str = "v1"
    is_active: bool = False
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class Mark:
    """
    A rectangular region of interest on a PDF page.
    Coordinates are normalized (0-1 range) relative to unrotated page dimensions.
    """
    mark_id: str
    mark_set_id: str
    page_id: str
    order_index: int  # Sequential order for navigation
    name: str  # User-friendly label for the mark
    
    # Normalized coordinates (0-1 range, relative to unrotated page)
    nx: float  # Normalized x coordinate (left edge)
    ny: float  # Normalized y coordinate (top edge)
    nw: float  # Normalized width
    nh: float  # Normalized height
    
    # Display preferences
    zoom_hint: Optional[float] = None  # Custom zoom level (multiplier)
    padding_pct: float = 0.1  # Padding around mark when viewing (0.1 = 10%)
    anchor: str = "auto"  # Zoom anchor point: "auto", "center", "top-left"
    
    created_at: datetime = field(default_factory=datetime.utcnow)