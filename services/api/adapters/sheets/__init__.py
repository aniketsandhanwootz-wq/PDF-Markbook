# services/api/adapters/sheets/__init__.py
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional

import gspread
from google.oauth2.service_account import Credentials
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from ..base import StorageAdapter

HEADERS = {
    "documents": ["doc_id", "pdf_url", "hash", "page_count", "created_by", "created_at", "updated_at"],
    "pages":     ["page_id", "doc_id", "idx", "width_pt", "height_pt", "rotation_deg"],
    "mark_sets": ["mark_set_id", "doc_id", "label", "is_active", "created_by", "created_at"],
    # ⬇️ add submission columns to the canonical header
    "marks":     [
        "mark_id", "mark_set_id", "page_id", "order_index", "name", "label",
        "nx", "ny", "nw", "nh", "zoom_hint", "padding_pct", "anchor",
        "user_value", "submitted_at", "submitted_by"
    ],
}


SHEET_TAB_ORDER = ["documents", "pages", "mark_sets", "marks"]

def _safe_float(v, default=None):
    try:
        if v is None:
            return default
        s = str(v).strip().lower()
        if s in ("", "nan", "null", "none"):
            return default
        return float(s)
    except Exception:
        return default

def _safe_int(v, default=None):
    try:
        if v is None:
            return default
        s = str(v).strip()
        if s == "":
            return default
        # allow "3.0" etc
        return int(float(s))
    except Exception:
        return default

def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _uuid() -> str:
    return str(uuid.uuid4())


def _sa_client_from_json_or_path(google_sa_json: str) -> gspread.Client:
    """
    Accepts either:
      - absolute/relative path to a service-account JSON file, OR
      - a literal JSON string.
    Returns an authorized gspread Client.
    """
    if not google_sa_json:
        raise ValueError("GOOGLE_SA_JSON is required (path to file or inline JSON).")

    # Try to treat as inline JSON first
    try:
        parsed = json.loads(google_sa_json)
        creds = Credentials.from_service_account_info(
            parsed,
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        return gspread.authorize(creds)
    except json.JSONDecodeError:
        # Not JSON; treat as file path
        creds = Credentials.from_service_account_file(
            google_sa_json,
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        return gspread.authorize(creds)


# ========== Retry decorator for Google Sheets API calls ==========
def retry_sheets_api(func):
    """Decorator to retry Sheets API calls with exponential backoff on quota errors."""
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type((gspread.exceptions.APIError,)),
        reraise=True
    )
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper


class SheetsAdapter(StorageAdapter):
    """
    ✨ SIMPLIFIED Google Sheets implementation:
    - Basic read/write operations
    - Retry logic for reliability
    - No complex caching or indexes
    - Easy to debug and maintain
    """
    def __init__(self, google_sa_json: Optional[str], spreadsheet_id: Optional[str]) -> None:
        if not google_sa_json or not spreadsheet_id:
            raise ValueError("SheetsAdapter requires GOOGLE_SA_JSON and SHEETS_SPREADSHEET_ID")

        self.gc = _sa_client_from_json_or_path(google_sa_json)
        self.ss = self.gc.open_by_key(spreadsheet_id)

        self.ws: dict[str, gspread.Worksheet] = {}
        self.colmap: dict[str, dict[str, int]] = {}
        for tab in SHEET_TAB_ORDER:
            self.ws[tab] = self._ensure_worksheet(tab)
            self.colmap[tab] = self._ensure_headers(tab)

        # Simple in-memory caches (no TTL, cleared on write)
        self._doc_cache: dict[str, dict[str, Any]] = {}
        self._pages_by_doc_cache: dict[str, list[dict[str, Any]]] = {}

    # ========== Worksheet helpers ==========

    def _ensure_worksheet(self, name: str) -> gspread.Worksheet:
        try:
            return self.ss.worksheet(name)
        except gspread.WorksheetNotFound:
            return self.ss.add_worksheet(title=name, rows=200, cols=len(HEADERS[name]) + 2)

    def _ensure_headers(self, name: str) -> dict[str, int]:
        ws = self.ws[name]
        values = ws.get_values("1:1")
        existing = values[0] if values else []

        base = HEADERS[name][:]
        if not existing:
            ws.update("A1", [base])
            header = base
        else:
            # If required base columns are missing, append them at the end.
            # If the sheet already has extra columns, KEEP them.
            missing = [c for c in base if c not in existing]
            header = existing + missing if missing else existing
            if header != existing:
                ws.update("1:1", [header])

        return {col: idx + 1 for idx, col in enumerate(header)}


    @retry_sheets_api
    def _get_all_dicts(self, tab: str) -> list[dict[str, Any]]:
        """Get all rows from a tab as dictionaries. WITH RETRY."""
        ws = self.ws[tab]
        rows = ws.get_all_values()
        if not rows:
            return []
        header = rows[0]
        out = []
        for r in rows[1:]:
            out.append({header[i]: (r[i] if i < len(r) else "") for i in range(len(header))})
        return out

    @retry_sheets_api
    def _append_rows(self, tab: str, rows: list[list[Any]]) -> None:
        """Append rows to tab. WITH RETRY."""
        if rows:
            self.ws[tab].append_rows(rows, value_input_option="USER_ENTERED")

    @retry_sheets_api
    def _update_cells(self, tab: str, row_idx: int, updates: dict[str, Any]) -> None:
        """Update specific cells in a row. WITH RETRY."""
        colmap = self.colmap[tab]
        data = []
        for k, v in updates.items():
            a1 = gspread.utils.rowcol_to_a1(row_idx, colmap[k])
            data.append({"range": a1, "values": [[v]]})
        if data:
            self.ws[tab].batch_update(data)

    def _find_row_by_value(self, tab: str, col_name: str, value: str) -> Optional[int]:
        """Find row index by column value."""
        ws = self.ws[tab]
        col_idx = self.colmap[tab][col_name]
        col_vals = ws.col_values(col_idx)
        for i, v in enumerate(col_vals[1:], start=2):  # skip header
            if v == value:
                return i
        return None

    # ========== StorageAdapter API ==========

    def create_document(self, pdf_url: str, created_by: str | None = None) -> str:
        doc_id = _uuid()
        now = _utc_iso()
        self._append_rows("documents", [[doc_id, pdf_url, "", 0, (created_by or ""), now, now]])
        self._doc_cache[doc_id] = {
            "doc_id": doc_id,
            "pdf_url": pdf_url,
            "hash": "",
            "page_count": "0",
            "created_by": created_by or "",
            "created_at": now,
            "updated_at": now,
        }
        return doc_id

    def get_document(self, doc_id: str) -> dict[str, Any] | None:
        if doc_id in self._doc_cache:
            return self._doc_cache[doc_id]
        r = self._find_row_by_value("documents", "doc_id", doc_id)
        if not r:
            return None
        header = HEADERS["documents"]
        vals = self.ws["documents"].row_values(r)
        obj = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        self._doc_cache[doc_id] = obj
        return obj

    def bootstrap_pages(self, doc_id: str, page_count: int, dims: list[dict[str, Any]]) -> None:
        existing = self._get_all_dicts("pages")
        for row in existing:
            if row["doc_id"] == doc_id:
                raise ValueError("PAGES_ALREADY_BOOTSTRAPPED")

        rows = []
        for d in dims:
            rows.append([
                _uuid(), doc_id, int(d["idx"]), float(d["width_pt"]),
                float(d["height_pt"]), int(d["rotation_deg"])
            ])
        self._append_rows("pages", rows)

        drow = self._find_row_by_value("documents", "doc_id", doc_id)
        if drow:
            self._update_cells("documents", drow, {"page_count": page_count, "updated_at": _utc_iso()})
        self._pages_by_doc_cache.pop(doc_id, None)

    def _pages_for_doc(self, doc_id: str) -> list[dict[str, Any]]:
        if doc_id in self._pages_by_doc_cache:
            return self._pages_by_doc_cache[doc_id]
        rows = [r for r in self._get_all_dicts("pages") if r["doc_id"] == doc_id]
        for r in rows:
            r["idx"] = int(r["idx"])
            r["width_pt"] = float(r["width_pt"])
            r["height_pt"] = float(r["height_pt"])
            r["rotation_deg"] = int(r["rotation_deg"])
        rows.sort(key=lambda r: r["idx"])
        self._pages_by_doc_cache[doc_id] = rows
        return rows

    def create_mark_set(self, doc_id: str, label: str, created_by: str | None, marks: list[dict[str, Any]]) -> str:
        if not self.get_document(doc_id):
            raise ValueError("DOCUMENT_NOT_FOUND")

        pages = self._pages_for_doc(doc_id)
        idx_to_page_id = {p["idx"]: p["page_id"] for p in pages}

        mark_set_id = _uuid()
        now = _utc_iso()
        self._append_rows("mark_sets", [[mark_set_id, doc_id, (label or "v1"), "FALSE", (created_by or ""), now]])

        seen = set()
        for m in marks:
            oi = int(m["order_index"])
            if oi in seen:
                raise ValueError("DUPLICATE_ORDER_INDEX")
            seen.add(oi)

        mrows = []
        for m in marks:
            page_index = int(m["page_index"])
            page_id = idx_to_page_id.get(page_index)
            if not page_id:
                raise ValueError(f"PAGE_INDEX_NOT_FOUND:{page_index}")
            mrows.append([
                _uuid(),
                mark_set_id,
                page_id,
                int(m["order_index"]),
                m.get("name", ""),
                m.get("label", ""),   # NEW
                float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"]),
                ("" if m.get("zoom_hint") is None else float(m["zoom_hint"])),
                float(m.get("padding_pct", 0.1)),
                m.get("anchor", "auto"),
            ])
        self._append_rows("marks", mrows)
        return mark_set_id

    def list_marks(self, mark_set_id: str) -> list[dict[str, Any]]:
        """Get all marks for a mark set, ordered by order_index."""
        marks = [r for r in self._get_all_dicts("marks") if r["mark_set_id"] == mark_set_id]

        # Build page_id -> page_index map once
        pages_all = self._get_all_dicts("pages")
        pid_to_idx: dict[str, int] = {}
        for p in pages_all:
            # tolerate blanks in the pages sheet too
            pid = p.get("page_id", "")
            idx = _safe_int(p.get("idx"), default=None)
            if pid and idx is not None:
                pid_to_idx[pid] = idx

        out: list[dict[str, Any]] = []
        for m in marks:
            try:
                nx = _safe_float(m.get("nx"), default=None)
                ny = _safe_float(m.get("ny"), default=None)
                nw = _safe_float(m.get("nw"), default=None)
                nh = _safe_float(m.get("nh"), default=None)

                # Required fields missing? skip the row instead of crashing
                if None in (nx, ny, nw, nh):
                    # optional: log once per bad row
                    # print(f"Skipping mark_id={m.get('mark_id')} due to blank geometry")
                    continue

                zoom_hint = _safe_float(m.get("zoom_hint"), default=None)
                padding_pct = _safe_float(m.get("padding_pct"), default=0.1)

                out.append({
                    "mark_id": m.get("mark_id", ""),
                    "page_index": pid_to_idx.get(m.get("page_id", ""), 0),
                    "order_index": _safe_int(m.get("order_index"), default=0),
                    "name": m.get("name", ""),
                    "label": (m.get("label", "") or ""),
                    "nx": nx, "ny": ny, "nw": nw, "nh": nh,
                    "zoom_hint": zoom_hint,
                    "padding_pct": padding_pct,
                    "anchor": (m.get("anchor") or "auto"),
                })
            except Exception:
                # Any unexpected row issues? just skip
                continue

        out.sort(key=lambda r: r["order_index"])
        return out

       

    def patch_mark(self, mark_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        r = self._find_row_by_value("marks", "mark_id", mark_id)
        if not r:
            raise ValueError("MARK_NOT_FOUND")

        allowed: dict[str, Any] = {}
        if "zoom_hint" in updates and updates["zoom_hint"] is not None:
            allowed["zoom_hint"] = float(updates["zoom_hint"])
        if "padding_pct" in updates and updates["padding_pct"] is not None:
            allowed["padding_pct"] = float(updates["padding_pct"])
        if "anchor" in updates and updates["anchor"] is not None:
            allowed["anchor"] = str(updates["anchor"])

        if allowed:
            self._update_cells("marks", r, allowed)

        header = HEADERS["marks"]
        vals = self.ws["marks"].row_values(r)
        return {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}

    def activate_mark_set(self, mark_set_id: str) -> None:
        r = self._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
        if not r:
            raise ValueError("MARK_SET_NOT_FOUND")

        header = HEADERS["mark_sets"]
        vals = self.ws["mark_sets"].row_values(r)
        row = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        doc_id = row["doc_id"]

        ms_rows = self._get_all_dicts("mark_sets")
        updates = []
        colmap = self.colmap["mark_sets"]
        for i, ms in enumerate(ms_rows, start=2):
            if ms["doc_id"] == doc_id:
                a1 = gspread.utils.rowcol_to_a1(i, colmap["is_active"])
                val = "TRUE" if ms["mark_set_id"] == mark_set_id else "FALSE"
                updates.append({"range": a1, "values": [[val]]})
        if updates:
            self.ws["mark_sets"].batch_update(updates)
      # ========== NEW: Save Submissions ==========
  
    @retry_sheets_api
    def save_submissions(self, mark_set_id: str, entries: dict[str, str]) -> dict[str, Any]:
        """
        Save user-submitted values to marks sheet.
        Updates user_value, submitted_at, submitted_by columns.
        This function works even if these columns already exist or are missing.
        """
        # --- 1) Read current header and sync our colmap to the REAL sheet header
        header = self.ws["marks"].row_values(1)
        if not header:
            # Seed with the base header if the sheet is empty
            header = HEADERS["marks"][:]
            self.ws["marks"].update('A1', [header])

        # IMPORTANT: reflect the ACTUAL header in colmap (it may already have extra columns)
        self.colmap["marks"] = {col: idx + 1 for idx, col in enumerate(header)}

        # --- 2) Ensure required extra columns exist (append if missing)
        required_extras = ["user_value", "submitted_at", "submitted_by"]
        missing = [c for c in required_extras if c not in header]
        if missing:
            new_header = header + missing
            # Write the new header row (preserve existing order, just append)
            self.ws["marks"].update('1:1', [new_header])
            header = new_header
            # Rebuild colmap to include the new columns
            self.colmap["marks"] = {col: idx + 1 for idx, col in enumerate(header)}

        # --- 3) Perform row updates
        submitted_at = _utc_iso()
        updated_count = 0

        for mark_id, value in entries.items():
            row_idx = self._find_row_by_value("marks", "mark_id", mark_id)
            if row_idx:
                # Use _update_cells which depends on self.colmap["marks"]. We have synced it above.
                self._update_cells("marks", row_idx, {
                    "user_value": value,
                    "submitted_at": submitted_at,
                    "submitted_by": "viewer_user"
                })
                updated_count += 1

        return {
            "updated_count": updated_count,
            "submitted_at": submitted_at
        }
