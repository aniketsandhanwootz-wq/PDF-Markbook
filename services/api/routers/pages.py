# services/api/routers/pages.py
from fastapi import APIRouter, HTTPException, Request
from typing import Any

from schemas.page import PagesBootstrap

router = APIRouter(
    prefix="/pages",
    tags=["pages"],
)


@router.post("/bootstrap")
async def bootstrap_pages(payload: PagesBootstrap, request: Request) -> dict[str, Any]:
    """
    Bootstrap / update the `pages` sheet for a given document.

    Expects:
    {
      "doc_id": "...",
      "page_count": N,
      "dims": [
        { "page_index": 0, "width_pt": 841.89, "height_pt": 595.28, "rotation_deg": 0 },
        ...
      ]
    }
    """
    app = request.app

    backend = getattr(app.state, "storage_backend", None)
    if backend != "sheets":
        raise HTTPException(
            status_code=501,
            detail="pages/bootstrap is only supported when STORAGE_BACKEND='sheets'",
        )

    adapter = getattr(app.state, "storage_adapter", None)
    if adapter is None:
        raise HTTPException(
            status_code=500,
            detail="Sheets adapter not configured on app.state.storage_adapter",
        )

    try:
        # 🔴 This was the missing argument earlier: dims
        adapter.bootstrap_pages(
            doc_id=payload.doc_id,
            page_count=payload.page_count,
            dims=[d.model_dump() for d in payload.dims],
        )
    except Exception as e:
        import logging

        logging.getLogger(__name__).exception("bootstrap_pages failed")
        raise HTTPException(
            status_code=500,
            detail=f"bootstrap_pages failed: {e}",
        )

    return {
        "status": "ok",
        "doc_id": payload.doc_id,
        "page_count": payload.page_count,
        "dims_count": len(payload.dims),
    }
