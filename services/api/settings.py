# services/api/settings.py
from pydantic_settings import BaseSettings
from pydantic import ConfigDict
import os
import base64
from typing import List

class Settings(BaseSettings):
    # Storage settings
    # Default to Google Sheets; you can still override via .env (STORAGE_BACKEND=sqlite)
    storage_backend: str = "sheets"
    google_sa_json: str = ""
    google_sa_json_base64: str = ""
    sheets_spreadsheet_id: str = ""
    db_url: str = "sqlite:///data/markbook.db"
    
    # CORS settings
    allowed_origins: str = "http://localhost:3001,http://localhost:3002,http://localhost:8000,http://localhost:3000"
    
    # Email settings
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "aniket.sandhan@wootz.work"
    smtp_from_name: str = "Wootz Markbook System"
    
    # Report / generation limits
    # Max number of marks that will be included in a single report (Excel/PDF).
    # This protects against OOM if a map accidentally has too many marks.
    max_marks_per_report: int = 300

    # Max number of heavy report-generation jobs (Excel bundle) running in parallel
    # per application instance. 1 = strictly serialize them (safest).
    max_parallel_reports: int = 1

    model_config = ConfigDict(
        env_file=".env",
        extra='ignore'  # Changed from 'forbid' to 'ignore'
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