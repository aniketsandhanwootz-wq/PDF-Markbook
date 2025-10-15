"""
FastAPI application entry point for PDF Markbook.
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from typing import Annotated

from settings import get_settings, Settings
from schemas import HealthCheck
from routers import documents, marks
from adapters.base import StorageAdapter
from adapters.sqlite import SqliteAdapter
from adapters.json import JsonAdapter
from adapters.sheets import SheetsAdapter
from adapters.pg import PgAdapter


# Global storage adapter instance
_storage_adapter = None


def get_storage_adapter(settings: Annotated[Settings, Depends(get_settings)]) -> StorageAdapter:
    """
    Dependency injection for storage adapter.
    Returns the appropriate adapter based on STORAGE_BACKEND setting.
    """
    global _storage_adapter
    
    # Memoize the adapter
    if _storage_adapter is not None:
        return _storage_adapter
    
    backend = settings.storage_backend.lower()
    
    if backend == "sqlite":
        _storage_adapter = SqliteAdapter(settings.db_url)
    elif backend == "json":
        # Extract directory from db_url or use default
        data_dir = "data"
        if settings.db_url.startswith("sqlite:///"):
            db_path = settings.db_url.replace("sqlite:///", "")
            data_dir = os.path.dirname(db_path) or "data"
        _storage_adapter = JsonAdapter(data_dir)
    elif backend == "sheets":
        _storage_adapter = SheetsAdapter(
            settings.google_sa_json,
            settings.sheets_spreadsheet_id
        )
    elif backend == "pg" or backend == "postgres" or backend == "postgresql":
        db_url = settings.postgres_url or settings.db_url
        _storage_adapter = PgAdapter(db_url)
    else:
        raise ValueError(
            f"Unknown storage backend: {backend}. "
            f"Valid options: sqlite, json, sheets, pg"
        )
    
    return _storage_adapter


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifecycle manager for the application.
    Handles startup and shutdown tasks.
    """
    # Startup
    settings = get_settings()
    print(f"🚀 PDF Markbook API starting...")
    print(f"📦 Storage backend: {settings.storage_backend}")
    
    # Ensure data directory exists for SQLite/JSON
    if settings.storage_backend in ("sqlite", "json"):
        os.makedirs("data", exist_ok=True)
        print(f"📁 Data directory: ./data")
    
    # Initialize adapter (this will create tables for SQLite)
    try:
        adapter = get_storage_adapter(settings)
        print(f"✅ Storage adapter initialized")
    except NotImplementedError as e:
        print(f"⚠️  Storage adapter not available: {e}")
    except Exception as e:
        print(f"❌ Failed to initialize storage adapter: {e}")
        raise
    
    yield
    
    # Shutdown
    print("👋 PDF Markbook API shutting down...")


# Create FastAPI application
app = FastAPI(
    title="PDF Markbook API",
    description="Backend API for managing PDF documents with marked regions of interest",
    version="1.0.0",
    lifespan=lifespan
)


# Configure CORS
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_origins_list(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Include routers
app.include_router(documents.router)
app.include_router(marks.router)


# Health check endpoint
@app.get("/health", response_model=HealthCheck)
async def health_check(settings: Annotated[Settings, Depends(get_settings)]):
    """
    Health check endpoint.
    Returns API status and current storage backend.
    """
    return HealthCheck(ok=True, backend=settings.storage_backend)


# Root endpoint
@app.get("/")
async def root():
    """
    Root endpoint with basic API information.
    """
    return {
        "name": "PDF Markbook API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)