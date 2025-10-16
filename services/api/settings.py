"""
Application settings with environment variable support.
Supports SQLite, Google Sheets, JSON, and Postgres backends.
"""

from __future__ import annotations

import base64
from functools import lru_cache
from typing import List, Optional

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Backend selection
    storage_backend: str = Field(default="sqlite", alias="STORAGE_BACKEND")

    # SQLite / generic
    db_url: str = Field(default="sqlite:///data/markbook.db", alias="DB_URL")

    # Google Sheets
    google_sa_json: Optional[str] = Field(default=None, alias="GOOGLE_SA_JSON")          # path or inline JSON
    google_sa_json_b64: Optional[str] = Field(default=None, alias="GOOGLE_SA_JSON_B64")  # base64 (optional)
    sheets_spreadsheet_id: Optional[str] = Field(default=None, alias="SHEETS_SPREADSHEET_ID")

    # Postgres (future)
    postgres_url: Optional[str] = Field(default=None, alias="POSTGRES_URL")

    # CORS
    allowed_origins: str = Field(
        default="http://localhost:3001,http://localhost:3002",
        alias="ALLOWED_ORIGINS",
    )

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False

    def get_origins_list(self) -> List[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    def resolved_google_sa_json(self) -> Optional[str]:
        """
        Prefer base64 (single line). If provided, return decoded JSON text.
        Otherwise return GOOGLE_SA_JSON as-is (path or inline JSON).
        """
        if self.google_sa_json_b64:
            try:
                return base64.b64decode(self.google_sa_json_b64).decode("utf-8")
            except Exception:
                # If decoding fails, fall back to raw
                pass
        return self.google_sa_json


@lru_cache()
def get_settings() -> Settings:
    return Settings()
