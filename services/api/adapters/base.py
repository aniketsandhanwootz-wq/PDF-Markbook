"""
Storage adapter interface for PDF Markbook.
Defines the contract that all storage backends must implement.
"""
from typing import Protocol, List, Dict, Any, Optional


class StorageAdapter(Protocol):
    """
    Protocol defining the interface for all storage adapters.
    
    This allows swapping between SQLite, Google Sheets, PostgreSQL, etc.
    without changing the router or business logic code.
    """
    
    def create_document(self, pdf_url: str, created_by: Optional[str] = None) -> str:
        """
        Create a new document.
        
        Args:
            pdf_url: URL of the PDF document
            created_by: Optional user ID of creator
            
        Returns:
            Generated document ID
        """
        ...
    
    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]]
    ) -> None:
        """
        Bootstrap pages for a document.
        
        Args:
            doc_id: Document ID
            page_count: Total number of pages
            dims: List of page dimensions, each with:
                - idx: 0-based page index
                - width_pt: Page width in points
                - height_pt: Page height in points
                - rotation_deg: Page rotation (0, 90, 180, 270)
                
        Raises:
            HTTPException: 409 if pages already exist for this document
        """
        ...
    
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks: List[Dict[str, Any]],
        created_by: Optional[str] = None
    ) -> str:
        """
        Create a new mark set with all its marks.
        
        Args:
            doc_id: Document ID
            label: Version label for the mark set
            marks: List of mark dictionaries with fields:
                - page_index: 0-based page index
                - order_index: Sequential navigation order
                - name: User-friendly label
                - nx, ny, nw, nh: Normalized coordinates
                - zoom_hint: Optional custom zoom
                - padding_pct: Padding percentage
                - anchor: Zoom anchor point
            created_by: Optional user ID of creator
            
        Returns:
            Generated mark set ID
            
        Raises:
            HTTPException: 400 for validation errors, 404 if document not found
        """
        ...
    
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """
        List all marks in a mark set, ordered by order_index.
        
        Args:
            mark_set_id: Mark set ID
            
        Returns:
            List of mark dictionaries with fields:
                - mark_id
                - page_index (joined from pages table)
                - order_index
                - name
                - nx, ny, nw, nh
                - zoom_hint
                - padding_pct
                - anchor
                
        Raises:
            HTTPException: 404 if mark set not found
        """
        ...
    
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Partially update a mark's display preferences.
        
        Args:
            mark_id: Mark ID
            data: Dictionary with optional fields:
                - zoom_hint
                - padding_pct
                - anchor
                
        Returns:
            Updated mark dictionary
            
        Raises:
            HTTPException: 404 if mark not found
        """
        ...
    
    def activate_mark_set(self, mark_set_id: str) -> None:
        """
        Activate a mark set (and deactivate all others for the same document).
        
        Args:
            mark_set_id: Mark set ID to activate
            
        Raises:
            HTTPException: 404 if mark set not found
        """
        ...