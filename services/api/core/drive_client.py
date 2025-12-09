# services/api/core/drive_client.py
from __future__ import annotations
import logging
import os
import json
from io import BytesIO
from typing import Optional
from pathlib import Path

from google.oauth2.credentials import Credentials as UserCredentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload


from settings import get_settings

logger = logging.getLogger(__name__)

_drive_service = None

# We only need "drive.file" – upload + manage files created by this app
SCOPES = ["https://www.googleapis.com/auth/drive.file"]

# Paths relative to services/api/
BASE_DIR = Path(__file__).resolve().parent.parent
CREDS_DIR = BASE_DIR / "creds"
TOKEN_FILE = CREDS_DIR / "drive_token.json"


def _get_drive_credentials() -> UserCredentials:
    """
    Load user OAuth credentials.

    Priority:
    1) If DRIVE_TOKEN_JSON env var is set (Render/prod), use that.
    2) Else, fall back to local creds/drive_token.json (dev).
    """
    token_env = os.getenv("DRIVE_TOKEN_JSON")

    # 1) Prefer env var (Render, or if you ever set it locally)
    if token_env:
        try:
            info = json.loads(token_env)
            creds = UserCredentials.from_authorized_user_info(info, SCOPES)
        except Exception as e:
            logger.exception("Failed to load DRIVE_TOKEN_JSON from env: %s", e)
            raise
    else:
        # 2) Fallback: local token file (dev)
        if not TOKEN_FILE.exists():
            msg = (
                f"Drive token not found in env or at {TOKEN_FILE}. "
                "Either set DRIVE_TOKEN_JSON or run drive_oauth_init.py once."
            )
            logger.error(msg)
            raise RuntimeError(msg)

        creds = UserCredentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    # Refresh if expired and we have a refresh token
    if creds.expired and creds.refresh_token:
        try:
            logger.info("Refreshing Google Drive OAuth token...")
            creds.refresh(Request())

            # If we are using file-based creds (dev), persist refreshed token
            if not token_env:
                CREDS_DIR.mkdir(parents=True, exist_ok=True)
                TOKEN_FILE.write_text(creds.to_json())
                logger.info("Google Drive OAuth token refreshed and saved.")
            else:
                logger.info("Drive OAuth token refreshed (env-based creds, not writing to disk).")
        except Exception as e:
            logger.exception("Failed to refresh Drive OAuth token: %s", e)
            raise

    return creds



def get_drive_service():
    """
    Lazily construct and cache a Google Drive v3 service client
    using the OAuth user credentials (your personal Google account).
    """
    global _drive_service
    if _drive_service is None:
        creds = _get_drive_credentials()
        _drive_service = build(
            "drive",
            "v3",
            credentials=creds,
            cache_discovery=False,
        )
        logger.info("Initialized Google Drive client using OAuth user credentials.")
    return _drive_service


def _safe_segment(value: str, fallback: str = "UNKNOWN") -> str:
    """
    Clean folder/file name segments so Drive accepts them nicely.
    """
    if not value:
        return fallback
    v = value.strip()
    if not v:
        return fallback
    # avoid slashes and crazy chars in folder names
    v = v.replace("/", "_").replace("\\", "_")
    # keep names reasonable length
    return v[:120]


def _ensure_folder(service, name: str, parent_id: Optional[str] = None) -> str:
    """
    Find (or create) a folder with given name under parent_id (or My Drive root).
    Returns the folder ID.
    """
    folder_name = name.strip()
    if not folder_name:
        folder_name = "UNTITLED"

    # Search for existing folder
    # NOTE: escape single quotes once and reuse
    safe_name = folder_name.replace("'", "\\'")
    if parent_id:
        q = (
            "mimeType = 'application/vnd.google-apps.folder' "
            f"and name = '{safe_name}' "
            f"and '{parent_id}' in parents "
            "and trashed = false"
        )
    else:
        q = (
            "mimeType = 'application/vnd.google-apps.folder' "
            f"and name = '{safe_name}' "
            "and trashed = false"
        )

    result = service.files().list(
        q=q,
        spaces="drive",
        fields="files(id, name)",
        pageSize=1,
    ).execute()

    files = result.get("files", [])
    if files:
        return files[0]["id"]

    # Not found → create
    metadata = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        metadata["parents"] = [parent_id]

    created = service.files().create(
        body=metadata,
        fields="id",
    ).execute()
    return created["id"]


def upload_report_excel_to_drive(
    *,
    excel_bytes: bytes,
    project_name: str,
    external_id: str,
    part_number: str,
    dwg_num: str,
    mark_set_label: str,
    user_email: str,
) -> Optional[str]:
    """
    Upload the generated Excel to Google Drive using the folder structure:

    Wootz_Markbook/
        <part_number>__<external_id>__<project_name>/
            <dwg_num>/
                <mark_set_label>-<user_email>.xlsx

    Returns a direct download URL (https://drive.google.com/uc?export=download&id=...)
    or None if upload fails.
    """
    try:
        settings = get_settings()
        service = get_drive_service()

        # 1) Root folder: Wootz_Markbook (or configured override)
        root_folder_id = (
            settings.gdrive_root_folder_id.strip()
            if getattr(settings, "gdrive_root_folder_id", None)
            else ""
        )
        if not root_folder_id:
            root_name = getattr(settings, "gdrive_root_folder_name", None) or "Wootz_Markbook"
            root_folder_id = _ensure_folder(service, root_name, parent_id=None)

        # 2) Project/business-key folder
        proj_segment = "__".join(
            [
                _safe_segment(part_number, "NO_PART"),
                _safe_segment(external_id, "NO_EXT"),
                _safe_segment(project_name, "NO_PROJECT"),
            ]
        )
        proj_folder_id = _ensure_folder(service, proj_segment, parent_id=root_folder_id)

        # 3) Drawing folder (dwg_num)
        dwg_segment = _safe_segment(dwg_num or "NO_DWG", "NO_DWG")
        dwg_folder_id = _ensure_folder(service, dwg_segment, parent_id=proj_folder_id)

        # 4) File name: <MarksetName>-<user_email>.xlsx
        file_name = (
            f"{_safe_segment(mark_set_label or 'Markset', 'Markset')}-"
            f"{_safe_segment(user_email or 'user', 'user')}.xlsx"
        )

        media = MediaIoBaseUpload(
            BytesIO(excel_bytes),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            resumable=False,
        )

        file_metadata = {
            "name": file_name,
            "parents": [dwg_folder_id],
        }

        created = service.files().create(
            body=file_metadata,
            media_body=media,
            fields="id, webViewLink, webContentLink",
        ).execute()

        file_id = created["id"]

        # Make it downloadable by link (anyone with the link can read)
        try:
            service.permissions().create(
                fileId=file_id,
                body={"role": "reader", "type": "anyone"},
                fields="id",
            ).execute()
        except Exception as e:
            logger.warning(
                "Failed to set public permission for report file %s: %s", file_id, e
            )

        download_url = f"https://drive.google.com/uc?export=download&id={file_id}"
        logger.info("Uploaded report to Drive file_id=%s", file_id)
        return download_url

    except Exception as e:
        logger.exception("Failed to upload report Excel to Drive: %s", e)
        return None
