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
from adapters.sheets import HEADERS as SHEETS_HEADERS
from routers import reports, reports_excel
from typing import Any, Dict  

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
import re
import urllib.parse
def clean_pdf_url(url: str) -> str:
    """Extract Google Storage URL from nested Cloudinary URLs"""
    if not url or 'cloudinary.com' not in url:
        return url
    
    decoded = url
    try:
        for _ in range(5):
            prev = decoded
            decoded = urllib.parse.unquote(decoded)
            if decoded == prev:
                break
    except:
        decoded = url
    
    match = re.search(r'https://storage\.googleapis\.com/[^\s"\'<>)]+\.pdf', decoded, re.IGNORECASE)
    if match:
        return match.group(0).replace(' ', '%20')
    
    return url
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
# ---- DI helper (used by routers/*) ----
def get_storage_adapter(_=None):
    return storage_adapter

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
# STORAGE OPERATIONS (Works with both backends)
# ============================================================================
def storage_get_marks(mark_set_id: str) -> List[Dict[str, Any]]:
    """
    Get all marks for a mark set from the configured storage backend.
    NOTE: returns plain dicts, not Pydantic models. This keeps it aligned
    with the new Sheets adapter + routers.
    """
    if STORAGE_BACKEND == "sqlite":
        # Legacy support: still return dicts so report/status endpoints work.
        with get_db() as db:
            mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
            if not mark_set:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            
            marks = (
                db.query(MarkDB)
                .filter(MarkDB.mark_set_id == mark_set_id)
                .order_by(MarkDB.order_index)
                .all()
            )

            result: List[Dict[str, Any]] = []
            for m in marks:
                result.append(
                    {
                        "mark_id": m.mark_id,
                        "mark_set_id": m.mark_set_id,
                        "page_index": m.page_index,
                        "order_index": m.order_index,
                        "name": m.name,
                        "label": "",  # sqlite legacy has no label
                        "nx": m.nx,
                        "ny": m.ny,
                        "nw": m.nw,
                        "nh": m.nh,
                        "zoom_hint": m.zoom_hint,
                        "padding_pct": 0.1,
                        "anchor": "auto",
                    }
                )
            return result

    elif STORAGE_BACKEND == "sheets":
        try:
            # SheetsAdapter already returns dicts in the correct shape
            marks_data = storage_adapter.list_marks(mark_set_id)
            return marks_data
        except ValueError as e:
            if "MARK_SET_NOT_FOUND" in str(e):
                raise HTTPException(
                    status_code=404,
                    detail=f"Mark set {mark_set_id} not found"
                )
            raise

    else:
        raise HTTPException(
            status_code=500,
            detail=f"Unsupported storage backend: {STORAGE_BACKEND}"
        )

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
@app.get("/proxy-pdf")
async def proxy_pdf(url: str):
    """
    Proxy PDF files to avoid CORS issues.
    Supports Google Drive, ArXiv, nested Cloudinary/Glide URLs, etc.
    """
    try:
        original_url = url
        # 🔹 Clean nested Cloudinary / Glide → direct GCS PDF if possible
        url = clean_pdf_url(url)
        logger.info(f"[proxy-pdf] cleaned URL: {url} (from {original_url})")

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

    - Reads marks from the active storage backend (Sheets/SQLite) as plain dicts.
    - Persists entries to mark_user_input (Sheets) when using the Sheets backend.
    """
    # 1) Fetch marks (plain dicts)
    marks = storage_get_marks(mark_set_id)

    # 2) Resolve PDF URL
    pdf_url = body.pdf_url
    if not pdf_url and STORAGE_BACKEND == "sheets":
        ms_all = storage_adapter._get_all_dicts("mark_sets")
        ms = next((r for r in ms_all if r.get("mark_set_id") == mark_set_id), None)
        if ms:
            doc = storage_adapter.get_document(ms["doc_id"])
            if doc:
                pdf_url = doc.get("pdf_url")

    if not pdf_url:
        raise HTTPException(status_code=400, detail="pdf_url required")

    # 3) Save to mark_user_input (Sheets) - best-effort
    try:
        if STORAGE_BACKEND == "sheets" and body.entries:
            submitted_by = body.author or "viewer_user"
            storage_adapter.create_user_inputs_batch(
                mark_set_id=mark_set_id,
                entries=body.entries,
                submitted_by=submitted_by,
            )
    except Exception as e:
        logger.warning(f"save to mark_user_input failed: {e}")

    # 4) Generate report
    try:
        pdf_bytes = await generate_report_pdf(
            pdf_url=pdf_url,
            marks=marks,                # already a list[dict]
            entries=body.entries,
            padding_pct=body.padding_pct or 0.25,
            render_zoom=2.0,
            title=body.title,
            author=body.author,
        )
    except Exception as e:
        logger.error(f"Report generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    # 5) Return PDF as download
    fname = f"submission_{mark_set_id}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )

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

from routers import documents as documents_router
app.include_router(documents_router.router)

from routers import reports as reports_router
app.include_router(reports_router.router)

from routers import mark_sets as mark_sets_router
app.include_router(mark_sets_router.router)

from routers import mark_sets_master as mark_sets_master_router
app.include_router(mark_sets_master_router.router)

from routers import viewer as viewer_router
app.include_router(viewer_router.router)

from routers.reports_excel import router as reports_excel_router
app.include_router(reports_excel_router)

from routers import reports_bundle
app.include_router(reports_bundle.router)

from routers import groups as groups_router
app.include_router(groups_router.router)

from routers import instruments as instruments_router
app.include_router(instruments_router.router)


from routers import marks as marks_router         
app.include_router(marks_router.router) 
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