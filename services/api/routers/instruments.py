# services/api/routers/instruments.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, List

from main import get_storage_adapter, get_settings  # DI helpers

router = APIRouter(prefix="/instruments", tags=["instruments"])


def get_storage():
    """
    Consistent DI wrapper so this router uses the same Sheets adapter
    as marks.py / mark_sets.py.
    """
    return get_storage_adapter(get_settings())


Storage = Annotated[object, Depends(get_storage)]


@router.get("/suggestions", response_model=List[str], status_code=status.HTTP_200_OK)
async def get_instrument_suggestions(
    storage: Storage,
    q: str | None = Query(
        None,
        description="Optional substring filter (case-insensitive)",
        min_length=1,
    ),
):
    """
    Return distinct instrument names from marks, optionally filtered
    by substring `q`. Used for Editor autocomplete.
    """
    try:
        if not hasattr(storage, "list_distinct_instruments"):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Instrument suggestions not supported by this backend",
            )

        instruments = storage.list_distinct_instruments()
        if q:
            q_lower = q.lower()
            instruments = [i for i in instruments if q_lower in i.lower()]
        return instruments
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch instrument suggestions: {e}",
        )
