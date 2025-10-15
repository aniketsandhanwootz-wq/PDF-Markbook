# PDF Markbook (MVP)

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
