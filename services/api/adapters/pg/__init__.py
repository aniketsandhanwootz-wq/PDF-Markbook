"""
PostgreSQL storage adapter stub for PDF Markbook.
This is a placeholder for future implementation with Supabase or native Postgres.

The implementation would be very similar to the SQLite adapter,
but with PostgreSQL-specific optimizations:
- Use RETURNING clauses for efficient inserts
- Leverage PostgreSQL's native UUID type
- Use connection pooling (e.g., pgbouncer)
- Consider using asyncpg for async operations
- Implement proper transaction isolation levels
"""
from typing import List, Dict, Any, Optional


class PgAdapter:
    """
    PostgreSQL storage adapter (stub implementation).
    
    To implement this adapter:
    1. Reuse most of the SQLAlchemy code from SqliteAdapter
    2. Change the dialect to postgresql
    3. Use psycopg2 or asyncpg driver
    4. Configure connection pooling appropriately
    5. Consider using PostGIS if geographic features are needed
    6. Set up proper indexes and constraints (similar to SQLite)
    
    The schema would be nearly identical to SQLite, with these optimizations:
    - Use native UUID type instead of String
    - Use TIMESTAMPTZ for timestamps
    - Consider partitioning for large mark tables
    - Add GIN indexes if full-text search is needed
    """
    
    def __init__(self, db_url: str):
        """
        Initialize the PostgreSQL adapter.
        
        Args:
            db_url: PostgreSQL connection URL
                   (e.g., "postgresql://user:pass@host:5432/dbname")
        """
        self.db_url = db_url
        raise NotImplementedError(
            "PostgreSQL adapter is not yet implemented. "
            "Use STORAGE_BACKEND=sqlite or json for now."
        )
    
    def create_document(self, pdf_url: str, created_by: Optional[str] = None) -> str:
        """Create a new document."""
        raise NotImplementedError("PgAdapter.create_document not implemented")
    
    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]]
    ) -> None:
        """Bootstrap pages for a document."""
        raise NotImplementedError("PgAdapter.bootstrap_pages not implemented")
    
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks: List[Dict[str, Any]],
        created_by: Optional[str] = None
    ) -> str:
        """Create a new mark set with all its marks atomically."""
        raise NotImplementedError("PgAdapter.create_mark_set not implemented")
    
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """List all marks in a mark set, ordered by order_index."""
        raise NotImplementedError("PgAdapter.list_marks not implemented")
    
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Partially update a mark's display preferences."""
        raise NotImplementedError("PgAdapter.patch_mark not implemented")
    
    def activate_mark_set(self, mark_set_id: str) -> None:
        """Activate a mark set and deactivate all others for the same document."""
        raise NotImplementedError("PgAdapter.activate_mark_set not implemented")