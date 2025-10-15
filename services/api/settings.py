"""
Application settings with environment variable support.
Supports multiple storage backends via STORAGE_BACKEND env var.
"""
import os
from functools import lru_cache
from typing import List
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Storage backend selection
    storage_backend: str = Field(default="sqlite", alias="STORAGE_BACKEND")
    
    # SQLite configuration
    db_url: str = Field(default="sqlite:///data/markbook.db", alias="DB_URL")
    
    # CORS origins (comma-separated)
    allowed_origins: str = Field(
        default="http://localhost:3001,http://localhost:3002",
        alias="ALLOWED_ORIGINS"
    )
    
    # Google Sheets configuration (for future use)
    google_sa_json: str = Field(default="", alias="GOOGLE_SA_JSON")
    sheets_spreadsheet_id: str = Field(default="", alias="SHEETS_SPREADSHEET_ID")
    
    # PostgreSQL configuration (for future use)
    postgres_url: str = Field(default="", alias="POSTGRES_URL")
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
    
    def get_origins_list(self) -> List[str]:
        """Parse comma-separated origins into a list."""
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings instance.
    Using lru_cache ensures we only instantiate settings once.
    """
    return Settings()