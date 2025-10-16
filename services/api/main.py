"""
FastAPI application entry point for PDF Markbook.
- Uses adapter pattern (sqlite/json/sheets/pg) selected via settings.
- Initializes a single adapter instance on startup (memoized).
- CORS enabled for local editor/viewer by default.
- Health endpoint included.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Annotated, Optional

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ---- Package-local imports (absolute package paths recommended) -------------
from settings import get_settings
from adapters.base import StorageAdapter
from adapters.sqlite import SqliteAdapter  # has .from_url()
from routers import documents, marks


# Global memoized adapter instance
_ADAPTER: Optional[StorageAdapter] = None


def _resolve_allowed_origins(settings) -> list[str]:
    """Support both a list property and a helper, depending on your Settings implementation."""
    if hasattr(settings, "ALLOWED_ORIGINS"):
        return list(getattr(settings, "ALLOWED_ORIGINS"))
    if hasattr(settings, "allowed_origins"):
        return list(getattr(settings, "allowed_origins"))
    if hasattr(settings, "get_origins_list"):
        return list(settings.get_origins_list())
    # sensible default for local dev
    return ["http://localhost:3001", "http://localhost:3002"]


def _resolve_backend(settings) -> str:
    for key in ("STORAGE_BACKEND", "storage_backend"):
        if hasattr(settings, key):
            v = getattr(settings, key)
            if v:
                return str(v).lower()
    return "sqlite"


def _resolve_db_url(settings) -> str:
    for key in ("DB_URL", "db_url"):
        if hasattr(settings, key):
            v = getattr(settings, key)
            if v:
                return str(v)
    # default local sqlite
    return "sqlite:///data/markbook.db"


def get_storage_adapter(settings=Depends(get_settings)) -> StorageAdapter:
    """
    Dependency/Factory for the storage adapter.
    Memoizes a single instance for the process lifetime.
    """
    global _ADAPTER
    if _ADAPTER is not None:
        return _ADAPTER

    backend = _resolve_backend(settings)

    if backend == "sqlite":
        # Use tuned factory that applies WAL/PRAGMAs on connect
        _ADAPTER = SqliteAdapter.from_url(_resolve_db_url(settings))
        return _ADAPTER

    if backend == "json":
        # Import here to avoid import cost if unused
        from adapters.json import JsonAdapter  # type: ignore

        # If you pass a path via DB_URL for json, extract directory; else default data/
        db_url = _resolve_db_url(settings)
        data_dir = "data"
        if db_url.startswith("sqlite:///"):
            # They may have reused sqlite-style URL to point at a file path root
            file_path = db_url.replace("sqlite:///", "", 1)
            data_dir = os.path.dirname(file_path) or "data"
        _ADAPTER = JsonAdapter(data_dir)  # type: ignore
        return _ADAPTER

    if backend in ("pg", "postgres", "postgresql"):
        from adapters.pg import PgAdapter  # type: ignore

        _ADAPTER = PgAdapter(_resolve_db_url(settings))  # type: ignore
        return _ADAPTER

    if backend == "sheets":
        from adapters.sheets import SheetsAdapter  # type: ignore

        # Settings should provide google_sa_json and sheets_spreadsheet_id
        sa = getattr(settings, "google_sa_json", None)
        ssid = getattr(settings, "sheets_spreadsheet_id", None)
        _ADAPTER = SheetsAdapter(sa, ssid)  # type: ignore
        return _ADAPTER

    raise RuntimeError(
        f"Unsupported STORAGE_BACKEND='{backend}'. Valid: sqlite | json | sheets | pg"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup/Shutdown hooks.
    - Ensures local data dir for sqlite/json.
    - Warms adapter once so tables are created (sqlite) or connections tested.
    """
    settings = get_settings()

    backend = _resolve_backend(settings)
    print("🚀 PDF Markbook API starting")
    print(f"📦 Storage backend: {backend}")

    if backend in ("sqlite", "json"):
        os.makedirs("data", exist_ok=True)
        print("📁 Data directory: ./data")

    # Initialize adapter (creates tables for sqlite)
    try:
        _ = get_storage_adapter(settings)
        print("✅ Storage adapter initialized")
    except NotImplementedError as e:
        print(f"⚠️  Storage adapter not implemented: {e}")
    except Exception as e:
        print(f"❌ Failed to initialize storage adapter: {e}")
        raise

    yield

    print("👋 PDF Markbook API shutting down")


# Create the FastAPI app
app = FastAPI(
    title="PDF Markbook API",
    description="Backend API for managing PDF documents with marked regions of interest",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_allowed_origins(_settings),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers (they can call Depends(get_storage_adapter) internally if needed)
app.include_router(documents.router)
app.include_router(marks.router)


# Health & root
@app.get("/health")
def health():
    return {
        "ok": True,
        "backend": _resolve_backend(_settings),
    }


@app.get("/")
def root():
    return {
        "name": "PDF Markbook API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
    }


# Uvicorn launch (dev convenience)
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
