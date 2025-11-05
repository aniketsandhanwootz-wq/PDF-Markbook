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
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
from pydantic import BaseModel, Field, field_validator, model_validator  # ✅ NEW
from typing import List, Optional
from sqlalchemy import create_engine, Column, String, Integer, Float, ForeignKey, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from cachetools import TTLCache
from schemas.document import DocumentInit, DocumentWithMarkSets
from schemas.user_input import UserInputBatchCreate
import uuid
import logging
import os
from typing import Optional
import time
import contextvars
from collections import defaultdict
from settings import get_settings
from fastapi import Body
from fastapi.responses import StreamingResponse
from typing import Dict
from core.report_pdf import generate_report_pdf  # NEW
import io

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
settings = get_settings()

STORAGE_BACKEND = settings.storage_backend.lower()
GOOGLE_SA_JSON_PATH = settings.resolved_google_sa_json()  # Uses base64 if available
SHEETS_SPREADSHEET_ID = settings.sheets_spreadsheet_id
DATABASE_URL = settings.db_url

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

mark_cache = TTLCache(maxsize=100, ttl=5)  # 5-second cache (simple and fast)

# ============================================================================
# PYDANTIC MODELS
# ============================================================================


class Mark(BaseModel):
    mark_id: Optional[str] = None
    page_index: int = Field(ge=0, description="Page index (0-based)")
    order_index: int = Field(ge=0, description="Display order")

    # ✅ name is allowed to be blank (stored as "")
    name: Optional[str] = Field(
        default=None,
        description="Mark name (optional; can be blank)"
    )

    # label is independent; used for circle badge only
    label: Optional[str] = Field(None, min_length=1, max_length=6, description="Excel-style label")

    nx: float = Field(ge=0.0, le=1.0, description="Normalized X (0–1)")
    ny: float = Field(ge=0.0, le=1.0, description="Normalized Y (0–1)")
    nw: float = Field(gt=0.0, le=1.0, description="Normalized width (>0)")
    nh: float = Field(gt=0.0, le=1.0, description="Normalized height (>0)")
    zoom_hint: Optional[float] = Field(None, ge=0.25, le=6.0, description="Zoom level")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, v: Optional[str]) -> Optional[str]:
        # allow blank; just normalize None -> "" and trim
        if v is None:
            return ""
        return v.strip()

    @field_validator("label")
    @classmethod
    def normalize_label(cls, v: Optional[str]) -> Optional[str]:
        if v == "" or (v and not v.strip()):
            return None
        return v

    @model_validator(mode='after')
    def validate_mark_bounds(self):
        if self.nx + self.nw > 1.0001:
            raise ValueError(
                f"Mark extends beyond page width: nx({self.nx:.4f}) + nw({self.nw:.4f}) = {self.nx + self.nw:.4f} > 1.0"
            )
        if self.ny + self.nh > 1.0001:
            raise ValueError(
                f"Mark extends beyond page height: ny({self.ny:.4f}) + nh({self.nh:.4f}) = {self.ny + self.nh:.4f} > 1.0"
            )
        area = self.nw * self.nh
        if area < 0.00001:
            raise ValueError(f"Mark area too small ({area:.6f}).")
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
            cleaned: list[Mark] = []
            for m in marks_data:
                try:
                    cleaned.append(Mark(**m))
                except Exception as e:
                    logger.warning(f"Skipping invalid mark in {mark_set_id}: {e}")
                    continue
            return cleaned
        except ValueError as e:
            if "MARK_SET_NOT_FOUND" in str(e):
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            raise

def storage_replace_marks(mark_set_id: str, marks: List[Mark]) -> int:
    """Replace all marks for a mark set - SIMPLIFIED VERSION."""
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
        # Get the mark_set to find its doc_id
        mark_sets_data = storage_adapter._get_all_dicts("mark_sets")
        mark_set = next((ms for ms in mark_sets_data if ms["mark_set_id"] == mark_set_id), None)
        if not mark_set:
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")

        doc_id = mark_set["doc_id"]

        # Get existing pages for this document
        existing_pages = storage_adapter._pages_for_doc(doc_id)
        page_index_to_id = {p["idx"]: p["page_id"] for p in existing_pages}

        # Bootstrap any missing pages for given marks
        needed_page_indices = set(mark.page_index for mark in marks)
        for page_idx in needed_page_indices:
            if page_idx not in page_index_to_id:
                logger.info(f"Bootstrapping page {page_idx} for document {doc_id}")
                page_id = str(uuid.uuid4())
                storage_adapter._append_rows("pages", [[
                    page_id, doc_id, page_idx, 612.0, 792.0, 0
                ]])
                page_index_to_id[page_idx] = page_id
                storage_adapter._pages_by_doc_cache.pop(doc_id, None)

        # ---- keep documents.page_count up to date (max page idx + 1) ----
        pages_now = storage_adapter._pages_for_doc(doc_id)
        max_idx = max((p["idx"] for p in pages_now), default=-1)
        computed_page_count = max_idx + 1
        doc_row_idx = storage_adapter._find_row_by_value("documents", "doc_id", doc_id)
        if doc_row_idx:
            storage_adapter._update_cells("documents", doc_row_idx, {
                "page_count": computed_page_count,
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            })

        # Get all existing marks
        all_marks = storage_adapter._get_all_dicts("marks")
        existing_marks_for_set = [m for m in all_marks if m.get("mark_set_id") == mark_set_id]
        deleted_count = len(existing_marks_for_set)

        # ---- Preserve REAL header & submission columns ----
        current_header = storage_adapter.ws["marks"].row_values(1)
        if not current_header:
            # fall back to the adapter's canonical header (already includes submission cols)
            current_header = storage_adapter.ws["marks"].get_values("1:1")[0] if storage_adapter.ws["marks"].get_values("1:1") else [
                "mark_id","mark_set_id","page_id","order_index","name","label",
                "nx","ny","nw","nh","zoom_hint","padding_pct","anchor",
                "user_value","submitted_at","submitted_by"
            ]

        # Make sure the 3 extra columns exist
        for extra in ["user_value","submitted_at","submitted_by"]:
            if extra not in current_header:
                current_header.append(extra)

        # Keep marks from other mark_sets (preserve ALL columns)
        filtered_rows = [current_header]
        for m in all_marks:
            if m.get("mark_set_id") == mark_set_id:
                continue
            row = [m.get(col, "") for col in current_header]
            filtered_rows.append(row)

        # Add new marks for this mark_set (submission columns blank)
        for mark in marks:
            mark_id = mark.mark_id if (mark.mark_id and not mark.mark_id.startswith('temp-')) else str(uuid.uuid4())
            page_id = page_index_to_id.get(mark.page_index)
            if not page_id:
                logger.error(f"Could not find page_id for page_index {mark.page_index}")
                continue

            base = {
                "mark_id": mark_id,
                "mark_set_id": mark_set_id,
                "page_id": page_id,
                "order_index": mark.order_index,
                "name": mark.name,
                "label": (mark.label or ""),
                "nx": mark.nx, "ny": mark.ny, "nw": mark.nw, "nh": mark.nh,
                "zoom_hint": (mark.zoom_hint if mark.zoom_hint is not None else ""),
                "padding_pct": 0.1,
                "anchor": "auto",
                "user_value": "",
                "submitted_at": "",
                "submitted_by": "",
            }
            filtered_rows.append([base.get(col, "") for col in current_header])
            logger.info(f"Added mark '{mark.name}' with ID {mark_id} on page {mark.page_index}")

        # Write everything back to the marks sheet
        storage_adapter.ws["marks"].clear()
        storage_adapter.ws["marks"].update('A1', filtered_rows)

        # Clear caches
        storage_adapter._doc_cache.pop(doc_id, None)
        storage_adapter._pages_by_doc_cache.pop(doc_id, None)

        logger.info(f"Replaced {deleted_count} marks with {len(marks)} new marks in Google Sheets")
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

ALLOWED_ORIGINS = settings.get_origins_list()

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
    """Get marks - with simple 5-second cache."""
    cache_key = f"marks_{mark_set_id}"
    
    # Simple 5-second cache
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
    if limit is not None:
        if limit < 1 or limit > 1000:
            raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")
        if offset < 0:
            raise HTTPException(status_code=400, detail="offset must be non-negative")
        
        paginated_marks = all_marks[offset:offset + limit]
        logger.info(f"Paginated: returning {len(paginated_marks)} of {len(all_marks)} marks")
        return paginated_marks
    
    return all_marks

@app.put("/mark-sets/{mark_set_id}/marks")
async def replace_marks(mark_set_id: str, marks: List[Mark]):
    """REPLACE all marks for a mark set - SIMPLIFIED (no delta save)."""
    if not marks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Mark list cannot be empty")
    if len(marks) > 1000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Too many marks (max 1000)")
    
    try:
        # Always use full replace (simple and reliable)
        deleted_count = storage_replace_marks(mark_set_id, marks)
        
        # Clear ALL caches
        mark_cache.clear()
        
        logger.info(f"Replaced {deleted_count} marks with {len(marks)} new marks")
        return {
            "status": "success",
            "count": len(marks),
            "deleted": deleted_count,
            "method": "full_replace"
        }
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


# ========== NEW: PDF Proxy Endpoint ==========

from fastapi.responses import StreamingResponse
import httpx

@app.get("/proxy-pdf")
async def proxy_pdf(url: str):
    """
    Proxy PDF files to avoid CORS issues.
    Supports Google Drive, ArXiv, and other PDF sources.
    """
    try:
        # Convert Google Drive URLs to direct download format
        if "drive.google.com" in url:
            # Extract file ID from various Google Drive URL formats
            if "/file/d/" in url:
                file_id = url.split("/file/d/")[1].split("/")[0].split("?")[0]
            elif "id=" in url:
                file_id = url.split("id=")[1].split("&")[0]
            elif "/folders/" in url:
                # ERROR: User provided a folder URL instead of file URL
                raise HTTPException(
                    status_code=400, 
                    detail="❌ This is a Google Drive FOLDER URL. Please provide a FILE URL instead. Right-click the file → 'Get link' → Use that URL."
                )
            else:
                raise HTTPException(status_code=400, detail="Invalid Google Drive URL format. Please use a direct file link.")
            
            # Use direct download URL
            url = f"https://drive.google.com/uc?export=download&id={file_id}"
            logger.info(f"Converted Google Drive URL to: {url}")
        
        # Fetch PDF with timeout
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            
            if response.status_code != 200:
                logger.error(f"Failed to fetch PDF: {response.status_code}")
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Failed to fetch PDF: HTTP {response.status_code}"
                )
            
            # Check if response is actually a PDF
            content_type = response.headers.get("content-type", "")
            if "pdf" not in content_type.lower() and "octet-stream" not in content_type.lower():
                logger.warning(f"URL returned non-PDF content: {content_type}")
                # Still try to serve it, might be a PDF without correct headers
            
            logger.info(f"Successfully proxied PDF from {url} ({len(response.content)} bytes)")
            
            return StreamingResponse(
                iter([response.content]),
                media_type="application/pdf",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=3600",
                    "Content-Length": str(len(response.content))
                }
            )
    
    except httpx.TimeoutException:
        logger.error(f"Timeout fetching PDF: {url}")
        raise HTTPException(status_code=504, detail="PDF fetch timeout")
    except httpx.RequestError as e:
        logger.error(f"Error fetching PDF: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch PDF: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error proxying PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {str(e)}")

# ========== End of PDF Proxy ==========
# ========== End of PDF Proxy ==========

# ========== NEW: Submissions Endpoint ==========

from pydantic import BaseModel as PydanticBaseModel

class SubmissionEntry(PydanticBaseModel):
    """Single entry in a submission"""
    mark_id: str
    value: str

class SubmissionRequest(PydanticBaseModel):
    """Request body for submitting mark values"""
    entries: dict[str, str]  # mark_id -> value

class SubmissionReportRequest(PydanticBaseModel):
    entries: dict[str, str]
    pdf_url: str | None = None
    padding_pct: float | None = 0.25
    title: str | None = "Markbook Submission"
    author: str | None = "PDF Viewer"

@app.post("/mark-sets/{mark_set_id}/submissions/report")
async def submit_and_build_report(mark_set_id: str, body: SubmissionReportRequest = Body(...)):
    """
    Save submissions and build PDF report.
    Now saves to mark_user_input table instead of marks table.
    """
    marks = storage_get_marks(mark_set_id)

    # Resolve PDF URL
    pdf_url = body.pdf_url
    if not pdf_url:
        if STORAGE_BACKEND == "sheets":
            ms_all = storage_adapter._get_all_dicts("mark_sets")
            ms = next((r for r in ms_all if r["mark_set_id"] == mark_set_id), None)
            if ms:
                doc = storage_adapter.get_document(ms["doc_id"])
                if doc:
                    pdf_url = doc.get("pdf_url")
    if not pdf_url:
        raise HTTPException(status_code=400, detail="pdf_url required")

    # Save to NEW mark_user_input table
    try:
        if STORAGE_BACKEND == "sheets" and body.entries:
            submitted_by = body.author or "viewer_user"
            storage_adapter.create_user_inputs_batch(
                mark_set_id=mark_set_id,
                entries=body.entries,
                submitted_by=submitted_by
            )
    except Exception as e:
        logger.warning(f"save to mark_user_input failed: {e}")

    # Generate report
    try:
        pdf_bytes = await generate_report_pdf(
            pdf_url=pdf_url,
            marks=[m.model_dump() if hasattr(m, "model_dump") else dict(m) for m in marks],
            entries=body.entries,
            padding_pct=body.padding_pct or 0.25,
            render_zoom=2.0,
            title=body.title,
            author=body.author,
        )
    except Exception as e:
        logger.error(f"Report generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    fname = f"submission_{mark_set_id}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )
# ========== NEW: Document Management Endpoints ==========

@app.post("/documents/init", response_model=dict, status_code=status.HTTP_201_CREATED)
async def initialize_document(data: DocumentInit):
    """
    Initialize document from Glide app.
    Checks if document exists, creates if not, returns doc_id and available marksets.
    """
    try:
        if STORAGE_BACKEND != "sheets":
            raise HTTPException(status_code=501, detail="Only supported with Google Sheets")
        
        # Check if document exists by identifier
        existing_doc = storage_adapter.get_document_by_identifier(data.id)
        
        if existing_doc:
            doc_id = existing_doc["doc_id"]
            logger.info(f"Document exists: {doc_id}")
        else:
            # TODO: Convert JPEG to PDF (for now, just use the URL as-is)
            pdf_url = data.assembly_drawing
            
            doc_id = storage_adapter.create_document(
                pdf_url=pdf_url,
                created_by=data.user_mail,
                part_number=data.part_number,
                project_name=data.project_name
            )
            logger.info(f"Created new document: {doc_id}")
        
        # Get available marksets
        marksets = storage_adapter.list_mark_sets_by_document(doc_id)
        
        return {
            "doc_id": doc_id,
            "exists": existing_doc is not None,
            "marksets": marksets,
            "markset_count": len(marksets)
        }
    except Exception as e:
        logger.error(f"Error initializing document: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents/by-identifier", response_model=dict)
async def get_document_by_identifier(identifier: str):
    """Get document by business identifier."""
    try:
        if STORAGE_BACKEND != "sheets":
            raise HTTPException(status_code=501, detail="Only supported with Google Sheets")
        
        doc = storage_adapter.get_document_by_identifier(identifier)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        
        marksets = storage_adapter.list_mark_sets_by_document(doc["doc_id"])
        
        return {
            "document": doc,
            "marksets": marksets
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching document: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents/{doc_id}/mark-sets", response_model=List[dict])
async def list_document_marksets(doc_id: str):
    """List all mark sets for a document."""
    try:
        if STORAGE_BACKEND != "sheets":
            raise HTTPException(status_code=501, detail="Only supported with Google Sheets")
        
        marksets = storage_adapter.list_mark_sets_by_document(doc_id)
        return marksets
    except Exception as e:
        logger.error(f"Error listing marksets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========== NEW: Mark Set Status Endpoint ==========

@app.get("/mark-sets/{mark_set_id}/status", response_model=dict)
async def get_markset_status(mark_set_id: str):
    """Get markset completion status and list of users who submitted."""
    try:
        if STORAGE_BACKEND != "sheets":
            raise HTTPException(status_code=501, detail="Only supported with Google Sheets")
        
        # Get all marks in markset
        marks = storage_get_marks(mark_set_id)
        total_marks = len(marks)
        
        # Get all user inputs
        user_inputs = storage_adapter.get_user_inputs(mark_set_id)
        
        # Group by user
        users = {}
        for inp in user_inputs:
            user = inp.get("submitted_by", "unknown")
            if user not in users:
                users[user] = {
                    "submitted_by": user,
                    "submitted_at": inp.get("submitted_at"),
                    "marks_filled": 0
                }
            users[user]["marks_filled"] += 1
        
        # Calculate completion percentage for each user
        for user_data in users.values():
            user_data["completion_percentage"] = round(
                (user_data["marks_filled"] / total_marks * 100) if total_marks > 0 else 0, 
                2
            )
        
        return {
            "mark_set_id": mark_set_id,
            "total_marks": total_marks,
            "users": list(users.values()),
            "user_count": len(users)
        }
    except Exception as e:
        logger.error(f"Error fetching markset status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Import and include user_input router
from routers.user_input import router as user_input_router
app.include_router(user_input_router)
# ========== End of Submissions ==========

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