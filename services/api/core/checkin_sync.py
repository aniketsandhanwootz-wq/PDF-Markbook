# services/api/core/checkin_sync.py
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import gspread
from google.oauth2.service_account import Credentials

from settings import get_settings
from core.email_sender import send_email_with_attachments

logger = logging.getLogger(__name__)


def utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_uuid() -> str:
    return str(uuid.uuid4())


def _extract_spreadsheet_id(value: str) -> str:
    """
    Accepts either spreadsheet_id OR full Google Sheets URL.
    Returns spreadsheet_id.
    """
    if not value:
        return ""
    s = value.strip()
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", s)
    if m:
        return m.group(1)
    return s


def _sa_client_from_json_or_path(google_sa_json: str) -> gspread.Client:
    """
    Accepts either:
      - path to SA json, OR
      - inline json string
    """
    if not google_sa_json:
        raise ValueError("GOOGLE_SA_JSON is required (path or inline JSON)")

    # Try inline JSON first
    try:
        parsed = json.loads(google_sa_json)
        creds = Credentials.from_service_account_info(
            parsed,
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        return gspread.authorize(creds)
    except json.JSONDecodeError:
        creds = Credentials.from_service_account_file(
            google_sa_json,
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        return gspread.authorize(creds)


def _get_ws_and_header(
    *,
    spreadsheet_id_or_url: str,
    worksheet_title: str,
) -> Tuple[gspread.Worksheet, List[str], Dict[str, int]]:
    """
    Returns:
      worksheet, header list, header->index map (0-based)
    """
    settings = get_settings()
    sa_path_or_json = settings.resolved_google_sa_json()

    gc = _sa_client_from_json_or_path(sa_path_or_json)
    sheet_id = _extract_spreadsheet_id(spreadsheet_id_or_url)
    if not sheet_id:
        raise ValueError("checkin_sheets_spreadsheet_id is empty or invalid")

    ss = gc.open_by_key(sheet_id)
    ws = ss.worksheet(worksheet_title)

    header = ws.row_values(1) or []
    if not header:
        raise ValueError(f"Worksheet '{worksheet_title}' has empty header row (row 1)")

    header_map = {h.strip(): i for i, h in enumerate(header) if h and h.strip()}
    return ws, header, header_map


def _find_unique_checkin_id(
    *,
    ws: gspread.Worksheet,
    header_map: Dict[str, int],
    base_id: str,
) -> str:
    """
    If base_id exists under "CheckIn ID", keep appending "_" until unique.
    """
    if not base_id:
        base_id = new_uuid()

    if "CheckIn ID" not in header_map:
        # Can't check collision safely
        return base_id

    col_idx_1based = header_map["CheckIn ID"] + 1
    existing_vals = ws.col_values(col_idx_1based)
    existing_set = {v.strip() for v in existing_vals[1:] if v and v.strip()}  # skip header

    candidate = base_id
    while candidate in existing_set:
        candidate = candidate + "_"
    return candidate


async def send_alert_email(
    *,
    subject: str,
    body_html: str,
    attachments: Optional[List[Dict[str, bytes]]] = None,
) -> None:
    """
    Sends alert email to recipients defined by settings.checkin_alert_emails.
    Uses TO = first, CC = rest.
    """
    settings = get_settings()

    fallback = "aniket.sandhan@wootz.work,vinay.jadon@wootz.work,ayush@wootz.work"
    raw = (getattr(settings, "checkin_alert_emails", None) or fallback).strip()

    recipients = [x.strip() for x in raw.split(",") if x and x.strip()]
    if not recipients:
        return

    to_email = recipients[0]
    cc = recipients[1:] or None

    smtp_host = settings.smtp_host
    smtp_port = settings.smtp_port
    smtp_user = settings.smtp_user
    smtp_password = settings.smtp_password
    from_email = settings.smtp_from_email or smtp_user
    from_name = settings.smtp_from_name or "Wootz Markbook System"

    ok = await send_email_with_attachments(
        to_email=to_email,
        subject=subject,
        body_html=body_html,
        attachments=attachments or [],
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_user=smtp_user,
        smtp_password=smtp_password,
        from_email=from_email,
        from_name=from_name,
        cc_emails=cc,
    )
    if not ok:
        logger.error("Alert email send returned False")


def build_checkin_description(
    *,
    dwg_num: str,
    pass_count: int,
    fail_count: int,
    doubt_count: int,
    empty_count: int,
) -> str:
    dwg = (dwg_num or "").strip() or "-"
    return (
        f"Dimensional inspection report submitted for Assembly ({dwg})\n\n"
        f"Doubts: {doubt_count}\n"
        f"Pass: {pass_count}\n"
        f"Fail: {fail_count}\n"
        f"Empty: {empty_count}\n"
    )


async def append_checkin_row_safe(
    *,
    spreadsheet_id_or_url: str,
    worksheet_title: str,
    row_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Appends a new row into the target sheet, aligning by header names.

    Returns:
      {"ok": bool, "checkin_id": str, "error": str}
    """
    try:
        ws, header, header_map = _get_ws_and_header(
            spreadsheet_id_or_url=spreadsheet_id_or_url,
            worksheet_title=worksheet_title,
        )

        base_id = str(row_data.get("CheckIn ID", "") or "").strip()
        unique_id = _find_unique_checkin_id(ws=ws, header_map=header_map, base_id=base_id)
        row_data["CheckIn ID"] = unique_id

        row = [""] * len(header)
        for col_name, value in row_data.items():
            if col_name not in header_map:
                continue
            idx = header_map[col_name]
            row[idx] = "" if value is None else value

        ws.append_row(row, value_input_option="USER_ENTERED")
        return {"ok": True, "checkin_id": unique_id, "error": ""}

    except Exception as e:
        logger.exception("CheckIn append failed: %s", e)
        return {
            "ok": False,
            "checkin_id": str(row_data.get("CheckIn ID", "") or ""),
            "error": str(e),
        }


async def sync_checkin_or_alert(
    *,
    spreadsheet_id_or_url: str,
    worksheet_title: str,
    payload: Dict[str, Any],
    context: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Wrapper: tries append; on failure sends alert email.
    """
    result = await append_checkin_row_safe(
        spreadsheet_id_or_url=spreadsheet_id_or_url,
        worksheet_title=worksheet_title,
        row_data=payload,
    )

    if not result.get("ok"):
        subject = "ALERT: CheckIn row append failed (Wootz Inspect)"
        body_html = (
            "<p><b>CheckIn sync failed</b></p>"
            f"<p><b>Error:</b> {result.get('error')}</p>"
            "<p><b>Context</b></p>"
            f"<pre>{json.dumps(context, indent=2)}</pre>"
        )
        await send_alert_email(subject=subject, body_html=body_html)

    return result
