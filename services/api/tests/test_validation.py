"""
Tests for validation functions.

Run with: pytest tests/test_validation.py -v
"""
import pytest
from fastapi import HTTPException

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.validation import (
    validate_normalized_rect,
    ensure_unique_order_index,
    validate_page_dims,
    coerce_anchor
)


class TestValidateNormalizedRect:
    """Tests for normalized rectangle validation."""
    
    def test_valid_rect(self):
        """Valid rectangle should not raise."""
        validate_normalized_rect(0.1, 0.1, 0.5, 0.5)
        validate_normalized_rect(0, 0, 1, 1)
        validate_normalized_rect(0.5, 0.5, 0.5, 0.5)
    
    def test_invalid_nx(self):
        """nx out of range should raise."""
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(-0.1, 0.1, 0.5, 0.5)
        assert exc.value.status_code == 400
        
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(1.1, 0.1, 0.5, 0.5)
        assert exc.value.status_code == 400
    
    def test_invalid_ny(self):
        """ny out of range should raise."""
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, -0.1, 0.5, 0.5)
        assert exc.value.status_code == 400
        
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 1.1, 0.5, 0.5)
        assert exc.value.status_code == 400
    
    def test_invalid_nw(self):
        """nw out of range should raise."""
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 0.1, 0, 0.5)
        assert exc.value.status_code == 400
        
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 0.1, 1.1, 0.5)
        assert exc.value.status_code == 400
    
    def test_invalid_nh(self):
        """nh out of range should raise."""
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 0.1, 0.5, 0)
        assert exc.value.status_code == 400
        
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 0.1, 0.5, 1.1)
        assert exc.value.status_code == 400
    
    def test_exceeds_page_bounds(self):
        """Rectangle extending beyond page should raise."""
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.9, 0.1, 0.2, 0.5)  # nx + nw > 1
        assert exc.value.status_code == 400
        
        with pytest.raises(HTTPException) as exc:
            validate_normalized_rect(0.1, 0.9, 0.5, 0.2)  # ny + nh > 1
        assert exc.value.status_code == 400


class TestEnsureUniqueOrderIndex:
    """Tests for order_index uniqueness validation."""
    
    def test_unique_indices(self):
        """Unique order indices should not raise."""
        marks = [
            {"order_index": 0},
            {"order_index": 1},
            {"order_index": 2}
        ]
        ensure_unique_order_index(marks)
    
    def test_duplicate_indices(self):
        """Duplicate order indices should raise."""
        marks = [
            {"order_index": 0},
            {"order_index": 1},
            {"order_index": 1}
        ]
        with pytest.raises(HTTPException) as exc:
            ensure_unique_order_index(marks)
        assert exc.value.status_code == 400
        assert "Duplicate" in str(exc.value.detail)
    
    def test_empty_list(self):
        """Empty list should not raise."""
        ensure_unique_order_index([])


class TestValidatePageDims:
    """Tests for page dimensions validation."""
    
    def test_valid_dims(self):
        """Valid page dimensions should not raise."""
        dims = [
            {"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
            {"idx": 1, "width_pt": 612, "height_pt": 792, "rotation_deg": 90}
        ]
        validate_page_dims(dims)
    
    def test_duplicate_index(self):
        """Duplicate page indices should raise."""
        dims = [
            {"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
            {"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 0}
        ]
        with pytest.raises(HTTPException) as exc:
            validate_page_dims(dims)
        assert exc.value.status_code == 400
        assert "Duplicate" in str(exc.value.detail)
    
    def test_invalid_width(self):
        """Invalid width should raise."""
        dims = [{"idx": 0, "width_pt": 0, "height_pt": 792, "rotation_deg": 0}]
        with pytest.raises(HTTPException) as exc:
            validate_page_dims(dims)
        assert exc.value.status_code == 400
    
    def test_invalid_height(self):
        """Invalid height should raise."""
        dims = [{"idx": 0, "width_pt": 612, "height_pt": -10, "rotation_deg": 0}]
        with pytest.raises(HTTPException) as exc:
            validate_page_dims(dims)
        assert exc.value.status_code == 400
    
    def test_invalid_rotation(self):
        """Invalid rotation should raise."""
        dims = [{"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 45}]
        with pytest.raises(HTTPException) as exc:
            validate_page_dims(dims)
        assert exc.value.status_code == 400


class TestCoerceAnchor:
    """Tests for anchor value coercion."""
    
    def test_valid_anchors(self):
        """Valid anchor values should be returned as-is."""
        assert coerce_anchor("auto") == "auto"
        assert coerce_anchor("center") == "center"
        assert coerce_anchor("top-left") == "top-left"
    
    def test_case_insensitive(self):
        """Anchor coercion should be case-insensitive."""
        assert coerce_anchor("AUTO") == "auto"
        assert coerce_anchor("Center") == "center"
        assert coerce_anchor("TOP-LEFT") == "top-left"
    
    def test_invalid_anchor(self):
        """Invalid anchor should default to auto."""
        assert coerce_anchor("invalid") == "auto"
        assert coerce_anchor("bottom-right") == "auto"
    
    def test_none_anchor(self):
        """None anchor should default to auto."""
        assert coerce_anchor(None) == "auto"