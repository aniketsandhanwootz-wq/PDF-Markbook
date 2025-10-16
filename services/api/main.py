"""
FastAPI application entry point for PDF Markbook.

- Chooses storage adapter (sqlite/json/sheets/pg) via env settings.
- Initializes a single memoized adapter.
- CORS for local editor/viewer.
- Health endpoint.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from settings import get_settings, Settings
from adapters.base import StorageAdapter
from adapters.sqlite import SqliteAdapter  # has .from_url()
from routers import documents, marks


# -----------------------------------------------------------------------------
# Adapter singleton
# -----------------------------------------------------------------------------
_ADAPTER: Optional[StorageAdapter] = None


def _resolve_backend(s: Settings) -> str:
    return (s.storage_backend or "sqlite").lower()


def _resolve_db_url(s: Settings) -> str:
    return s.db_url or "sqlite:///data/markbook.db"


def _origins(s: Settings) -> list[str]:
    return s.get_origins_list()


def get_storage_adapter(settings: Settings = Depends(get_settings)) -> StorageAdapter:
    """
    Factory (memoized) for the storage adapter.
    """
    global _ADAPTER
    if _ADAPTER is not None:
        return _ADAPTER

    backend = _resolve_backend(settings)

    if backend == "sqlite":
        _ADAPTER = SqliteAdapter.from_url(_resolve_db_url(settings))
        return _ADAPTER

    if backend == "json":
        # lazy import
        from adapters.json import JsonAdapter  # type: ignore

        # If someone passed a sqlite-like path in DB_URL, derive a directory from it
        db_url = _resolve_db_url(settings)
        data_dir = "data"
        if db_url.startswith("sqlite:///"):
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

        sa_json_or_path = settings.google_sa_json
        spreadsheet_id = settings.sheets_spreadsheet_id
        _ADAPTER = SheetsAdapter(sa_json_or_path, spreadsheet_id)  # type: ignore
        return _ADAPTER

    raise RuntimeError(
        f"Unsupported STORAGE_BACKEND='{backend}'. Valid: sqlite | json | sheets | pg"
    )


# -----------------------------------------------------------------------------
# App lifecycle
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    backend = _resolve_backend(s)

    print("🚀 PDF Markbook API starting")
    print(f"📦 Storage backend: {backend}")

    if backend in ("sqlite", "json"):
        os.makedirs("data", exist_ok=True)
        print("📁 Data directory: ./data")

    # warm adapter (ensures tables on sqlite; checks creds for sheets)
    try:
        _ = get_storage_adapter(s)
        print("✅ Storage adapter initialized")
    except Exception as e:
        print(f"❌ Failed to initialize storage adapter: {e}")
        raise

    yield

    print("👋 PDF Markbook API shutting down")


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------
app = FastAPI(
    title="PDF Markbook API",
    description="Backend API for managing PDF documents with marked regions of interest",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
_s = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins(_s),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(documents.router)
app.include_router(marks.router)


# Health + root
@app.get("/health")
def health():
    s = get_settings()
    return {"ok": True, "backend": _resolve_backend(s)}


@app.get("/")
def root():
    return {
        "name": "PDF Markbook API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
