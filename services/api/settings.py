"""
Settings placeholder.
- STORAGE_BACKEND: "sheets" | "sqlite" | "json" | "pg"
- For now default to "sheets" (we'll wire later)
- Add ALLOWED_ORIGINS, and any keys you need in future
"""
STORAGE_BACKEND = "sheets"  # default intention; can switch later
ALLOWED_ORIGINS = ["http://localhost:3001", "http://localhost:3002"]
