# scaffold_repo.py
# Usage: python scaffold_repo.py
# Creates the pdf-markbook repo skeleton with placeholders, no app code.

import os
from pathlib import Path

ROOT = Path("pdf-markbook")

DIRS = [
    "apps/editor",
    "apps/viewer",
    "services/api/adapters/sqlite",
    "services/api/adapters/json",
    "services/api/adapters/sheets",
    "services/api/adapters/pg",
    "services/api/routers",
    "services/api/models",
    "services/api/schemas",
    "services/api/core",
    "infra/sql",
    "data",
    ".vscode",
]

FILES = {
    "README.md": """# PDF Markbook (MVP)

Local-first repo skeleton. We’ll start with Google Sheets **later**, but keep adapters ready.

## Structure
- apps/editor: Next.js (marking UI)
- apps/viewer: Next.js (mobile walkthrough)
- services/api: FastAPI service (adapters for sqlite/json/sheets/pg)
- infra/sql: logical schema for DB-backed adapters
- data: local data (git-ignored)
- .vscode: local dev tasks & launch configs

## Next steps
1) Open in VS Code
2) Initialize git (see below)
3) Start adding code inside `services/api` and `apps/*`

## Git (first time)
git init
git add .
git commit -m "chore: scaffold repo structure"
git branch -M main
git remote add origin https://github.com/<your-user-or-org>/<repo>.git
git push -u origin main
""",

    ".gitignore": """# Node / Next
node_modules/
.next/
dist/
out/
*.log

# Python
.venv/
__pycache__/
*.pyc

# OS
.DS_Store

# Local data
data/
!data/.keep

# Env files
.env*
""",

    ".vscode/tasks.json": """{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "api: dev",
      "type": "shell",
      "command": "echo Run FastAPI dev server here (uvicorn) once code is ready"
    },
    {
      "label": "editor: dev",
      "type": "shell",
      "command": "echo Run Next.js editor dev server here once code is ready"
    },
    {
      "label": "viewer: dev",
      "type": "shell",
      "command": "echo Run Next.js viewer dev server here once code is ready"
    },
    {
      "label": "dev: all",
      "type": "shell",
      "command": "echo Start API + Editor + Viewer (replace with real commands later)"
    }
  ]
}
""",

    ".vscode/launch.json": """{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: API (attach later)",
      "type": "python",
      "request": "launch",
      "program": "${workspaceFolder}/services/api/main.py",
      "console": "integratedTerminal",
      "justMyCode": true
    },
    {
      "name": "Chrome: Editor (attach later)",
      "type": "pwa-chrome",
      "request": "launch",
      "url": "http://localhost:3001",
      "webRoot": "${workspaceFolder}"
    },
    {
      "name": "Chrome: Viewer (attach later)",
      "type": "pwa-chrome",
      "request": "launch",
      "url": "http://localhost:3002",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
""",

    # --- API placeholders (no implementation, just TODO notes) ---
    "services/api/main.py": '''"""
FastAPI entrypoint (placeholder).
- Mount routers from services/api/routers
- Select storage adapter via settings.STORAGE_BACKEND ("sheets" target later)
- Enable CORS for local editor/viewer ports
"""
''',

    "services/api/settings.py": '''"""
Settings placeholder.
- STORAGE_BACKEND: "sheets" | "sqlite" | "json" | "pg"
- For now default to "sheets" (we'll wire later)
- Add ALLOWED_ORIGINS, and any keys you need in future
"""
STORAGE_BACKEND = "sheets"  # default intention; can switch later
ALLOWED_ORIGINS = ["http://localhost:3001", "http://localhost:3002"]
''',

    "services/api/routers/documents.py": '''"""
Documents router (placeholder).
- POST /documents
- POST /documents/{doc_id}/pages/bootstrap
"""
''',

    "services/api/routers/marks.py": '''"""
Marks router (placeholder).
- POST /mark-sets
- GET /mark-sets/{mark_set_id}/marks
- PATCH /marks/{mark_id}
- POST /mark-sets/{mark_set_id}/activate
"""
''',

    "services/api/models/__init__.py": "",
    "services/api/models/document.py": '"""Document model placeholder."""\n',
    "services/api/models/page.py": '"""Page model placeholder (stores rotation, width/height in points)."""\n',
    "services/api/models/mark_set.py": '"""MarkSet model placeholder (group of marks)."""\n',
    "services/api/models/mark.py": '"""Mark model placeholder (nx, ny, nw, nh, order_index, etc.)."""\n',

    "services/api/schemas/__init__.py": "",
    "services/api/schemas/document.py": '"""Pydantic schemas for documents (placeholder)."""\n',
    "services/api/schemas/page.py": '"""Pydantic schemas for pages (placeholder)."""\n',
    "services/api/schemas/mark_set.py": '"""Pydantic schemas for mark sets (placeholder)."""\n',
    "services/api/schemas/mark.py": '"""Pydantic schemas for marks (placeholder)."""\n',

    "services/api/core/__init__.py": "",
    "services/api/core/validation.py": '''"""
Validation helpers (placeholder).
- Normalized bounds checks: 0<=nx,ny<=1 and 0<nw,nh<=1
- Order uniqueness checks (enforced by adapter)
- Rotation-aware notes (handled by viewer/editor with pdf.js)
"""
''',

    # Adapters (empty placeholders + README stubs)
    "services/api/adapters/sqlite/README.md": "# SQLite adapter (placeholder)\n",
    "services/api/adapters/json/README.md": "# JSON adapter (placeholder)\n",
    "services/api/adapters/sheets/README.md": "# Google Sheets adapter (future primary)\n",
    "services/api/adapters/pg/README.md": "# Postgres/Supabase adapter (future)\n",

    # Infra SQL logical schema (for future DB)
    "infra/sql/001_init.sql": """-- Logical schema for DB adapters (SQLite/Postgres)
-- Keep for future; Google Sheets adapter will mirror these tables semantically.
-- tables: documents, pages, mark_sets, marks
""",

    # Keep file in data/ so the directory is versioned but contents ignored
    "data/.keep": "",
}

def create_tree():
    print(f"Creating repo at: {ROOT.resolve()}")
    ROOT.mkdir(exist_ok=True)

    for d in DIRS:
        path = ROOT / d
        path.mkdir(parents=True, exist_ok=True)

        # drop a .gitkeep so empty dirs are tracked
        gitkeep = path / ".gitkeep"
        if not gitkeep.exists():
            gitkeep.write_text("")

    for rel, content in FILES.items():
        fpath = ROOT / rel
        fpath.parent.mkdir(parents=True, exist_ok=True)
        if not fpath.exists():
            fpath.write_text(content, encoding="utf-8")

    print("Done. Next steps:")
    print("1) cd pdf-markbook")
    print("2) git init && git add . && git commit -m \"chore: scaffold repo structure\"")
    print("3) git branch -M main")
    print("4) git remote add origin https://github.com/<your-user-or-org>/<repo>.git")
    print("5) git push -u origin main")

if __name__ == "__main__":
    create_tree()
