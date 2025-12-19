# services/api/settings.py
from pydantic_settings import BaseSettings
from pydantic import ConfigDict, Field
import os
import base64
from typing import List, Optional
from pathlib import Path

class Settings(BaseSettings):
    # Storage settings
    # Default to Google Sheets; you can still override via .env (STORAGE_BACKEND=sqlite)
    storage_backend: str = "sheets"
    google_sa_json: str = ""
    google_sa_json_base64: str = ""
    sheets_spreadsheet_id: str = ""
    db_url: str = "sqlite:///data/markbook.db"
    # ===== CheckIn Sync (secondary confidential sheet) =====
    # Can be spreadsheet_id OR full URL. Example:
    # CHECKIN_SHEETS_SPREADSHEET_ID=https://docs.google.com/spreadsheets/d/<ID>/edit
    checkin_sheets_spreadsheet_id: str = ""

    # Worksheet/tab name to append
    checkin_tab_name: str = "CheckIn"

    # Comma-separated alert recipients for failures (checkin/report/drive)
    checkin_alert_emails: Optional[str] = Field(
        default="aniket.sandhan@wootz.work,vinay.jadon@wootz.work,ayush@wootz.work",
        description="Comma-separated emails to alert on checkin/report/drive failures",
    )

    
    # CORS settings
    allowed_origins: str = "http://localhost:3001,http://localhost:3002,http://localhost:8000,http://localhost:3000"
    
    # Email settings
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "aniket.sandhan@wootz.work"
    smtp_from_name: str = "Wootz Markbook System"

    # 🔴 NEW: comma-separated list of emails that should be CC'd on every inspection mail
    # Example in .env:
    # SMTP_ALWAYS_CC=person1@wootz.work,person2@wootz.work
    smtp_always_cc: Optional[str] = Field(
        default=None,
        description="Comma-separated emails that will be CC'ed on every inspection report",
    )

    # 🔴 NEW: comma-separated list of emails that should be BCC'd on every inspection mail
    # Example in .env:
    # SMTP_ALWAYS_BCC=person1@wootz.work,person2@wootz.work,person3@wootz.work
    smtp_always_bcc: Optional[str] = Field(
        default=None,
        description="Comma-separated emails that will be BCC'ed on every inspection report",
    )

    # Google Drive settings
    gdrive_root_folder_name: str = "Wootz_Markbook"
    # Optional: if you create the root folder manually & share it, put its ID here
    gdrive_root_folder_id: str = ""

    # ---- Annotated map (balloon PDF) settings ----

    # Subfolder under <dwg_num>/ to store annotated PDFs
    # Example final path:
    # Wootz_Markbook/<part__ext__project>/<dwg_num>/Annotated_Maps/<file>.pdf
    gdrive_annotated_maps_subfolder: str = "Annotated_Maps"

    # If TRUE and markset is MASTER, we try to overwrite existing annotated PDF file
    # (keeps same Drive file id/link) when possible.
    gdrive_overwrite_master_annotated_pdf: bool = True

    # Report / generation limits
    # Max number of marks that will be included in a single report (Excel/PDF).
    # This protects against OOM if a map accidentally has too many marks.
    max_marks_per_report: int = 300

    # Max number of heavy report-generation jobs (Excel bundle) running in parallel
    # per application instance. 1 = strictly serialize them (safest).
    max_parallel_reports: int = 1

    model_config = ConfigDict(
        # Always load .env from the same folder as this settings.py
        env_file=str(Path(__file__).resolve().parent / ".env"),
        extra="ignore",
    )

    
    def resolved_google_sa_json(self) -> str:
        """
        Return the path to the service account JSON.
        If GOOGLE_SA_JSON_BASE64 is set, decode it to a temp file.
        Otherwise return GOOGLE_SA_JSON path.
        """
        if self.google_sa_json_base64:
            import tempfile
            import json
            
            decoded = base64.b64decode(self.google_sa_json_base64)
            temp_file = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json')
            temp_file.write(decoded.decode('utf-8'))
            temp_file.close()
            return temp_file.name
        
        return self.google_sa_json
    
    def get_origins_list(self) -> List[str]:
        """Parse comma-separated origins into a list."""
        if not self.allowed_origins:
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


_settings_instance = None

def get_settings() -> Settings:
    """Singleton pattern for settings."""
    global _settings_instance
    if _settings_instance is None:
        _settings_instance = Settings()
    return _settings_instance
