# services/api/routers/instruments.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, List
import time  # 👈 NEW
from main import get_storage_adapter, get_settings  # DI helpers

router = APIRouter(prefix="/instruments", tags=["instruments"])


def get_storage():
    """
    Consistent DI wrapper so this router uses the same Sheets adapter
    as marks.py / mark_sets.py.
    """
    return get_storage_adapter(get_settings())


Storage = Annotated[object, Depends(get_storage)]

# 🔁 Simple in-process cache so we don't hit Sheets on every keystroke
_INSTRUMENT_CACHE: list[str] | None = None
_INSTRUMENT_CACHE_TS: float = 0.0
_INSTRUMENT_CACHE_TTL = 60.0  # seconds


def _get_all_instruments(storage) -> list[str]:
    """
    Get distinct instruments with a small TTL cache.
    This dramatically reduces Google Sheets calls when the Editor
    fetches /instruments/suggestions.
    """
    global _INSTRUMENT_CACHE, _INSTRUMENT_CACHE_TS

    now = time.time()
    if (
        _INSTRUMENT_CACHE is not None
        and (now - _INSTRUMENT_CACHE_TS) < _INSTRUMENT_CACHE_TTL
    ):
        return _INSTRUMENT_CACHE

    if not hasattr(storage, "list_distinct_instruments"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Instrument suggestions not supported by this backend",
        )

    instruments = storage.list_distinct_instruments() or []
    _INSTRUMENT_CACHE = instruments
    _INSTRUMENT_CACHE_TS = now
    return instruments

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

    NOTE: the underlying list is cached for a short TTL so Google Sheets
    is not called on every request.
    """
    try:
        instruments = _get_all_instruments(storage)

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
