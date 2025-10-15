"""
Google Sheets storage adapter stub for PDF Markbook.
This is a placeholder for future implementation.

Expected sheet structure:
- "Documents" sheet: doc_id, pdf_url, page_count, created_by, created_at, updated_at
- "Pages" sheet: page_id, doc_id, idx, width_pt, height_pt, rotation_deg
- "MarkSets" sheet: mark_set_id, doc_id, label, is_active, created_by, created_at
- "Marks" sheet: mark_id, mark_set_id, page_id, order_index, name, nx, ny, nw, nh, zoom_hint, padding_pct, anchor, created_at

Implementation notes:
- Use gspread library with service account authentication
- Implement exponential backoff for rate limiting
- Use batch operations where possible to minimize API calls
- Cache sheet data locally with TTL to reduce reads
- Consider using append operations for inserts (more efficient than individual cell updates)
- Handle concurrent writes carefully (check for conflicts)
"""
from typing import List, Dict, Any, Optional


class SheetsAdapter:
    """
    Google Sheets storage adapter (stub implementation).
    
    To implement this adapter:
    1. Install: pip install gspread google-auth
    2. Set up service account credentials
    3. Share the spreadsheet with the service account email
    4. Implement retry logic with exponential backoff
    5. Consider caching strategies to minimize API calls
    """
    
    def __init__(self, service_account_json: str, spreadsheet_id: str):
        """
        Initialize the Sheets adapter.
        
        Args:
            service_account_json: JSON string or path to service account credentials
            spreadsheet_id: Google Sheets spreadsheet ID
        """
        self.service_account_json = service_account_json
        self.spreadsheet_id = spreadsheet_id
        raise NotImplementedError(
            "Google Sheets adapter is not yet implemented. "
            "Use STORAGE_BACKEND=sqlite or json for now."
        )
    
    def create_document(self, pdf_url: str, created_by: Optional[str] = None) -> str:
        """Create a new document in the Documents sheet."""
        raise NotImplementedError("SheetsAdapter.create_document not implemented")
    
    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]]
    ) -> None:
        """Bootstrap pages for a document in the Pages sheet."""
        raise NotImplementedError("SheetsAdapter.bootstrap_pages not implemented")
    
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks: List[Dict[str, Any]],
        created_by: Optional[str] = None
    ) -> str:
        """Create a new mark set with all its marks in MarkSets and Marks sheets."""
        raise NotImplementedError("SheetsAdapter.create_mark_set not implemented")
    
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """List all marks in a mark set, joined with page data."""
        raise NotImplementedError("SheetsAdapter.list_marks not implemented")
    
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Partially update a mark's display preferences."""
        raise NotImplementedError("SheetsAdapter.patch_mark not implemented")
    
    def activate_mark_set(self, mark_set_id: str) -> None:
        """Activate a mark set and deactivate all others for the same document."""
        raise NotImplementedError("SheetsAdapter.activate_mark_set not implemented")