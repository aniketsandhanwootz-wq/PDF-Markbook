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

# ========== Sheet schema (HEADERS) ==========

HEADERS = {
    "documents": [
        "doc_id",
        "pdf_url",
        "page_count",
        "part_number",
        "external_id",
        "project_name",
        "master_editors",
        "created_by",
        "created_at",
        "updated_at",
    ],
    "pages": [
        "page_id",
        "doc_id",
        "page_index",
        "width_pt",
        "height_pt",
        "rotation_deg",
    ],
    "mark_sets": [
        "mark_set_id",
        "doc_id",
        "name",
        "description",
        "is_active",
        "is_master",
        "created_by",
        "created_at",
        "updated_by",
        "update_history",
    ],
    # MASTER marks only
    "marks": [
        "mark_id",
        "mark_set_id",
        "page_id",
        "label",
        "instrument",
        "is_required",
        "order_index",
        "nx",
        "ny",
        "nw",
        "nh",
        "created_by",
        "created_at",
        "updated_by",
        "updated_at",
    ],
    "groups": [
        "group_id",
        "mark_set_id",
        "page_id",
        "page_index",
        "name",
        "nx",
        "ny",
        "nw",
        "nh",
        "mark_ids",      # JSON / comma-separated master mark_ids
        "created_by",
        "created_at",
        "updated_by",
        "updated_at",
    ],
    "mark_user_input": [
        "input_id",
        "mark_id",
        "mark_set_id",
        "user_value",
        "submitted_at",
        "submitted_by",
        "report_id",       
    ],
    "inspection_reports": [
        "report_id",
        "mark_set_id",
        "inspection_doc_url",
        "created_by",
        "created_at",
        "report_title",   
        "submitted_by",    
    ],
}

SHEET_TAB_ORDER = [
    "documents",
    "pages",
    "mark_sets",
    "marks",
    "groups",
    "mark_user_input",
    "inspection_reports",
]


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
        reraise=True,
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
            return self.ss.add_worksheet(
                title=name,
                rows=200,
                cols=len(HEADERS[name]) + 2,
            )

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
            if k not in colmap:
                continue
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

    def _append_dict_row(self, tab: str, data: dict[str, Any]) -> None:
        """Append one row using the SHEET'S CURRENT HEADER order."""
        header = self.ws[tab].row_values(1)
        if not header:
            header = HEADERS[tab][:]
            self.ws[tab].update("A1", [header])
        row = [data.get(col, "") for col in header]
        self._append_rows(tab, [row])

    # ========== StorageAdapter API ==========

    def list_documents(self) -> list[dict[str, Any]]:
        """Return all documents as dicts (used by admin/clean-urls)."""
        return self._get_all_dicts("documents")

    def create_document(
        self,
        pdf_url: str,
        created_by: str | None = None,
        part_number: str | None = None,
        project_name: str | None = None,
        external_id: str | None = None,
        master_editors: str | None = None,
    ) -> str:
        doc_id = _uuid()
        now = _utc_iso()

        data = {
            "doc_id": doc_id,
            "pdf_url": (pdf_url or "").strip(),
            "page_count": 0,
            "part_number": (part_number or "").strip(),
            "external_id": (external_id or "").strip(),
            "project_name": (project_name or "").strip(),
            "master_editors": (master_editors or "").strip(),
            "created_by": (created_by or "").strip(),
            "created_at": now,
            "updated_at": now,
        }

        self._append_dict_row("documents", data)

        # cache uses strings like _get_all_dicts does
        self._doc_cache[doc_id] = {
            k: (str(v) if isinstance(v, (int, float)) else v)
            for k, v in data.items()
        }
        self._doc_cache[doc_id]["page_count"] = str(self._doc_cache[doc_id]["page_count"])
        return doc_id

    def get_document(self, doc_id: str) -> dict[str, Any] | None:
        if doc_id in self._doc_cache:
            return self._doc_cache[doc_id]
        r = self._find_row_by_value("documents", "doc_id", doc_id)
        if not r:
            return None
        header = self.ws["documents"].row_values(1)
        vals = self.ws["documents"].row_values(r)
        obj = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        self._doc_cache[doc_id] = obj
        return obj

    def bootstrap_pages(self, doc_id: str, page_count: int, dims: list[dict[str, Any]]) -> None:
        """
        Bootstrap or update page geometry for a document.

        Behaviour:
        - If no pages exist yet for this doc_id -> create full set of rows.
        - If rows already exist (possibly stubbed with width/height=0) -> update
          width_pt / height_pt / rotation_deg in-place, keeping page_id stable.
        """
        # Map incoming dims by page_index for quick lookup
        dims_by_index: dict[int, dict[str, Any]] = {}
        for d in dims:
            idx = int(d["page_index"])
            dims_by_index[idx] = d

        # All existing pages for this doc (as dicts, without row indexes)
        all_pages = self._get_all_dicts("pages")
        existing_for_doc = [r for r in all_pages if r.get("doc_id") == doc_id]

        if not existing_for_doc:
            # --- Case 1: no rows yet -> create fresh ones (original behaviour) ---
            rows: list[list[Any]] = []
            for d in dims:
                rows.append(
                    [
                        _uuid(),
                        doc_id,
                        int(d["page_index"]),
                        float(d["width_pt"]),
                        float(d["height_pt"]),
                        int(d["rotation_deg"]),
                    ]
                )
            self._append_rows("pages", rows)
        else:
            # --- Case 2: rows already exist -> update geometry in-place ---
            for existing in existing_for_doc:
                try:
                    idx = _safe_int(existing.get("page_index"), default=None)
                    if idx is None:
                        continue

                    dim = dims_by_index.get(idx)
                    if not dim:
                        # No new info for this index -> skip
                        continue

                    page_id = existing.get("page_id")
                    if not page_id:
                        continue

                    row_idx = self._find_row_by_value("pages", "page_id", page_id)
                    if not row_idx:
                        continue

                    self._update_cells(
                        "pages",
                        row_idx,
                        {
                            "width_pt": float(dim["width_pt"]),
                            "height_pt": float(dim["height_pt"]),
                            "rotation_deg": int(dim["rotation_deg"]),
                        },
                    )
                except Exception:
                    # Don't let one bad row kill the whole bootstrap
                    continue

        # --- Update documents.page_count and clear cache ---
        drow = self._find_row_by_value("documents", "doc_id", doc_id)
        if drow:
            self._update_cells(
                "documents",
                drow,
                {"page_count": page_count, "updated_at": _utc_iso()},
            )

        self._pages_by_doc_cache.pop(doc_id, None)


    def _pages_for_doc(self, doc_id: str) -> list[dict[str, Any]]:
        if doc_id in self._pages_by_doc_cache:
            return self._pages_by_doc_cache[doc_id]
        rows = [r for r in self._get_all_dicts("pages") if r.get("doc_id") == doc_id]
        for r in rows:
            r["page_index"] = int(r["page_index"])
            r["width_pt"] = float(r["width_pt"])
            r["height_pt"] = float(r["height_pt"])
            r["rotation_deg"] = int(r["rotation_deg"])
        rows.sort(key=lambda r: r["page_index"])
        self._pages_by_doc_cache[doc_id] = rows
        return rows

    def _ensure_page_for_doc_index(self, doc_id: str, page_index: int) -> str:
        """
        Ensure there is a pages row for (doc_id, page_index) and return its page_id.

        This is a safety net for cases where pages were never explicitly bootstrapped.
        It creates a minimal stub row with width_pt/height_pt=0 so that groups can
        still be created and associated to a page.
        """
        # First, see if we already have this page in cache/storage
        pages = self._pages_for_doc(doc_id)
        for p in pages:
            if int(p["page_index"]) == int(page_index):
                return p["page_id"]

        # No page exists for this index → create a minimal stub row
        pid = _uuid()
        data = {
            "page_id": pid,
            "doc_id": doc_id,
            "page_index": int(page_index),
            "width_pt": 0,
            "height_pt": 0,
            "rotation_deg": 0,
        }

        # Use current header order for the pages sheet
        self._append_dict_row("pages", data)

        # Clear cache so next _pages_for_doc() sees the new row
        self._pages_by_doc_cache.pop(doc_id, None)

        return pid

    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        created_by: str | None,
        marks: list[dict[str, Any]],
        is_master: bool = False,
        description: str | None = None,
    ) -> str:
        """
        Create a mark set and optionally initial marks.
        `label` here is used as the mark set `name` in the sheet.
        """
        if not self.get_document(doc_id):
            raise ValueError("DOCUMENT_NOT_FOUND")

        # ensure pages cache exists (ok if empty)
        _ = self._pages_for_doc(doc_id)

        mark_set_id = _uuid()
        now = _utc_iso()

        # write mark_sets row by header name
        self._append_dict_row(
            "mark_sets",
            {
                "mark_set_id": mark_set_id,
                "doc_id": doc_id,
                "name": (label or "v1"),
                "description": (description or ""),
                "is_active": "FALSE",
                "is_master": "TRUE" if is_master else "FALSE",
                "created_by": (created_by or ""),
                "created_at": now,
                "updated_by": (created_by or ""),
                "update_history": json.dumps([]),
            },
        )

        # if initial marks passed, map page_index -> page_id
        if marks:
            pages = self._pages_for_doc(doc_id)
            idx_to_page_id = {p["page_index"]: p["page_id"] for p in pages}

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

                label_val = m.get("label", "")
                instrument = m.get("instrument") or m.get("name", "") or ""
                is_required = m.get("is_required", True)

                mrows.append(
                    [
                        _uuid(),
                        mark_set_id,
                        page_id,
                        label_val,
                        instrument,
                        "TRUE" if is_required else "FALSE",
                        oi,
                        float(m["nx"]),
                        float(m["ny"]),
                        float(m["nw"]),
                        float(m["nh"]),
                        (created_by or ""),
                        now,
                        (created_by or ""),
                        now,
                    ]
                )
            self._append_rows("marks", mrows)

        return mark_set_id

    def list_marks(self, mark_set_id: str) -> list[dict[str, Any]]:
        """Get all marks for a mark set, ordered by order_index."""
        marks = [r for r in self._get_all_dicts("marks") if r.get("mark_set_id") == mark_set_id]

        # Build page_id -> page_index map once
        pages_all = self._get_all_dicts("pages")
        pid_to_idx: dict[str, int] = {}
        for p in pages_all:
            pid = p.get("page_id", "")
            idx = _safe_int(p.get("page_index"), default=None)
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
                    continue

                is_required_raw = (m.get("is_required") or "").strip().upper()
                is_required = is_required_raw == "TRUE"

                out.append(
                    {
                        "mark_id": m.get("mark_id", ""),
                        "page_index": pid_to_idx.get(m.get("page_id", ""), 0),
                        "order_index": _safe_int(m.get("order_index"), default=0),
                        "label": (m.get("label", "") or ""),
                        "instrument": (m.get("instrument", "") or ""),
                        "is_required": is_required,
                        "nx": nx,
                        "ny": ny,
                        "nw": nw,
                        "nh": nh,
                    }
                )
            except Exception:
                # Any unexpected row issues? just skip
                continue

        out.sort(key=lambda r: r["order_index"])
        return out
    
    def get_marks(self, mark_set_id: str) -> list[dict[str, Any]]:
        """
        Backwards-compatible alias used by older routers
        (marks.py still calls storage.get_marks).
        """
        return self.list_marks(mark_set_id)

    def update_marks(self, mark_set_id: str, marks: list[dict[str, Any]]) -> None:
        """
        Replace ALL marks for a given mark_set_id.

        Used by the Editor when saving the Master mark set.

        Behaviour:
        - If this is the first time we save marks for a document and there are
          no rows in `pages` for this doc_id, we auto-bootstrap stub pages
          [0..max_page_index] with width/height = 0 (just to have stable IDs).
        - We PRESERVE any incoming `mark_id` values from the frontend. If a mark
          has no `mark_id` yet, we generate a fresh UUID.
        """
        # --- 1) Ensure mark_set exists and has a doc_id ---
        ms_rows = self._get_all_dicts("mark_sets")
        target = next(
            (ms for ms in ms_rows if ms.get("mark_set_id") == mark_set_id),
            None,
        )
        if not target:
            raise ValueError("MARK_SET_NOT_FOUND")

        doc_id = target.get("doc_id")
        if not doc_id:
            raise ValueError("MARK_SET_HAS_NO_DOC_ID")

        # --- 2) Ensure pages exist; if not, bootstrap stub pages ---
        pages = self._pages_for_doc(doc_id)
        if not pages:
            # derive page_count from marks
            max_page_index = max(
                int(m.get("page_index", 0)) for m in marks
            ) if marks else -1

            if max_page_index >= 0:
                dims = [
                    {
                        "page_index": i,
                        "width_pt": 0,
                        "height_pt": 0,
                        "rotation_deg": 0,
                    }
                    for i in range(max_page_index + 1)
                ]
                # this will fail if pages already exist, but we guarded with `if not pages`
                self.bootstrap_pages(doc_id, max_page_index + 1, dims)
                pages = self._pages_for_doc(doc_id)

        # Build page_index -> page_id map (may be empty if no marks)
        idx_to_page_id = {p["page_index"]: p["page_id"] for p in pages}

        now = _utc_iso()
        seen_order: set[int] = set()
        new_rows: list[list[Any]] = []

        for m in marks:
            page_index = int(m["page_index"])

            # ensure we have a page_id for this index
            page_id = idx_to_page_id.get(page_index)
            if not page_id:
                # if pages weren’t bootstrapped for this index, create a stub row
                page_id = self._ensure_page_for_doc_index(doc_id, page_index)
                idx_to_page_id[page_index] = page_id

            oi = int(m.get("order_index", 0))
            if oi in seen_order:
                raise ValueError("DUPLICATE_ORDER_INDEX")
            seen_order.add(oi)

            # ✅ preserve incoming mark_id if present, otherwise generate a new one
            incoming_id = (m.get("mark_id") or "").strip()
            mark_id = incoming_id or _uuid()

            label_val = m.get("label", "") or ""
            instrument = m.get("instrument", "") or ""
            is_required = bool(m.get("is_required", True))

            new_rows.append(
                [
                    mark_id,  # <-- stable mark_id
                    mark_set_id,
                    page_id,
                    label_val,
                    instrument,
                    "TRUE" if is_required else "FALSE",
                    oi,
                    float(m["nx"]),
                    float(m["ny"]),
                    float(m["nw"]),
                    float(m["nh"]),
                    (target.get("created_by") or ""),
                    now,
                    (target.get("updated_by") or ""),
                    now,
                ]
            )

        # --- 3) Rewrite marks sheet, keeping other mark sets intact ---
        all_marks = self._get_all_dicts("marks")
        header = self.ws["marks"].row_values(1)
        if not header:
            header = HEADERS["marks"][:]
            self.ws["marks"].update("A1", [header])

        kept_rows = [
            [row.get(col, "") for col in header]
            for row in all_marks
            if row.get("mark_set_id") != mark_set_id
        ]

        updated_matrix = [header] + kept_rows + new_rows
        self.ws["marks"].clear()
        self.ws["marks"].update("A1", updated_matrix)

    def list_distinct_instruments(self) -> list[str]:
        """
        Return a sorted list of distinct non-empty instrument names
        from the marks sheet.
        """
        rows = self._get_all_dicts("marks")
        instruments: set[str] = set()
        for m in rows:
            inst = (m.get("instrument") or "").strip()
            if inst:
                instruments.add(inst)
        return sorted(instruments, key=lambda s: s.lower())

    def patch_mark(self, mark_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        """
        Update mutable mark fields:
        - instrument
        - is_required
        """
        r = self._find_row_by_value("marks", "mark_id", mark_id)
        if not r:
            raise ValueError("MARK_NOT_FOUND")

        allowed: dict[str, Any] = {}
        if "instrument" in updates and updates["instrument"] is not None:
            allowed["instrument"] = str(updates["instrument"])
        if "is_required" in updates and updates["is_required"] is not None:
            allowed["is_required"] = "TRUE" if bool(updates["is_required"]) else "FALSE"
        if allowed:
            allowed["updated_at"] = _utc_iso()
            self._update_cells("marks", r, allowed)

        header = self.ws["marks"].row_values(1)
        vals = self.ws["marks"].row_values(r)
        return {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}

    def activate_mark_set(self, mark_set_id: str) -> None:
        r = self._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
        if not r:
            raise ValueError("MARK_SET_NOT_FOUND")

        header = self.ws["mark_sets"].row_values(1)
        vals = self.ws["mark_sets"].row_values(r)
        row = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        doc_id = row["doc_id"]

        ms_rows = self._get_all_dicts("mark_sets")
        updates = []
        colmap = self.colmap["mark_sets"]
        for i, ms in enumerate(ms_rows, start=2):
            if ms.get("doc_id") == doc_id:
                a1 = gspread.utils.rowcol_to_a1(i, colmap["is_active"])
                val = "TRUE" if ms.get("mark_set_id") == mark_set_id else "FALSE"
                updates.append({"range": a1, "values": [[val]]})
        if updates:
            self.ws["mark_sets"].batch_update(updates)

    def set_master_mark_set(self, mark_set_id: str) -> None:
        """Set exactly one master markset per document: this TRUE, others FALSE."""
        r = self._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
        if not r:
            raise ValueError("MARK_SET_NOT_FOUND")

        header = self.ws["mark_sets"].row_values(1)
        vals = self.ws["mark_sets"].row_values(r)
        row = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}
        doc_id = row["doc_id"]

        ms_rows = self._get_all_dicts("mark_sets")
        updates = []
        colmap = self.colmap["mark_sets"]

        # ensure column exists even on older sheets
        if "is_master" not in colmap:
            ws = self.ws["mark_sets"]
            hdr_vals = ws.row_values(1)
            if "is_master" not in hdr_vals:
                hdr_vals.append("is_master")
                ws.update("1:1", [hdr_vals])
            self.colmap["mark_sets"] = self._ensure_headers("mark_sets")
            colmap = self.colmap["mark_sets"]

        for i, ms in enumerate(ms_rows, start=2):
            if ms.get("doc_id") == doc_id:
                a1 = gspread.utils.rowcol_to_a1(i, colmap["is_master"])
                val = "TRUE" if ms.get("mark_set_id") == mark_set_id else "FALSE"
                updates.append({"range": a1, "values": [[val]]})

        if updates:
            self.ws["mark_sets"].batch_update(updates)

    # ========== Document lookup ==========

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
            if (
                (d.get("project_name", "").strip() == pn)
                and (d.get("external_id", "").strip() == eid)
                and (d.get("part_number", "").strip() == pnumb)
            ):
                return d
        return None

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

    def count_marks_by_mark_set(self, doc_id: str) -> dict[str, int]:
        """
        Return {mark_set_id: count} for all mark sets belonging to doc_id.
        Only two reads overall: mark_sets and marks.
        """
        all_ms = self._get_all_dicts("mark_sets")
        ms_ids = {ms["mark_set_id"] for ms in all_ms if ms.get("doc_id") == doc_id}

        counts: dict[str, int] = {ms_id: 0 for ms_id in ms_ids}
        all_marks = self._get_all_dicts("marks")
        for m in all_marks:
            ms_id = m.get("mark_set_id")
            if ms_id in counts:
                counts[ms_id] += 1
        return counts

    def update_document(self, doc_id: str, updates: dict[str, Any]) -> None:
        """Update document fields."""
        row_idx = self._find_row_by_value("documents", "doc_id", doc_id)
        if not row_idx:
            raise ValueError("DOCUMENT_NOT_FOUND")
        updates["updated_at"] = _utc_iso()
        self._update_cells("documents", row_idx, updates)
        self._doc_cache.pop(doc_id, None)

    # ========== Mark Set Management Methods ==========

    def update_mark_set(self, mark_set_id: str, label: str | None, updated_by: str) -> None:
        """
        Update mark set metadata (name + history).
        `label` parameter maps to `name` column.
        """
        row_idx = self._find_row_by_value("mark_sets", "mark_set_id", mark_set_id)
        if not row_idx:
            raise ValueError("MARK_SET_NOT_FOUND")

        header = self.ws["mark_sets"].row_values(1)
        vals = self.ws["mark_sets"].row_values(row_idx)
        row_data = {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}

        try:
            history = json.loads(row_data.get("update_history", "[]"))
        except Exception:
            history = []

        history.append({"updated_by": updated_by, "updated_at": _utc_iso()})

        updates = {
            "updated_by": updated_by,
            "update_history": json.dumps(history),
        }
        if label:
            updates["name"] = label

        self._update_cells("mark_sets", row_idx, updates)

    def clone_mark_set(self, mark_set_id: str, new_label: str, created_by: str | None) -> str:
        """
        Deep clone a mark set + its marks into a new mark set on the same document.
        Cloned markset is never master and not active by default.
        """
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

        history = []
        try:
            history = json.loads(src_ms.get("update_history", "[]"))
        except Exception:
            history = []

        self._append_dict_row(
            "mark_sets",
            {
                "mark_set_id": new_id,
                "doc_id": doc_id,
                "name": (new_label or "copy"),
                "description": src_ms.get("description", ""),
                "is_active": "FALSE",
                "is_master": "FALSE",
                "created_by": (created_by or src_ms.get("created_by", "")),
                "created_at": src_ms.get("created_at", now),
                "updated_by": (created_by or src_ms.get("updated_by", "")),
                "update_history": json.dumps(history),
            },
        )

        src_marks = [m for m in self._get_all_dicts("marks") if m.get("mark_set_id") == mark_set_id]
        rows = []
        for m in src_marks:
            rows.append(
                [
                    _uuid(),
                    new_id,
                    m.get("page_id", ""),
                    m.get("label", ""),
                    m.get("instrument", ""),
                    m.get("is_required", "TRUE"),
                    int(_safe_int(m.get("order_index"), 0)),
                    float(_safe_float(m.get("nx"), 0.0)),
                    float(_safe_float(m.get("ny"), 0.0)),
                    float(_safe_float(m.get("nw"), 0.0)),
                    float(_safe_float(m.get("nh"), 0.0)),
                    (created_by or m.get("created_by", "")),
                    now,
                    (created_by or m.get("updated_by", "")),
                    now,
                ]
            )
        if rows:
            self._append_rows("marks", rows)
        return new_id
    
    def delete_mark_set(self, mark_set_id: str, requested_by: str | None = None) -> None:
        """
        Delete a mark set and all its dependent data:
        - mark_sets row (if not master and owned by requested_by)
        - marks
        - groups
        - mark_user_input
        - inspection_reports
        """
        mark_sets = self._get_all_dicts("mark_sets")
        target = next((ms for ms in mark_sets if ms.get("mark_set_id") == mark_set_id), None)
        if not target:
            raise ValueError("MARK_SET_NOT_FOUND")

        # Cannot delete master
        if (target.get("is_master") or "").strip().upper() == "TRUE":
            raise ValueError("CANNOT_DELETE_MASTER")

        # Ownership check
        if requested_by:
            owner = (target.get("created_by") or "").strip().lower()
            if owner and owner != requested_by.strip().lower():
                raise ValueError("NOT_OWNER")

        # --- 1) Delete from mark_sets ---
        ms_header = self.ws["mark_sets"].row_values(1)
        filtered_ms = [ms_header] + [
            [ms.get(col, "") for col in ms_header]
            for ms in mark_sets
            if ms.get("mark_set_id") != mark_set_id
        ]
        self.ws["mark_sets"].clear()
        self.ws["mark_sets"].update("A1", filtered_ms)

        # --- 2) Delete marks for this mark_set_id ---
        marks_all = self._get_all_dicts("marks")
        marks_header = self.ws["marks"].row_values(1)
        filtered_marks = [marks_header] + [
            [m.get(col, "") for col in marks_header]
            for m in marks_all
            if m.get("mark_set_id") != mark_set_id
        ]
        self.ws["marks"].clear()
        self.ws["marks"].update("A1", filtered_marks)

        # --- 3) Delete groups for this mark_set_id ---
        groups_all = self._get_all_dicts("groups")
        groups_header = self.ws["groups"].row_values(1)
        filtered_groups = [groups_header] + [
            [g.get(col, "") for col in groups_header]
            for g in groups_all
            if g.get("mark_set_id") != mark_set_id
        ]
        self.ws["groups"].clear()
        self.ws["groups"].update("A1", filtered_groups)

        # --- 4) Delete mark_user_input for this mark_set_id ---
        mui_all = self._get_all_dicts("mark_user_input")
        mui_header = self.ws["mark_user_input"].row_values(1)
        filtered_mui = [mui_header] + [
            [u.get(col, "") for col in mui_header]
            for u in mui_all
            if u.get("mark_set_id") != mark_set_id
        ]
        self.ws["mark_user_input"].clear()
        self.ws["mark_user_input"].update("A1", filtered_mui)
        self._user_input_cache.clear()

        # --- 5) Delete inspection_reports for this mark_set_id ---
        rep_all = self._get_all_dicts("inspection_reports")
        rep_header = self.ws["inspection_reports"].row_values(1)
        filtered_rep = [rep_header] + [
            [r.get(col, "") for col in rep_header]
            for r in rep_all
            if r.get("mark_set_id") != mark_set_id
        ]
        self.ws["inspection_reports"].clear()
        self.ws["inspection_reports"].update("A1", filtered_rep)

     # ========== Group Methods ==========
    def create_group(
        self,
        mark_set_id: str,
        page_index: int,
        name: str,
        nx: float,
        ny: float,
        nw: float,
        nh: float,
        mark_ids: list[str],
        created_by: str | None = None,
    ) -> str:
        """
        Create a group rectangle for a QC mark_set and persist it in the `groups` sheet.

        Behaviour:
        - Best-effort: tries to resolve mark_set → doc_id so we can attach a page_id.
        - If mark_set/doc/page cannot be resolved, we STILL create the group with
          page_id="" and rely on page_index + geometry in the UI.
        - Stores mark_ids as JSON string.
        """

        # --- 1) Try to resolve mark_set → doc_id (best-effort) ---
        doc_id: str | None = None
        try:
            mark_sets = self._get_all_dicts("mark_sets")
            for ms in mark_sets:
                if ms.get("mark_set_id") == mark_set_id:
                    doc_id = ms.get("doc_id") or None
                    break
        except Exception:
            # If Sheets is weird or mark_sets tab missing, we still proceed
            doc_id = None

        # --- 2) Try to ensure a pages row for (doc_id, page_index) ---
        # If we cannot resolve doc_id for any reason, we just leave page_id empty.
        page_id = ""
        if doc_id:
            try:
                page_id = self._ensure_page_for_doc_index(doc_id, int(page_index))
            except Exception:
                # Do not block group creation if pages are not bootstrapped
                page_id = ""

        # --- 3) Prepare row payload ---
        gid = _uuid()
        now = _utc_iso()

        # mark_ids stored as JSON; allow empty list
        mark_ids_json = json.dumps(mark_ids or [])

        data = {
            "group_id": gid,
            "mark_set_id": mark_set_id,
            "page_id": page_id,
            "page_index": int(page_index),
            "name": name or "",
            "nx": float(nx),
            "ny": float(ny),
            "nw": float(nw),
            "nh": float(nh),
            "mark_ids": mark_ids_json,
            "created_by": (created_by or ""),
            "created_at": now,
            "updated_by": "",
            "updated_at": "",
        }

        # --- 4) Append to `groups` sheet using header order ---
        self._append_dict_row("groups", data)

        return gid

    def list_groups(self, mark_set_id: str) -> list[dict[str, Any]]:
        """
        Adapter API used by GET /mark-sets/{mark_set_id}/groups.

        We already have a full implementation in list_groups_for_mark_set,
        so this is just a thin wrapper.
        """
        return self.list_groups_for_mark_set(mark_set_id)

    def list_groups_for_mark_set(self, mark_set_id: str) -> list[dict[str, Any]]:
        """
        List all groups for a given QC mark_set_id.

        mark_ids is returned as a Python list[str].
        """
        rows = [r for r in self._get_all_dicts("groups") if r.get("mark_set_id") == mark_set_id]
        out: list[dict[str, Any]] = []
        for g in rows:
            try:
                mark_ids_raw = (g.get("mark_ids") or "").strip()
                if mark_ids_raw.startswith("["):
                    # JSON form
                    mark_ids = json.loads(mark_ids_raw)
                else:
                    # comma-separated fallback
                    mark_ids = [s.strip() for s in mark_ids_raw.split(",") if s.strip()]

                out.append(
                    {
                        "group_id": g.get("group_id", ""),
                        "mark_set_id": g.get("mark_set_id", ""),
                        "page_id": g.get("page_id", ""),
                        "page_index": _safe_int(g.get("page_index"), 0),
                        "name": g.get("name", ""),
                        "nx": _safe_float(g.get("nx"), 0.0),
                        "ny": _safe_float(g.get("ny"), 0.0),
                        "nw": _safe_float(g.get("nw"), 0.0),
                        "nh": _safe_float(g.get("nh"), 0.0),
                        "mark_ids": mark_ids,
                        "created_by": g.get("created_by", ""),
                        "created_at": g.get("created_at", ""),
                        "updated_by": g.get("updated_by", ""),
                        "updated_at": g.get("updated_at", ""),
                    }
                )
            except Exception:
                # skip any corrupted row
                continue

        # Sort by page_index then name for stable UI
        out.sort(key=lambda gr: (gr["page_index"], gr["name"]))
        return out


    def update_group(self, group_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        """
        Update mutable fields of a group:
        - name, nx, ny, nw, nh, page_index, mark_ids
        """
        row_idx = self._find_row_by_value("groups", "group_id", group_id)
        if not row_idx:
            raise ValueError("GROUP_NOT_FOUND")

        allowed: dict[str, Any] = {}

        # simple scalar fields
        scalar_fields = ["name", "nx", "ny", "nw", "nh", "page_index"]
        for f in scalar_fields:
            if f in updates and updates[f] is not None:
                allowed[f] = updates[f]

        # mark_ids as JSON
        if "mark_ids" in updates and updates["mark_ids"] is not None:
            allowed["mark_ids"] = json.dumps(updates["mark_ids"])

        if allowed:
            allowed["updated_at"] = _utc_iso()
            self._update_cells("groups", row_idx, allowed)

        header = self.ws["groups"].row_values(1)
        vals = self.ws["groups"].row_values(row_idx)
        return {header[i]: (vals[i] if i < len(vals) else "") for i in range(len(header))}

    def delete_group(self, group_id: str) -> None:
        """
        Delete a group by group_id (rewrite the sheet to avoid gspread row-delete quirks).
        """
        all_groups = self._get_all_dicts("groups")
        found = any(g.get("group_id") == group_id for g in all_groups)
        if not found:
            raise ValueError("GROUP_NOT_FOUND")

        header = self.ws["groups"].row_values(1)
        filtered = [header] + [
            [g.get(k, "") for k in header]
            for g in all_groups
            if g.get("group_id") != group_id
        ]
        self.ws["groups"].clear()
        self.ws["groups"].update("A1", filtered)

    # ========== User Input Methods ==========

    def create_user_input(
        self,
        mark_id: str,
        mark_set_id: str,
        user_value: str,
        submitted_by: str,
        report_id: str | None = None,
    ) -> str:
        """Create a single user input entry.

        report_id groups all inputs that belong to the same QC submission.
        """
        input_id = _uuid()
        now = _utc_iso()
        self._append_rows(
            "mark_user_input",
            [[input_id, mark_id, mark_set_id, user_value, now, submitted_by, report_id or ""]],
        )
        # Clear cache because we changed user_input table
        self._user_input_cache.clear()
        return input_id


    def create_user_inputs_batch(
        self,
        mark_set_id: str,
        entries: dict[str, str],
        submitted_by: str,
        report_id: str | None = None,
    ) -> int:
        """Create multiple user input entries in batch.

        All rows get the same report_id, representing one QC submission.
        """
        now = _utc_iso()
        rows = []
        for mark_id, user_value in entries.items():
            input_id = _uuid()
            rows.append([input_id, mark_id, mark_set_id, user_value, now, submitted_by, report_id or ""])

        if rows:
            self._append_rows("mark_user_input", rows)
            # Clear cache because mark_user_input changed
            self._user_input_cache.clear()

        return len(rows)


    def get_user_inputs(
        self,
        mark_set_id: str,
        submitted_by: str | None = None,
        report_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get user inputs for a mark set, optionally filtered by user and/or report."""
        cache_key = f"{mark_set_id}:{submitted_by or 'all'}:{report_id or 'all'}"
        if cache_key in self._user_input_cache:
            return self._user_input_cache[cache_key]

        all_inputs = self._get_all_dicts("mark_user_input")
        filtered = [inp for inp in all_inputs if inp.get("mark_set_id") == mark_set_id]

        if submitted_by:
            filtered = [inp for inp in filtered if inp.get("submitted_by") == submitted_by]

        if report_id:
            filtered = [inp for inp in filtered if inp.get("report_id") == report_id]

        self._user_input_cache[cache_key] = filtered
        return filtered


    def update_user_input(self, input_id: str, user_value: str) -> dict[str, Any]:
        """Update a user input entry."""
        row_idx = self._find_row_by_value("mark_user_input", "input_id", input_id)
        if not row_idx:
            raise ValueError("USER_INPUT_NOT_FOUND")

        now = _utc_iso()
        self._update_cells(
            "mark_user_input",
            row_idx,
            {"user_value": user_value, "submitted_at": now},
        )

        # Clear cache
        self._user_input_cache.clear()

        header = self.ws["mark_user_input"].row_values(1)
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
            [inp.get(k, "") for k in header]
            for inp in all_inputs
            if inp.get("input_id") != input_id
        ]
        self.ws["mark_user_input"].clear()
        self.ws["mark_user_input"].update("A1", filtered)
        self._user_input_cache.clear()

    # ========== Reports ==========

    def create_report_record(
        self,
        mark_set_id: str,
        inspection_doc_url: str,
        created_by: str | None,
        report_id: str | None = None,
        report_title: str | None = None,
        submitted_by: str | None = None,
    ) -> str:
        """Persist a generated report record.

        If report_id is provided (e.g. from the Viewer), it is reused so that
        inspection_reports.report_id matches mark_user_input.report_id.
        Otherwise, a fresh UUID is generated.
        """
        rid = report_id or _uuid()
        now = _utc_iso()
        self._append_rows(
            "inspection_reports",
            [[
                rid,
                mark_set_id,
                inspection_doc_url,
                (created_by or ""),
                now,
                (report_title or ""),
                (submitted_by or ""),
            ]],
        )
        return rid



    def list_reports(self, mark_set_id: str) -> list[dict[str, Any]]:
        """List all reports for a mark set."""
        return [
            r
            for r in self._get_all_dicts("inspection_reports")
            if r.get("mark_set_id") == mark_set_id
        ]

    def get_latest_report_for_mark_set(self, mark_set_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the latest report for a mark set (by created_at desc).
        Returns None if no reports exist.
        """
        reports = self.list_reports(mark_set_id)
        if not reports:
            return None
        
        # Sort by created_at descending
        reports.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        return reports[0]