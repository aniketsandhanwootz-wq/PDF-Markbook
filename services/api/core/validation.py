"""
Validation utilities for PDF Markbook.
Ensures data integrity and provides clear error messages.
"""
from typing import List, Dict, Any
from fastapi import HTTPException


def validate_normalized_rect(nx: float, ny: float, nw: float, nh: float) -> None:
    """
    Validate that normalized rectangle coordinates are within valid ranges.
    
    Rules:
    - nx, ny must be in [0, 1] (position within page)
    - nw, nh must be in (0, 1] (positive size, not exceeding page)
    - nx + nw must not exceed 1 (right edge within page)
    - ny + nh must not exceed 1 (bottom edge within page)
    
    Raises:
        HTTPException: 400 if validation fails
    """
    # Position validation
    if not (0 <= nx <= 1):
        raise HTTPException(
            status_code=400,
            detail=f"nx must be in range [0, 1], got {nx}"
        )
    if not (0 <= ny <= 1):
        raise HTTPException(
            status_code=400,
            detail=f"ny must be in range [0, 1], got {ny}"
        )
    
    # Size validation (must be positive)
    if not (0 < nw <= 1):
        raise HTTPException(
            status_code=400,
            detail=f"nw must be in range (0, 1], got {nw}"
        )
    if not (0 < nh <= 1):
        raise HTTPException(
            status_code=400,
            detail=f"nh must be in range (0, 1], got {nh}"
        )
    
    # Boundary validation (must not extend beyond page)
    if nx + nw > 1.001:  # Small tolerance for floating point
        raise HTTPException(
            status_code=400,
            detail=f"nx + nw must not exceed 1 (got {nx} + {nw} = {nx + nw})"
        )
    if ny + nh > 1.001:
        raise HTTPException(
            status_code=400,
            detail=f"ny + nh must not exceed 1 (got {ny} + {nh} = {ny + nh})"
        )


def ensure_unique_order_index(marks: List[Dict[str, Any]]) -> None:
    """
    Ensure all marks have unique order_index values.
    
    Args:
        marks: List of mark dictionaries with 'order_index' field
        
    Raises:
        HTTPException: 400 if duplicate order_index found
    """
    seen_indices = set()
    duplicates = []
    
    for mark in marks:
        order_idx = mark.get("order_index")
        if order_idx in seen_indices:
            duplicates.append(order_idx)
        seen_indices.add(order_idx)
    
    if duplicates:
        raise HTTPException(
            status_code=400,
            detail=f"Duplicate order_index values found: {sorted(set(duplicates))}"
        )


def validate_page_dims(dims: List[Dict[str, Any]]) -> None:
    """
    Validate page dimensions for consistency and correctness.
    
    Rules:
    - All page indices must be unique
    - Width and height must be positive
    - Rotation must be in {0, 90, 180, 270}
    
    Args:
        dims: List of page dimension dictionaries
        
    Raises:
        HTTPException: 400 if validation fails
    """
    seen_indices = set()
    
    for dim in dims:
        idx = dim.get("idx")
        width = dim.get("width_pt")
        height = dim.get("height_pt")
        rotation = dim.get("rotation_deg", 0)
        
        # Check for duplicate indices
        if idx in seen_indices:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate page index: {idx}"
            )
        seen_indices.add(idx)
        
        # Validate dimensions
        if width is None or width <= 0:
            raise HTTPException(
                status_code=400,
                detail=f"Page {idx}: width_pt must be positive, got {width}"
            )
        if height is None or height <= 0:
            raise HTTPException(
                status_code=400,
                detail=f"Page {idx}: height_pt must be positive, got {height}"
            )
        
        # Validate rotation
        if rotation not in (0, 90, 180, 270):
            raise HTTPException(
                status_code=400,
                detail=f"Page {idx}: rotation_deg must be 0, 90, 180, or 270, got {rotation}"
            )


def coerce_anchor(anchor: str | None) -> str:
    """
    Coerce anchor value to one of the allowed values.
    
    Args:
        anchor: Raw anchor value
        
    Returns:
        Coerced anchor value: "auto", "center", or "top-left"
    """
    if not anchor:
        return "auto"
    
    anchor_lower = anchor.lower().strip()
    
    if anchor_lower in ("auto", "center", "top-left"):
        return anchor_lower
    
    # Default to auto for invalid values
    return "auto"