"""
PDF Mark System - Production Backend API
FastAPI with multiple storage backends: SQLite and Google Sheets (4-Tab Full Schema)

Install dependencies:
pip install fastapi uvicorn sqlalchemy pydantic python-multipart cachetools gspread google-auth

Run server:
uvicorn main:app --host 0.0.0.0 --port 8000
"""

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator  # ✅ NEW
from typing import List, Optional
from sqlalchemy import create_engine, Column, String, Integer, Float, ForeignKey, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from cachetools import TTLCache
import uuid
import logging
import os
from typing import Optional
import time
import contextvars
from collections import defaultdict

# ========== NEW: Request Context for Tracing ==========
request_id_var = contextvars.ContextVar('request_id', default=None)
request_start_time_var = contextvars.ContextVar('request_start_time', default=None)

# ========== NEW: Metrics Storage ==========
request_metrics = {
    "total_requests": defaultdict(int),  # by endpoint
    "total_latency": defaultdict(float),  # by endpoint
    "status_codes": defaultdict(int),  # by status code
    "cache_hits": 0,
    "cache_misses": 0,
    "sheets_calls": 0,
}
# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# BACKEND CONFIGURATION
# ============================================================================

STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "sqlite").lower()
GOOGLE_SA_JSON_PATH = os.getenv("GOOGLE_SA_JSON", None)
SHEETS_SPREADSHEET_ID = os.getenv("SHEETS_SPREADSHEET_ID", None)
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./marks.db")

logger.info(f"🔧 Storage Backend: {STORAGE_BACKEND.upper()}")

# ============================================================================
# STORAGE ADAPTER INITIALIZATION
# ============================================================================

storage_adapter = None

if STORAGE_BACKEND == "sheets":
    try:
        from adapters.sheets import SheetsAdapter
        
        if not GOOGLE_SA_JSON_PATH or not SHEETS_SPREADSHEET_ID:
            raise ValueError("Google Sheets requires GOOGLE_SA_JSON and SHEETS_SPREADSHEET_ID")
        
        logger.info(f"Initializing Google Sheets adapter...")
        storage_adapter = SheetsAdapter(
            google_sa_json=GOOGLE_SA_JSON_PATH,
            spreadsheet_id=SHEETS_SPREADSHEET_ID
        )
        logger.info(f"✓ Google Sheets adapter initialized (4-tab schema)")
        
    except Exception as e:
        logger.error(f"✗ Failed to initialize Google Sheets: {e}")
        raise

elif STORAGE_BACKEND == "sqlite":
    # SQLite setup (original 2-tab simplified version)
    if DATABASE_URL.startswith("sqlite"):
        engine = create_engine(
            DATABASE_URL,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            echo=False
        )
    else:
        engine = create_engine(
            DATABASE_URL,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            pool_recycle=3600,
            echo=False
        )

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_conn, connection_record):
        if DATABASE_URL.startswith("sqlite"):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.close()

    class MarkSetDB(Base):
        __tablename__ = "mark_sets"
        id = Column(String, primary_key=True, index=True)
        pdf_url = Column(String, nullable=False)
        name = Column(String, nullable=False)

    class MarkDB(Base):
        __tablename__ = "marks"
        mark_id = Column(String, primary_key=True, index=True)
        mark_set_id = Column(String, ForeignKey("mark_sets.id"), nullable=False, index=True)
        page_index = Column(Integer, nullable=False)
        order_index = Column(Integer, nullable=False)
        name = Column(String, nullable=False)
        nx = Column(Float, nullable=False)
        ny = Column(Float, nullable=False)
        nw = Column(Float, nullable=False)
        nh = Column(Float, nullable=False)
        zoom_hint = Column(Float, nullable=True)

    Base.metadata.create_all(bind=engine)

    @contextmanager
    def get_db():
        db = SessionLocal()
        try:
            yield db
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Database error: {str(e)}")
            raise
        finally:
            db.close()

else:
    raise ValueError(f"Unknown STORAGE_BACKEND: {STORAGE_BACKEND}")

# ============================================================================
# CACHE
# ============================================================================

mark_cache = TTLCache(maxsize=100, ttl=300)

# ============================================================================
# PYDANTIC MODELS
# ============================================================================


class Mark(BaseModel):
    mark_id: Optional[str] = None
    page_index: int = Field(ge=0, description="Page index (0-based)")
    order_index: int = Field(ge=0, description="Display order")
    name: str = Field(min_length=1, max_length=200, description="Mark name")
    
    # ✨ ENHANCED: Stricter bounds (must be > 0, not >= 0)
    nx: float = Field(ge=0.0, le=1.0, description="Normalized X (0-1)")
    ny: float = Field(ge=0.0, le=1.0, description="Normalized Y (0-1)")
    nw: float = Field(gt=0.0, le=1.0, description="Normalized width (must be > 0)")
    nh: float = Field(gt=0.0, le=1.0, description="Normalized height (must be > 0)")
    
    zoom_hint: Optional[float] = Field(None, ge=0.25, le=6.0, description="Zoom level")

    @field_validator('name')
    @classmethod
    def name_not_empty(cls, v):
        """Validate name is not empty."""
        if not v or not v.strip():
            raise ValueError('Name cannot be empty')
        return v.strip()
    
    @model_validator(mode='after')
    def validate_mark_bounds(self):
        """
        ✨ Pydantic V2: Validate mark stays within page bounds and has minimum size.
        Uses model_validator instead of field validator with 'values'.
        """
        # Check right edge
        if self.nx + self.nw > 1.0001:  # Small tolerance for floating point
            raise ValueError(
                f'Mark extends beyond page width: '
                f'nx({self.nx:.4f}) + nw({self.nw:.4f}) = {self.nx + self.nw:.4f} > 1.0'
            )
        
        # Check bottom edge
        if self.ny + self.nh > 1.0001:
            raise ValueError(
                f'Mark extends beyond page height: '
                f'ny({self.ny:.4f}) + nh({self.nh:.4f}) = {self.ny + self.nh:.4f} > 1.0'
            )
        
        # Check minimum area (prevent invisible marks)
        area = self.nw * self.nh
        if area < 0.00001:  # Minimum area
            raise ValueError(
                f'Mark area too small ({area:.6f}). '
                f'Mark would be invisible or unclickable.'
            )
        
        return self

class MarkSet(BaseModel):
    id: str
    pdf_url: str
    name: str

class MarkSetCreate(BaseModel):
    pdf_url: str = Field(min_length=1, max_length=2000, description="PDF URL")
    name: str = Field(min_length=1, max_length=200, description="Mark set name")

    @field_validator('pdf_url')  # ✅ NEW - Pydantic V2
    @classmethod
    def validate_url(cls, v):
        if not v or not v.strip():
            raise ValueError('PDF URL cannot be empty')
        if not (v.startswith('http://') or v.startswith('https://')):
            raise ValueError('PDF URL must start with http:// or https://')
        return v.strip()

    @field_validator('name')  # ✅ NEW - Pydantic V2
    @classmethod
    def name_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Name cannot be empty')
        return v.strip()
# ============================================================================
# STORAGE OPERATIONS (Works with both backends)
# ============================================================================

def storage_create_mark_set(pdf_url: str, name: str) -> str:
    """Create a mark set in the configured storage backend."""
    new_id = str(uuid.uuid4())
    
    if STORAGE_BACKEND == "sqlite":
        with get_db() as db:
            db_mark_set = MarkSetDB(id=new_id, pdf_url=pdf_url, name=name)
            db.add(db_mark_set)
            db.flush()
    
    elif STORAGE_BACKEND == "sheets":
        # For sheets, we need to create document first, then mark_set
        # Simplified: Just create mark_set with embedded PDF URL
        doc_id = storage_adapter.create_document(pdf_url=pdf_url, created_by=None)
        new_id = storage_adapter.create_mark_set(
            doc_id=doc_id,
            label=name,
            created_by=None,
            marks=[]  # Empty initially
        )
    
    return new_id

def storage_list_mark_sets() -> List[MarkSet]:
    """List all mark sets from the configured storage backend."""
    if STORAGE_BACKEND == "sqlite":
        with get_db() as db:
            mark_sets = db.query(MarkSetDB).all()
            return [MarkSet(id=ms.id, pdf_url=ms.pdf_url, name=ms.name) for ms in mark_sets]
    
    elif STORAGE_BACKEND == "sheets":
        # Get all mark_sets and join with documents to get PDF URL
        mark_sets_data = storage_adapter._get_all_dicts("mark_sets")
        documents_data = storage_adapter._get_all_dicts("documents")
        
        doc_map = {d["doc_id"]: d for d in documents_data}
        
        result = []
        for ms in mark_sets_data:
            doc = doc_map.get(ms["doc_id"])
            if doc:
                result.append(MarkSet(
                    id=ms["mark_set_id"],
                    pdf_url=doc["pdf_url"],
                    name=ms["label"]
                ))
        return result

def storage_get_marks(mark_set_id: str) -> List[Mark]:
    """Get all marks for a mark set from the configured storage backend."""
    if STORAGE_BACKEND == "sqlite":
        with get_db() as db:
            mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
            if not mark_set:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            
            marks = db.query(MarkDB).filter(
                MarkDB.mark_set_id == mark_set_id
            ).order_by(MarkDB.order_index).all()
            
            return [
                Mark(
                    mark_id=m.mark_id, page_index=m.page_index, order_index=m.order_index,
                    name=m.name, nx=m.nx, ny=m.ny, nw=m.nw, nh=m.nh, zoom_hint=m.zoom_hint
                ) for m in marks
            ]
    
    elif STORAGE_BACKEND == "sheets":
        try:
            marks_data = storage_adapter.list_marks(mark_set_id)
            return [Mark(**m) for m in marks_data]
        except ValueError as e:
            if "MARK_SET_NOT_FOUND" in str(e):
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            raise
def compute_mark_diff(existing_marks: List[Mark], new_marks: List[Mark]) -> dict:
    """
    Compute diff between existing and new marks.
    Returns: {
        'to_add': [marks],
        'to_update': [marks],
        'to_delete': [mark_ids],
        'unchanged': count
    }
    """
    # Build lookup maps
    existing_map = {m.mark_id: m for m in existing_marks if m.mark_id}
    new_map = {m.mark_id: m for m in new_marks if m.mark_id and not m.mark_id.startswith('temp-')}
    
    to_add = []
    to_update = []
    to_delete = []
    unchanged = 0
    
    # Find marks to add (new marks without IDs or with temp IDs)
    for mark in new_marks:
        if not mark.mark_id or mark.mark_id.startswith('temp-'):
            to_add.append(mark)
        elif mark.mark_id not in existing_map:
            to_add.append(mark)
    
    # Find marks to update or keep unchanged
    for mark in new_marks:
        if mark.mark_id and not mark.mark_id.startswith('temp-') and mark.mark_id in existing_map:
            existing = existing_map[mark.mark_id]
            
            # Check if mark changed
            if (existing.page_index != mark.page_index or
                existing.order_index != mark.order_index or
                existing.name != mark.name or
                abs(existing.nx - mark.nx) > 0.0001 or
                abs(existing.ny - mark.ny) > 0.0001 or
                abs(existing.nw - mark.nw) > 0.0001 or
                abs(existing.nh - mark.nh) > 0.0001 or
                existing.zoom_hint != mark.zoom_hint):
                to_update.append(mark)
            else:
                unchanged += 1
    
    # Find marks to delete (in existing but not in new)
    for mark_id in existing_map:
        if mark_id not in new_map:
            to_delete.append(mark_id)
    
    return {
        'to_add': to_add,
        'to_update': to_update,
        'to_delete': to_delete,
        'unchanged': unchanged
    }


def storage_replace_marks_delta(mark_set_id: str, marks: List[Mark]) -> dict:
    """
    Replace marks using delta algorithm - only update changed marks.
    Returns statistics about the operation.
    """
    if STORAGE_BACKEND == "sqlite":
        # For SQLite, use existing full replace (it's fast enough)
        deleted = storage_replace_marks(mark_set_id, marks)
        return {
            "added": len(marks),
            "updated": 0,
            "deleted": deleted,
            "unchanged": 0,
            "method": "full_replace"
        }
    
    elif STORAGE_BACKEND == "sheets":
        # Get existing marks
        try:
            existing_marks = storage_get_marks(mark_set_id)
        except HTTPException:
            # Mark set doesn't exist, create all marks
            deleted = storage_replace_marks(mark_set_id, marks)
            return {
                "added": len(marks),
                "updated": 0,
                "deleted": 0,
                "unchanged": 0,
                "method": "initial_create"
            }
        
        # Compute diff
        diff = compute_mark_diff(existing_marks, marks)
        
        # If more than 50% changed, use full replace (more efficient)
        total_ops = len(diff['to_add']) + len(diff['to_update']) + len(diff['to_delete'])
        if total_ops > len(existing_marks) * 0.5:
            logger.info(f"Delta save: {total_ops} changes > 50% of {len(existing_marks)} marks, using full replace")
            deleted = storage_replace_marks(mark_set_id, marks)
            return {
                "added": len(marks),
                "updated": 0,
                "deleted": deleted,
                "unchanged": 0,
                "method": "full_replace_threshold"
            }
        
        # Apply delta changes
        logger.info(
            f"Delta save: add={len(diff['to_add'])}, "
            f"update={len(diff['to_update'])}, "
            f"delete={len(diff['to_delete'])}, "
            f"unchanged={diff['unchanged']}"
        )
        
        # Get mark_set info
        mark_sets_data = storage_adapter._get_all_dicts("mark_sets")
        mark_set = next((ms for ms in mark_sets_data if ms["mark_set_id"] == mark_set_id), None)
        
        if not mark_set:
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
        
        doc_id = mark_set["doc_id"]
        existing_pages = storage_adapter._pages_for_doc(doc_id)
        page_index_to_id = {p["idx"]: p["page_id"] for p in existing_pages}
        
        # Get all marks
        all_marks = storage_adapter._get_all_dicts("marks")
        
        # Build new marks list
        header_marks = ["mark_id", "mark_set_id", "page_id", "order_index", "name", 
                       "nx", "ny", "nw", "nh", "zoom_hint", "padding_pct", "anchor"]
        
        new_marks_data = [header_marks]
        
        # Keep marks from other mark_sets
        for m in all_marks:
            if m.get("mark_set_id") != mark_set_id:
                new_marks_data.append([
                    m.get("mark_id", ""), m.get("mark_set_id", ""), m.get("page_id", ""),
                    m.get("order_index", ""), m.get("name", ""),
                    m.get("nx", ""), m.get("ny", ""), m.get("nw", ""), m.get("nh", ""),
                    m.get("zoom_hint", ""), m.get("padding_pct", ""), m.get("anchor", "")
                ])
        
        # Add marks from this mark_set (excluding deleted ones)
        existing_mark_ids = {m.mark_id for m in existing_marks if m.mark_id}
        delete_ids = set(diff['to_delete'])
        
        # Keep unchanged marks
        for mark in existing_marks:
            if mark.mark_id and mark.mark_id not in delete_ids and mark.mark_id not in {m.mark_id for m in diff['to_update']}:
                page_id = page_index_to_id.get(mark.page_index)
                if page_id:
                    new_marks_data.append([
                        mark.mark_id, mark_set_id, page_id, mark.order_index, mark.name,
                        mark.nx, mark.ny, mark.nw, mark.nh,
                        mark.zoom_hint if mark.zoom_hint is not None else "",
                        0.1, "auto"
                    ])
        
        # Add updated marks
        for mark in diff['to_update']:
            page_id = page_index_to_id.get(mark.page_index)
            if page_id:
                new_marks_data.append([
                    mark.mark_id, mark_set_id, page_id, mark.order_index, mark.name,
                    mark.nx, mark.ny, mark.nw, mark.nh,
                    mark.zoom_hint if mark.zoom_hint is not None else "",
                    0.1, "auto"
                ])
        
        # Add new marks
        for mark in diff['to_add']:
            mark_id = str(uuid.uuid4())
            page_id = page_index_to_id.get(mark.page_index)
            if page_id:
                new_marks_data.append([
                    mark_id, mark_set_id, page_id, mark.order_index, mark.name,
                    mark.nx, mark.ny, mark.nw, mark.nh,
                    mark.zoom_hint if mark.zoom_hint is not None else "",
                    0.1, "auto"
                ])
        
        # Write back to sheet
        storage_adapter.ws["marks"].clear()
        storage_adapter.ws["marks"].update('A1', new_marks_data)
        
        # Invalidate cache
        storage_adapter._invalidate_marks_cache(mark_set_id)
        
        return {
            "added": len(diff['to_add']),
            "updated": len(diff['to_update']),
            "deleted": len(diff['to_delete']),
            "unchanged": diff['unchanged'],
            "method": "delta"
        }
def storage_replace_marks(mark_set_id: str, marks: List[Mark]) -> int:
    """Replace all marks for a mark set in the configured storage backend."""
    deleted_count = 0
    
    if STORAGE_BACKEND == "sqlite":
        with get_db() as db:
            mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
            if not mark_set:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            
            deleted_count = db.query(MarkDB).filter(MarkDB.mark_set_id == mark_set_id).delete()
            
            for mark in marks:
                mark_id = mark.mark_id if mark.mark_id and not mark.mark_id.startswith('temp-') else str(uuid.uuid4())
                db_mark = MarkDB(
                    mark_id=mark_id, mark_set_id=mark_set_id, page_index=mark.page_index,
                    order_index=mark.order_index, name=mark.name, nx=mark.nx, ny=mark.ny,
                    nw=mark.nw, nh=mark.nh, zoom_hint=mark.zoom_hint
                )
                db.add(db_mark)
            db.flush()
    
    elif STORAGE_BACKEND == "sheets":
        import time
        
        # Step 1: Get the mark_set to find its doc_id
        mark_sets_data = storage_adapter._get_all_dicts("mark_sets")
        mark_set = next((ms for ms in mark_sets_data if ms["mark_set_id"] == mark_set_id), None)
        
        if not mark_set:
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
        
        doc_id = mark_set["doc_id"]
        
        # Step 2: Get existing pages for this document
        existing_pages = storage_adapter._pages_for_doc(doc_id)
        page_index_to_id = {p["idx"]: p["page_id"] for p in existing_pages}
        
        # Step 3: Find all unique page indices needed by the marks
        needed_page_indices = set(mark.page_index for mark in marks)
        
        # Step 4: Bootstrap any missing pages with default dimensions
        for page_idx in needed_page_indices:
            if page_idx not in page_index_to_id:
                logger.info(f"Bootstrapping page {page_idx} for document {doc_id}")
                
                # Double-check if page already exists (in case cache is stale)
                all_pages = storage_adapter._get_all_dicts("pages")
                existing_page = next(
                    (p for p in all_pages if p["doc_id"] == doc_id and int(p["idx"]) == page_idx),
                    None
                )
                
                if existing_page:
                    # Page exists, just update our mapping
                    page_index_to_id[page_idx] = existing_page["page_id"]
                    logger.info(f"Page {page_idx} already exists with ID {existing_page['page_id']}")
                else:
                    # Create new page
                    page_id = str(uuid.uuid4())
                    storage_adapter._append_rows("pages", [[
                        page_id,
                        doc_id,
                        page_idx,
                        612.0,   # Standard Letter width
                        792.0,   # Standard Letter height
                        0        # No rotation
                    ]])
                    
                    page_index_to_id[page_idx] = page_id
                    
                    # Clear the cache so next call gets fresh data
                    storage_adapter._pages_by_doc_cache.pop(doc_id, None)
                    
                    logger.info(f"Created new page {page_idx} with ID {page_id}")
        
        # Step 5: Get all existing marks
        all_marks = storage_adapter._get_all_dicts("marks")
        existing_marks_for_set = [m for m in all_marks if m.get("mark_set_id") == mark_set_id]
        deleted_count = len(existing_marks_for_set)
        
        # Step 6: Delete old marks for this mark_set
        header_marks = ["mark_id", "mark_set_id", "page_id", "order_index", "name", 
                       "nx", "ny", "nw", "nh", "zoom_hint", "padding_pct", "anchor"]
        
        filtered_marks = [header_marks]
        for m in all_marks:
            if m.get("mark_set_id") != mark_set_id:
                # Keep marks from other mark_sets
                filtered_marks.append([
                    m.get("mark_id", ""),
                    m.get("mark_set_id", ""),
                    m.get("page_id", ""),
                    m.get("order_index", ""),
                    m.get("name", ""),
                    m.get("nx", ""),
                    m.get("ny", ""),
                    m.get("nw", ""),
                    m.get("nh", ""),
                    m.get("zoom_hint", ""),
                    m.get("padding_pct", ""),
                    m.get("anchor", "")
                ])
        
        # Step 7: Add new marks
        for mark in marks:
            mark_id = mark.mark_id if mark.mark_id and not mark.mark_id.startswith('temp-') else str(uuid.uuid4())
            
            # Get the page_id for this page_index
            page_id = page_index_to_id.get(mark.page_index)
            
            if not page_id:
                logger.error(f"Could not find page_id for page_index {mark.page_index}")
                continue
            
            # Add the mark row
            filtered_marks.append([
                mark_id,
                mark_set_id,
                page_id,
                mark.order_index,
                mark.name,
                mark.nx,
                mark.ny,
                mark.nw,
                mark.nh,
                mark.zoom_hint if mark.zoom_hint is not None else "",
                0.1,  # padding_pct default
                "auto"  # anchor default
            ])
            
            logger.info(f"Added mark '{mark.name}' with ID {mark_id} on page {mark.page_index}")
        
        # Step 8: Write everything back to the marks sheet
        storage_adapter.ws["marks"].clear()
        storage_adapter.ws["marks"].update('A1', filtered_marks)
        
        logger.info(f"Replaced {deleted_count} marks with {len(marks)} new marks in Google Sheets")
        
        # Step 9: Update document's updated_at timestamp
        current_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        
        # Find the document row
        doc_row_idx = storage_adapter._find_row_by_value("documents", "doc_id", doc_id)
        
        if doc_row_idx:
            # Update the updated_at column
            storage_adapter._update_cells("documents", doc_row_idx, {
                "updated_at": current_timestamp
            })
            logger.info(f"Updated document {doc_id} timestamp to {current_timestamp}")
        
        # Clear document cache
        storage_adapter._doc_cache.pop(doc_id, None)
    
    return deleted_count

def storage_delete_mark_set(mark_set_id: str) -> int:
    """Delete a mark set and all its marks from the configured storage backend."""
    marks_deleted = 0
    
    if STORAGE_BACKEND == "sqlite":
        with get_db() as db:
            marks_deleted = db.query(MarkDB).filter(MarkDB.mark_set_id == mark_set_id).delete()
            result = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).delete()
            if result == 0:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
    
    elif STORAGE_BACKEND == "sheets":
        # Delete marks
        all_marks = storage_adapter._get_all_dicts("marks")
        marks_deleted = sum(1 for m in all_marks if m.get("mark_set_id") == mark_set_id)
        header_marks = storage_adapter.ws["marks"].row_values(1)
        filtered_marks = [header_marks] + [
            [m[k] for k in header_marks]
            for m in all_marks
            if m.get("mark_set_id") != mark_set_id
        ]
        storage_adapter.ws["marks"].clear()
        storage_adapter.ws["marks"].update('A1', filtered_marks)
        
        # Delete mark_set
        all_sets = storage_adapter._get_all_dicts("mark_sets")
        found = any(ms.get("mark_set_id") == mark_set_id for ms in all_sets)
        if not found:
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
        
        header_sets = storage_adapter.ws["mark_sets"].row_values(1)
        filtered_sets = [header_sets] + [
            [ms[k] for k in header_sets]
            for ms in all_sets
            if ms.get("mark_set_id") != mark_set_id
        ]
        storage_adapter.ws["mark_sets"].clear()
        storage_adapter.ws["mark_sets"].update('A1', filtered_sets)
    
    return marks_deleted

# ============================================================================
# FASTAPI APP
# ============================================================================

app = FastAPI(
    title="PDF Mark System API",
    description="Backend API for PDF marking system (4-Tab Google Sheets Support)",
    version="3.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# ========== NEW: Request Tracing Middleware ==========
@app.middleware("http")
async def request_tracing_middleware(request, call_next):
    """Add request_id and timing to all requests."""
    import uuid
    
    # Generate request ID
    request_id = str(uuid.uuid4())[:8]
    request_id_var.set(request_id)
    request_start_time_var.set(time.time())
    
    # Process request
    response = await call_next(request)
    
    # Calculate latency
    latency = time.time() - request_start_time_var.get()
    
    # Log request
    logger.info(
        f"Request completed",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "latency_ms": round(latency * 1000, 2),
        }
    )
    
    # Update metrics
    endpoint = f"{request.method} {request.url.path}"
    request_metrics["total_requests"][endpoint] += 1
    request_metrics["total_latency"][endpoint] += latency
    request_metrics["status_codes"][response.status_code] += 1
    
    # Add request_id to response headers
    response.headers["X-Request-ID"] = request_id
    
    return response

# ========== NEW: Rate Limiting ==========

from collections import defaultdict
from datetime import datetime, timedelta

# Rate limit storage: {ip: {endpoint: [(timestamp, count)]}}
rate_limit_storage = defaultdict(lambda: defaultdict(list))

# Rate limits (requests per minute)
RATE_LIMITS = {
    "read": 100,   # GET requests
    "write": 20,   # POST/PUT/DELETE requests
    "default": 60,
}

def check_rate_limit(ip: str, method: str, path: str) -> tuple[bool, int]:
    """
    Check if request exceeds rate limit.
    Returns: (is_allowed, retry_after_seconds)
    """
    # Determine rate limit
    if method == "GET":
        limit = RATE_LIMITS["read"]
    elif method in ["POST", "PUT", "DELETE", "PATCH"]:
        limit = RATE_LIMITS["write"]
    else:
        limit = RATE_LIMITS["default"]
    
    # Get current timestamp
    now = datetime.now()
    one_minute_ago = now - timedelta(minutes=1)
    
    # Clean old entries
    key = f"{method}:{path}"
    rate_limit_storage[ip][key] = [
        ts for ts in rate_limit_storage[ip][key] 
        if ts > one_minute_ago
    ]
    
    # Check limit
    current_count = len(rate_limit_storage[ip][key])
    
    if current_count >= limit:
        # Calculate retry after (seconds until oldest request expires)
        oldest = min(rate_limit_storage[ip][key])
        retry_after = int((oldest - one_minute_ago).total_seconds()) + 1
        return False, retry_after
    
    # Add current request
    rate_limit_storage[ip][key].append(now)
    return True, 0


@app.middleware("http")
async def rate_limiting_middleware(request, call_next):
    """Rate limiting middleware - prevents abuse."""
    
    # Skip rate limiting for health/metrics endpoints
    if request.url.path in ["/health", "/healthz", "/readyz", "/metrics", "/docs", "/redoc", "/openapi.json"]:
        return await call_next(request)
    
    # Get client IP
    client_ip = request.client.host if request.client else "unknown"
    
    # Check rate limit
    allowed, retry_after = check_rate_limit(client_ip, request.method, request.url.path)
    
    if not allowed:
        logger.warning(f"Rate limit exceeded for {client_ip} on {request.method} {request.url.path}")
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={
                "detail": "Rate limit exceeded",
                "retry_after_seconds": retry_after
            },
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Limit": str(RATE_LIMITS.get(request.method.lower(), RATE_LIMITS["default"])),
                "X-RateLimit-Remaining": "0",
            }
        )
    
    return await call_next(request)

# ========== End of Rate Limiting ==========

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3001,http://localhost:3002").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"}
    )

# ============================================================================
# ENDPOINTS
# ============================================================================
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        if STORAGE_BACKEND == "sqlite":
            with get_db() as db:
                db.execute("SELECT 1")
        elif STORAGE_BACKEND == "sheets":
            storage_adapter.ws["mark_sets"].acell('A1')
        
        return {
            "status": "healthy",
            "backend": STORAGE_BACKEND,
            "schema": "4-tab" if STORAGE_BACKEND == "sheets" else "2-tab",
            "version": "3.0"
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "unhealthy", "backend": STORAGE_BACKEND, "error": str(e)}
        )


# ========== NEW: Production Health Endpoints ==========

@app.get("/healthz")
async def healthz():
    """
    Kubernetes-style liveness probe.
    Fast check - is the process alive and responding?
    Returns 200 if the application is running.
    """
    return {
        "status": "ok",
        "timestamp": time.time(),
        "version": "3.0"
    }


@app.get("/readyz")
async def readyz():
    """
    Kubernetes-style readiness probe.
    Checks if the application can serve traffic (database/sheets accessible).
    Returns 200 if ready, 503 if not ready.
    """
    try:
        # Test backend connectivity with timeout
        if STORAGE_BACKEND == "sqlite":
            with get_db() as db:
                db.execute("SELECT 1").fetchone()
        
        elif STORAGE_BACKEND == "sheets":
            # Quick check - read single cell
            storage_adapter.ws["mark_sets"].acell('A1')
        
        return {
            "status": "ready",
            "backend": STORAGE_BACKEND,
            "sheets_accessible": STORAGE_BACKEND == "sheets",
            "cache_size": len(mark_cache),
            "timestamp": time.time()
        }
    
    except Exception as e:
        logger.error(f"Readiness check failed: {str(e)}")
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "status": "not_ready",
                "backend": STORAGE_BACKEND,
                "error": str(e),
                "timestamp": time.time()
            }
        )

# ========== End of Health Endpoints ==========

# ========== NEW: Metrics Endpoint ==========

@app.get("/metrics")
async def get_metrics():
    """
    Get application metrics.
    Returns request counts, latencies, cache stats, and system info.
    """
    # Calculate average latencies
    avg_latencies = {}
    for endpoint, total_latency in request_metrics["total_latency"].items():
        count = request_metrics["total_requests"][endpoint]
        avg_latencies[endpoint] = round((total_latency / count) * 1000, 2) if count > 0 else 0
    
    # Cache stats
    cache_total = request_metrics["cache_hits"] + request_metrics["cache_misses"]
    cache_hit_rate = round((request_metrics["cache_hits"] / cache_total * 100), 2) if cache_total > 0 else 0
    
    return {
        "timestamp": time.time(),
        "uptime_seconds": round(time.time() - startup_time, 2),
        "backend": STORAGE_BACKEND,
        "requests": {
            "by_endpoint": dict(request_metrics["total_requests"]),
            "by_status": dict(request_metrics["status_codes"]),
            "total": sum(request_metrics["total_requests"].values()),
        },
        "latency": {
            "by_endpoint_ms": avg_latencies,
            "average_ms": round(
                sum(request_metrics["total_latency"].values()) / 
                sum(request_metrics["total_requests"].values()) * 1000, 2
            ) if sum(request_metrics["total_requests"].values()) > 0 else 0,
        },
        "cache": {
            "hits": request_metrics["cache_hits"],
            "misses": request_metrics["cache_misses"],
            "hit_rate_percent": cache_hit_rate,
            "size": len(mark_cache),
        },
        "sheets": {
            "api_calls": request_metrics["sheets_calls"],
        } if STORAGE_BACKEND == "sheets" else None,
    }

# ========== End of Metrics ==========

@app.post("/mark-sets", response_model=MarkSet, status_code=status.HTTP_201_CREATED)
async def create_mark_set(mark_set: MarkSetCreate):
    """Create a new mark set for a PDF"""
    try:
        logger.info(f"Creating mark set: {mark_set.name}")
        new_id = storage_create_mark_set(mark_set.pdf_url, mark_set.name)
        logger.info(f"Created mark set with ID: {new_id}")
        
        if "all_mark_sets" in mark_cache:
            del mark_cache["all_mark_sets"]
        
        return MarkSet(id=new_id, pdf_url=mark_set.pdf_url, name=mark_set.name)
    except Exception as e:
        logger.error(f"Error creating mark set: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to create mark set: {str(e)}")

@app.get("/mark-sets", response_model=List[MarkSet])
async def list_mark_sets():
    """List all mark sets with caching"""
    cache_key = "all_mark_sets"
    
    if cache_key in mark_cache:
        logger.info("Returning cached mark sets")
        return mark_cache[cache_key]
    
    try:
        result = storage_list_mark_sets()
        mark_cache[cache_key] = result
        logger.info(f"Fetched {len(result)} mark sets")
        return result
    except Exception as e:
        logger.error(f"Error listing mark sets: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to fetch mark sets")

@app.get("/mark-sets/{mark_set_id}/marks", response_model=List[Mark])
async def get_marks(
    mark_set_id: str,
    limit: Optional[int] = None,
    offset: Optional[int] = 0
):
    """
    Get marks for a mark set with optional pagination.
    
    Query params:
    - limit: Maximum number of marks to return (optional)
    - offset: Number of marks to skip (default: 0)
    """
    cache_key = f"marks_{mark_set_id}"
    
    # Check cache
    if cache_key in mark_cache:
        logger.info(f"Returning cached marks for {mark_set_id}")
        request_metrics["cache_hits"] += 1
        all_marks = mark_cache[cache_key]
    else:
        try:
            request_metrics["cache_misses"] += 1
            all_marks = storage_get_marks(mark_set_id)
            mark_cache[cache_key] = all_marks
            logger.info(f"Fetched {len(all_marks)} marks for set {mark_set_id}")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error fetching marks: {str(e)}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to fetch marks")
    
    # Apply pagination
    total = len(all_marks)
    
    if limit is not None:
        # Validate pagination params
        if limit < 1 or limit > 1000:
            raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")
        if offset < 0:
            raise HTTPException(status_code=400, detail="offset must be non-negative")
        
        paginated_marks = all_marks[offset:offset + limit]
        
        logger.info(f"Paginated: returning {len(paginated_marks)} of {total} marks (offset={offset}, limit={limit})")
        return paginated_marks
    
    return all_marks

@app.put("/mark-sets/{mark_set_id}/marks")
async def replace_marks(mark_set_id: str, marks: List[Mark], use_delta: bool = True):
    """
    REPLACE all marks for a mark set.
    
    Query params:
    - use_delta: Use delta algorithm for efficient updates (default: true)
    """
    if not marks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Mark list cannot be empty")
    if len(marks) > 1000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Too many marks (max 1000)")
    
    try:
        if use_delta:
            # Use delta save (60-80% fewer writes)
            stats = storage_replace_marks_delta(mark_set_id, marks)
        else:
            # Use full replace
            deleted_count = storage_replace_marks(mark_set_id, marks)
            stats = {
                "added": len(marks),
                "updated": 0,
                "deleted": deleted_count,
                "unchanged": 0,
                "method": "full_replace"
            }
        
        # Invalidate cache
        cache_key = f"marks_{mark_set_id}"
        if cache_key in mark_cache:
            del mark_cache[cache_key]
        if "all_mark_sets" in mark_cache:
            del mark_cache["all_mark_sets"]
        
        logger.info(f"Delta save: {stats}")
        return {"status": "success", "count": len(marks), **stats}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error replacing marks: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save marks")

@app.delete("/mark-sets/{mark_set_id}", status_code=status.HTTP_200_OK)
async def delete_mark_set(mark_set_id: str):
    """Delete a mark set and all its marks"""
    try:
        marks_deleted = storage_delete_mark_set(mark_set_id)
        
        cache_key = f"marks_{mark_set_id}"
        if cache_key in mark_cache:
            del mark_cache[cache_key]
        if "all_mark_sets" in mark_cache:
            del mark_cache["all_mark_sets"]
        
        logger.info(f"Deleted mark set {mark_set_id} and {marks_deleted} marks")
        return {"status": "deleted", "marks_deleted": marks_deleted}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting mark set: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to delete mark set")

@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "message": "PDF Mark System API",
        "version": "3.0",
        "backend": STORAGE_BACKEND,
        "schema": "4-tab (documents→pages→mark_sets→marks)" if STORAGE_BACKEND == "sheets" else "2-tab (mark_sets→marks)",
        "status": "running",
        "docs": "/docs"
    }

startup_time = time.time()

@app.on_event("startup")
async def startup_event():
    global startup_time
    startup_time = time.time()
    logger.info("PDF Mark System API starting up...")
    logger.info(f"Storage Backend: {STORAGE_BACKEND.upper()}")
    if STORAGE_BACKEND == "sqlite":
        logger.info(f"Database: {DATABASE_URL.split('://')[0]}")
    elif STORAGE_BACKEND == "sheets":
        logger.info(f"Spreadsheet ID: {SHEETS_SPREADSHEET_ID}")
        logger.info(f"Schema: 4-tab (documents→pages→mark_sets→marks)")
    logger.info(f"Allowed origins: {ALLOWED_ORIGINS}")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("PDF Mark System API shutting down...")
    if STORAGE_BACKEND == "sqlite":
        engine.dispose()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")