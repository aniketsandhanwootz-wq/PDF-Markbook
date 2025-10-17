"""
PDF Mark System - Production Backend API
FastAPI with error handling, validation, caching, and connection pooling

Install dependencies:
pip install fastapi uvicorn sqlalchemy pydantic python-multipart cachetools

Run server:
uvicorn main:app --host 0.0.0.0 --port $PORT
"""

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from typing import List, Optional
from sqlalchemy import create_engine, Column, String, Integer, Float, ForeignKey, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from cachetools import TTLCache
import uuid
import logging
import os

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Database setup with connection pooling
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./marks.db")

if DATABASE_URL.startswith("sqlite"):
    # SQLite with connection pooling
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False
    )
else:
    # PostgreSQL with connection pooling
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

# Enable WAL mode for SQLite (better concurrent access)
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    if DATABASE_URL.startswith("sqlite"):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

# Cache for frequently accessed mark sets (5 minute TTL)
mark_cache = TTLCache(maxsize=100, ttl=300)

# Database Models
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

# Pydantic models with validation
class Mark(BaseModel):
    mark_id: Optional[str] = None
    page_index: int = Field(ge=0, description="Page index (0-based)")
    order_index: int = Field(ge=0, description="Display order")
    name: str = Field(min_length=1, max_length=200, description="Mark name")
    nx: float = Field(ge=0.0, le=1.0, description="Normalized X (0-1)")
    ny: float = Field(ge=0.0, le=1.0, description="Normalized Y (0-1)")
    nw: float = Field(gt=0.0, le=1.0, description="Normalized width (0-1)")
    nh: float = Field(gt=0.0, le=1.0, description="Normalized height (0-1)")
    zoom_hint: Optional[float] = Field(None, ge=0.25, le=6.0, description="Zoom level (0.25-6.0)")

    @validator('name')
    def name_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Name cannot be empty')
        return v.strip()

    class Config:
        json_schema_extra = {
            "example": {
                "page_index": 0,
                "order_index": 0,
                "name": "Introduction",
                "nx": 0.1,
                "ny": 0.1,
                "nw": 0.3,
                "nh": 0.15,
                "zoom_hint": 1.5
            }
        }

class MarkSet(BaseModel):
    id: str
    pdf_url: str
    name: str

class MarkSetCreate(BaseModel):
    pdf_url: str = Field(min_length=1, max_length=2000, description="PDF URL")
    name: str = Field(min_length=1, max_length=200, description="Mark set name")

    @validator('pdf_url')
    def validate_url(cls, v):
        if not v or not v.strip():
            raise ValueError('PDF URL cannot be empty')
        # Basic URL validation
        if not (v.startswith('http://') or v.startswith('https://')):
            raise ValueError('PDF URL must start with http:// or https://')
        return v.strip()

    @validator('name')
    def name_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Name cannot be empty')
        return v.strip()

# Database context manager
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

# FastAPI app
app = FastAPI(
    title="PDF Mark System API",
    description="Backend API for PDF marking system with error handling and validation",
    version="2.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS with environment-aware origins
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3001,http://localhost:3002"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"}
    )

# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring"""
    try:
        with get_db() as db:
            db.execute("SELECT 1")
        return {
            "status": "healthy",
            "database": "connected",
            "version": "2.0"
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "status": "unhealthy",
                "database": "disconnected",
                "error": str(e)
            }
        )

# Endpoints
@app.post("/mark-sets", response_model=MarkSet, status_code=status.HTTP_201_CREATED)
async def create_mark_set(mark_set: MarkSetCreate):
    """Create a new mark set for a PDF"""
    try:
        logger.info(f"Creating mark set: {mark_set.name}")
        
        with get_db() as db:
            new_id = str(uuid.uuid4())
            db_mark_set = MarkSetDB(
                id=new_id,
                pdf_url=mark_set.pdf_url,
                name=mark_set.name
            )
            db.add(db_mark_set)
            db.flush()
            
            result = MarkSet(
                id=db_mark_set.id,
                pdf_url=db_mark_set.pdf_url,
                name=db_mark_set.name
            )
            
            logger.info(f"Created mark set with ID: {new_id}")
            return result
            
    except Exception as e:
        logger.error(f"Error creating mark set: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create mark set: {str(e)}"
        )

@app.get("/mark-sets", response_model=List[MarkSet])
async def list_mark_sets():
    """List all mark sets with caching"""
    cache_key = "all_mark_sets"
    
    # Check cache first
    if cache_key in mark_cache:
        logger.info("Returning cached mark sets")
        return mark_cache[cache_key]
    
    try:
        with get_db() as db:
            mark_sets = db.query(MarkSetDB).all()
            result = [
                MarkSet(id=ms.id, pdf_url=ms.pdf_url, name=ms.name)
                for ms in mark_sets
            ]
            
            # Cache the result
            mark_cache[cache_key] = result
            logger.info(f"Fetched {len(result)} mark sets")
            return result
            
    except Exception as e:
        logger.error(f"Error listing mark sets: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch mark sets"
        )

@app.get("/mark-sets/{mark_set_id}/marks", response_model=List[Mark])
async def get_marks(mark_set_id: str):
    """Get all marks for a mark set with caching"""
    cache_key = f"marks_{mark_set_id}"
    
    # Check cache first
    if cache_key in mark_cache:
        logger.info(f"Returning cached marks for {mark_set_id}")
        return mark_cache[cache_key]
    
    try:
        with get_db() as db:
            # Check if mark set exists
            mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
            if not mark_set:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Mark set {mark_set_id} not found"
                )
            
            # Fetch marks ordered by order_index
            marks = db.query(MarkDB).filter(
                MarkDB.mark_set_id == mark_set_id
            ).order_by(MarkDB.order_index).all()
            
            result = [
                Mark(
                    mark_id=m.mark_id,
                    page_index=m.page_index,
                    order_index=m.order_index,
                    name=m.name,
                    nx=m.nx,
                    ny=m.ny,
                    nw=m.nw,
                    nh=m.nh,
                    zoom_hint=m.zoom_hint
                )
                for m in marks
            ]
            
            # Cache the result
            mark_cache[cache_key] = result
            logger.info(f"Fetched {len(result)} marks for set {mark_set_id}")
            return result
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching marks: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch marks"
        )

@app.put("/mark-sets/{mark_set_id}/marks")
async def replace_marks(mark_set_id: str, marks: List[Mark]):
    """
    REPLACE all marks for a mark set (no versioning).
    Validates all marks before saving.
    """
    if not marks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Mark list cannot be empty"
        )
    
    if len(marks) > 1000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many marks (max 1000)"
        )
    
    try:
        with get_db() as db:
            # Check if mark set exists
            mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
            if not mark_set:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Mark set {mark_set_id} not found"
                )
            
            # Delete all existing marks
            deleted_count = db.query(MarkDB).filter(
                MarkDB.mark_set_id == mark_set_id
            ).delete()
            
            # Add new marks
            for mark in marks:
                mark_id = mark.mark_id
                if not mark_id or mark_id.startswith('temp-'):
                    mark_id = str(uuid.uuid4())
                
                db_mark = MarkDB(
                    mark_id=mark_id,
                    mark_set_id=mark_set_id,
                    page_index=mark.page_index,
                    order_index=mark.order_index,
                    name=mark.name,
                    nx=mark.nx,
                    ny=mark.ny,
                    nw=mark.nw,
                    nh=mark.nh,
                    zoom_hint=mark.zoom_hint
                )
                db.add(db_mark)
            
            db.flush()
            
            # Invalidate cache
            cache_key = f"marks_{mark_set_id}"
            if cache_key in mark_cache:
                del mark_cache[cache_key]
            if "all_mark_sets" in mark_cache:
                del mark_cache["all_mark_sets"]
            
            logger.info(f"Replaced {deleted_count} marks with {len(marks)} new marks for set {mark_set_id}")
            return {
                "status": "success",
                "count": len(marks),
                "deleted": deleted_count
            }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error replacing marks: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save marks"
        )

@app.delete("/mark-sets/{mark_set_id}", status_code=status.HTTP_200_OK)
async def delete_mark_set(mark_set_id: str):
    """Delete a mark set and all its marks"""
    try:
        with get_db() as db:
            # Delete marks first
            marks_deleted = db.query(MarkDB).filter(
                MarkDB.mark_set_id == mark_set_id
            ).delete()
            
            # Delete mark set
            result = db.query(MarkSetDB).filter(
                MarkSetDB.id == mark_set_id
            ).delete()
            
            if result == 0:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Mark set {mark_set_id} not found"
                )
            
            # Invalidate cache
            cache_key = f"marks_{mark_set_id}"
            if cache_key in mark_cache:
                del mark_cache[cache_key]
            if "all_mark_sets" in mark_cache:
                del mark_cache["all_mark_sets"]
            
            logger.info(f"Deleted mark set {mark_set_id} and {marks_deleted} marks")
            return {
                "status": "deleted",
                "marks_deleted": marks_deleted
            }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting mark set: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete mark set"
        )

@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "message": "PDF Mark System API",
        "version": "2.0",
        "status": "running",
        "docs": "/docs",
        "health": "/health"
    }

# Startup event
@app.on_event("startup")
async def startup_event():
    logger.info("PDF Mark System API starting up...")
    logger.info(f"Database: {DATABASE_URL.split('://')[0]}")
    logger.info(f"Allowed origins: {ALLOWED_ORIGINS}")

# Shutdown event
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("PDF Mark System API shutting down...")
    engine.dispose()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info"
    )