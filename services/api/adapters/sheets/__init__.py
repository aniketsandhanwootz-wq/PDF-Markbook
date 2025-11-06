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
    "documents": [
        "doc_id", "pdf_url", "hash", "page_count",
        "part_number", "external_id", "project_name",   # 👈 added external_id (your “id”)
        "created_by", "created_at", "updated_at"
    ],
    "pages":     ["page_id", "doc_id", "idx", "width_pt", "height_pt", "rotation_deg"],
    "mark_sets": ["mark_set_id", "doc_id", "label", "is_active", "is_master", "created_by", "created_at", "updation_log", "updated_by"],
    "marks":     [
        "mark_id", "mark_set_id", "page_id", "order_index", "name", "label",
        "nx", "ny", "nw", "nh", "zoom_hint", "padding_pct", "anchor"
    ],
    "mark_user_input": ["input_id", "mark_id", "mark_set_id", "user_value", "submitted_at", "submitted_by"],
    "inspection_reports": ["report_id", "mark_set_id", "inspection_doc_url", "created_by", "created_at"],  # 👈 NEW
}

SHEET_TAB_ORDER = ["documents", "pages", "mark_sets", "marks", "mark_user_input", "inspection_reports"]  # 👈 NEW at end

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
        self._user_input_cache: dict[str, list[dict[str, Any]]] = {}

    
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

    def list_documents(self) -> list[dict[str, Any]]:
        """Return all documents as dicts (used by admin/clean-urls)."""
        return self._get_all_dicts("documents")
    
    def _append_dict_row(self, tab: str, data: dict[str, Any]) -> None:
        """Append one row using the SHEET'S CURRENT HEADER order."""
        header = self.ws[tab].row_values(1)
        if not header:
            header = HEADERS[tab][:]
            self.ws[tab].update("A1", [header])
        row = [data.get(col, "") for col in header]
        self._append_rows(tab, [row])

    def create_document(
        self,
        pdf_url: str,
        created_by: str | None = None,
        part_number: str | None = None,
        project_name: str | None = None,
        external_id: str | None = None,
    ) -> str:
        doc_id = _uuid()
        now = _utc_iso()

        # normalize once
        data = {
            "doc_id": doc_id,
            "pdf_url": (pdf_url or "").strip(),
            "hash": "",
            "page_count": 0,
            "part_number": (part_number or "").strip(),
            "external_id": (external_id or "").strip(),
            "project_name": (project_name or "").strip(),
            "created_by": (created_by or "").strip(),
            "created_at": now,
            "updated_at": now,
        }

        # append by HEADER NAME (not by index)
        self._append_dict_row("documents", data)

        # cache uses strings like _get_all_dicts does
        self._doc_cache[doc_id] = {k: (str(v) if isinstance(v, (int, float)) else v) for k, v in data.items()}
        self._doc_cache[doc_id]["page_count"] = str(self._doc_cache[doc_id]["page_count"])
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

    def create_mark_set(self, doc_id: str, label: str, created_by: str | None, marks: list[dict[str, Any]], is_master: bool = False) -> str:
        if not self.get_document(doc_id):
            raise ValueError("DOCUMENT_NOT_FOUND")

        # ensure pages cache exists (ok if empty)
        _ = self._pages_for_doc(doc_id)

        mark_set_id = _uuid()
        now = _utc_iso()

        # write mark_sets row by header name
        self._append_dict_row("mark_sets", {
            "mark_set_id": mark_set_id,
            "doc_id": doc_id,
            "label": (label or "v1"),
            "is_active": "FALSE",
            "is_master": "TRUE" if is_master else "FALSE",
            "created_by": (created_by or ""),
            "created_at": now,
            "updation_log": "[]",
            "updated_by": (created_by or ""),
        })

        # if initial marks passed, map page_index -> page_id (create_mark_set
        # is usually called with marks=[], we leave as-is)
        if marks:
            pages = self._pages_for_doc(doc_id)
            idx_to_page_id = {p["idx"]: p["page_id"] for p in pages}

            seen = set()
            mrows = []
            for m in marks:
                oi = int(m["order_index"])
                if oi in seen:
                    raise ValueError("DUPLICATE_ORDER_INDEX")
                seen.add(oi)

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
                    m.get("label", ""),
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

    def set_master_mark_set(self, mark_set_id: str) -> None:
        """Set exactly one master markset per document: this TRUE, others FALSE."""
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

        # ensure column exists even on older sheets
        if "is_master" not in colmap:
            # append header
            ws = self.ws["mark_sets"]
            hdr_vals = ws.row_values(1)
            if "is_master" not in hdr_vals:
                hdr_vals.append("is_master")
                ws.update("1:1", [hdr_vals])
            self.colmap["mark_sets"] = self._ensure_headers("mark_sets")
            colmap = self.colmap["mark_sets"]

        for i, ms in enumerate(ms_rows, start=2):
            if ms["doc_id"] == doc_id:
                a1 = gspread.utils.rowcol_to_a1(i, colmap["is_master"])
                val = "TRUE" if ms["mark_set_id"] == mark_set_id else "FALSE"
                updates.append({"range": a1, "values": [[val]]})

        if updates:
            self.ws["mark_sets"].batch_update(updates)

    # ========== NEW: Document Lookup Methods ==========
    
    def get_document_by_business_key(
        self,
        *,
        project_name: str,
        external_id: str,
        part_number: str,
    ) -> dict[str, Any] | None:
        """
        Resolve a document by the 3-part business key:
        (project_name, external_id, part_number), with whitespace trimmed.
        """
        pn = (project_name or "").strip()
        eid = (external_id or "").strip()
        pnumb = (part_number or "").strip()

        docs = self._get_all_dicts("documents")
        for d in docs:
            if ((d.get("project_name", "").strip() == pn)
                and (d.get("external_id", "").strip() == eid)
                and (d.get("part_number", "").strip() == pnumb)):
                return d
        return None


    # Back-compat helper (kept so older code doesn't crash)
    def get_document_by_identifier(self, identifier: str) -> dict[str, Any] | None:
        """
        Legacy single-arg lookup:
        1) doc_id exact match
        2) external_id exact match
        3) part_number exact match
        """
        docs = self._get_all_dicts("documents")
        for d in docs:
            if d.get("doc_id") == identifier:
                return d
        for d in docs:
            if d.get("external_id") == identifier:
                return d
        for d in docs:
            if d.get("part_number") == identifier:
                return d
        return None

    
    def list_mark_sets_by_document(self, doc_id: str) -> list[dict[str, Any]]:
        """List all mark sets for a document."""
        mark_sets = self._get_all_dicts("mark_sets")
        return [ms for ms in mark_sets if ms.get("doc_id") == doc_id]
    
    def update_document(self, doc_id: str, updates: dict[str, Any]) -> None:
        """Update document fields."""
        row_idx = self._find_row_by_value("documents", "doc_id", doc_id)
        if not row_idx:
            raise ValueError("DOCUMENT_NOT_FOUND")
        updates["updated_at"] = _utc_iso()
        self._update_cells("documents", row_idx, updates)
        self._doc_cache.pop(doc_id, None)
    
    # ========== NEW: Mark Set Management Methods ==========
    
    def update_mark_set(self, mark_set_id: str, label: str | None, updated_by: str) -> None:
        """Update mark set metadata."""
        row_idx = self._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
        if not row_idx:
            raise ValueError("MARK_SET_NOT_FOUND")
        
        # Get existing updation_log
        header = HEADERS["mark_sets"]
        vals = self.ws["mark_sets"].row_values(row_idx)
        row_data = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        
        try:
            updation_log = json.loads(row_data.get("updation_log", "[]"))
        except:
            updation_log = []
        
        updation_log.append({
            "updated_by": updated_by,
            "updated_at": _utc_iso()
        })
        
        updates = {
            "updated_by": updated_by,
            "updation_log": json.dumps(updation_log)
        }
        if label:
            updates["label"] = label
        
        self._update_cells("mark_sets", row_idx, updates)

    def clone_mark_set(self, mark_set_id: str, new_label: str, created_by: str | None) -> str:
        """Deep clone a mark set + its marks into a new mark set on the same document."""
        src_ms = None
        for ms in self._get_all_dicts("mark_sets"):
            if ms.get("mark_set_id") == mark_set_id:
                src_ms = ms
                break
        if not src_ms:
            raise ValueError("MARK_SET_NOT_FOUND")

        doc_id = src_ms["doc_id"]
        new_id = _uuid()
        now = _utc_iso()

        # Keep is_master FALSE on clone by default
        self._append_rows("mark_sets", [[
            new_id, doc_id,
            (new_label or "copy"),
            "FALSE",            # is_active
            "FALSE",            # is_master  👈 added (fix column count)
            (created_by or ""),
            now,
            src_ms.get("updation_log", "[]"),
            (created_by or "")
        ]])

        src_marks = [m for m in self._get_all_dicts("marks") if m.get("mark_set_id") == mark_set_id]
        rows = []
        for m in src_marks:
            rows.append([
                _uuid(), new_id, m["page_id"], int(_safe_int(m["order_index"], 0)),
                m.get("name",""), m.get("label",""),
                float(_safe_float(m["nx"], 0.0)), float(_safe_float(m["ny"], 0.0)),
                float(_safe_float(m["nw"], 0.0)), float(_safe_float(m["nh"], 0.0)),
                ("" if m.get("zoom_hint") in ("", None) else float(_safe_float(m["zoom_hint"], 0.0))),
                float(_safe_float(m.get("padding_pct", 0.1), 0.1)),
                m.get("anchor","auto"),
            ])
        if rows:
            self._append_rows("marks", rows)
        return new_id

    # ========== NEW: User Input Methods ==========
    
    def create_user_input(self, mark_id: str, mark_set_id: str, user_value: str, submitted_by: str) -> str:
        """Create a single user input entry."""
        input_id = _uuid()
        now = _utc_iso()
        self._append_rows("mark_user_input", [[
            input_id, mark_id, mark_set_id, user_value, now, submitted_by
        ]])
        self._user_input_cache.pop(mark_set_id, None)
        return input_id
    
    def create_user_inputs_batch(self, mark_set_id: str, entries: dict[str, str], submitted_by: str) -> int:
        """Create multiple user input entries in batch."""
        now = _utc_iso()
        rows = []
        for mark_id, user_value in entries.items():
            input_id = _uuid()
            rows.append([input_id, mark_id, mark_set_id, user_value, now, submitted_by])
        
        if rows:
            self._append_rows("mark_user_input", rows)
            self._user_input_cache.pop(mark_set_id, None)
        
        return len(rows)
    
    def get_user_inputs(self, mark_set_id: str, submitted_by: str | None = None) -> list[dict[str, Any]]:
        """Get user inputs for a mark set, optionally filtered by user."""
        cache_key = f"{mark_set_id}:{submitted_by or 'all'}"
        if cache_key in self._user_input_cache:
            return self._user_input_cache[cache_key]
        
        all_inputs = self._get_all_dicts("mark_user_input")
        filtered = [inp for inp in all_inputs if inp.get("mark_set_id") == mark_set_id]
        
        if submitted_by:
            filtered = [inp for inp in filtered if inp.get("submitted_by") == submitted_by]
        
        self._user_input_cache[cache_key] = filtered
        return filtered
    
    def update_user_input(self, input_id: str, user_value: str) -> dict[str, Any]:
        """Update a user input entry."""
        row_idx = self._find_row_by_value("mark_user_input", "input_id", input_id)
        if not row_idx:
            raise ValueError("USER_INPUT_NOT_FOUND")
        
        now = _utc_iso()
        self._update_cells("mark_user_input", row_idx, {
            "user_value": user_value,
            "submitted_at": now
        })
        
        # Clear cache
        self._user_input_cache.clear()
        
        header = HEADERS["mark_user_input"]
        vals = self.ws["mark_user_input"].row_values(row_idx)
        return {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
    
    def delete_user_input(self, input_id: str) -> None:
        """Delete a user input entry."""
        all_inputs = self._get_all_dicts("mark_user_input")
        found = any(inp.get("input_id") == input_id for inp in all_inputs)
        if not found:
            raise ValueError("USER_INPUT_NOT_FOUND")
        
        header = self.ws["mark_user_input"].row_values(1)
        filtered = [header] + [
            [inp[k] for k in header]
            for inp in all_inputs
            if inp.get("input_id") != input_id
        ]
        self.ws["mark_user_input"].clear()
        self.ws["mark_user_input"].update('A1', filtered)
        self._user_input_cache.clear()

    # ========== Reports ==========
    def create_report_record(self, mark_set_id: str, inspection_doc_url: str, created_by: str | None) -> str:
        """Persist a generated report record."""
        rid = _uuid()
        now = _utc_iso()
        self._append_rows("inspection_reports", [[rid, mark_set_id, inspection_doc_url, (created_by or ""), now]])
        return rid

    def list_reports(self, mark_set_id: str) -> list[dict[str, Any]]:
        """List all reports for a mark set."""
        return [r for r in self._get_all_dicts("inspection_reports") if r.get("mark_set_id") == mark_set_id]
