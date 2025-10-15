# PDF Markbook - Complete Setup Guide

## 📁 Complete File Structure

```
pdf-markbook/
├── services/
│   └── api/
│       ├── adapters/
│       │   ├── base.py
│       │   ├── sqlite/__init__.py       ✅ Fully working
│       │   ├── json/__init__.py         ✅ Simple file storage
│       │   ├── sheets/__init__.py       🚧 Stub (future)
│       │   └── pg/__init__.py           🚧 Stub (future)
│       ├── routers/
│       │   ├── documents.py
│       │   └── marks.py
│       ├── models/__init__.py
│       ├── schemas/__init__.py
│       ├── core/
│       │   ├── validation.py
│       │   ├── extraction_legacy.py     📄 Provided helper
│       │   └── seed_local.py
│       ├── tests/
│       │   └── test_validation.py
│       ├── settings.py
│       ├── main.py
│       └── requirements.txt
├── apps/
│   ├── editor/                          ✅ Next.js on port 3001
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx
│   │   ├── package.json
│   │   ├── next.config.js
│   │   └── tsconfig.json
│   └── viewer/                          ✅ Next.js on port 3002
│       ├── app/
│       │   ├── layout.tsx
│       │   └── page.tsx
│       ├── package.json
│       ├── next.config.js
│       └── tsconfig.json
├── infra/
│   └── sql/
│       └── 001_init.sql
├── .vscode/
│   ├── tasks.json
│   └── launch.json
├── data/                                📁 Created automatically
│   └── markbook.db                      🗄️ SQLite database
├── .gitignore
├── README.md
└── SETUP.md                             📖 This file
```

## 🚀 First-Time Setup

### Step 1: Install Python Dependencies

```bash
cd services/api
pip install -r requirements.txt
```

**Required packages:**
- fastapi
- uvicorn[standard]
- sqlalchemy
- pydantic
- pydantic-settings

### Step 2: Install Node.js Dependencies

**Editor:**
```bash
cd apps/editor
npm install
```

**Viewer:**
```bash
cd apps/viewer
npm install
```

### Step 3: Verify Installation

```bash
# Check Python
python --version  # Should be 3.11+

# Check Node
node --version    # Should be 18+

# Check installs
cd services/api && python -c "import fastapi; print('FastAPI OK')"
cd apps/editor && npm list next
cd apps/viewer && npm list next
```

## ▶️ Running the System

### Method 1: VSCode Tasks (Recommended)

1. Open project in VSCode
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
3. Type "Tasks: Run Task"
4. Select **"dev: all"**

This starts all three services simultaneously.

### Method 2: Individual Terminals

**Terminal 1 - API:**
```bash
cd services/api
uvicorn main:app --reload --port 8000
```

**Terminal 2 - Editor:**
```bash
cd apps/editor
npm run dev
```

**Terminal 3 - Viewer:**
```bash
cd apps/viewer
npm run dev
```

### Method 3: Python Module

**Run API as module:**
```bash
cd services/api
python -m uvicorn main:app --reload --port 8000
```

## 🧪 Testing the System

### Create Sample Data

```bash
cd services/api
python -m core.seed_local
```

This creates a sample document with marks and prints test URLs.

### Manual Testing

**1. Create marks in the Editor:**
```
http://localhost:3001/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&user_id=test
```

Steps:
- Wait for PDF to load
- Click and drag to draw rectangles
- Enter a name for each mark
- Use ↑/↓ to reorder
- Click "Save Mark Set"
- Copy the `mark_set_id`

**2. View marks in the Viewer:**
```
http://localhost:3002/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&mark_set_id=YOUR_ID
```

Features:
- Navigate with Next/Previous
- Click "List" to see all marks
- Use +/- to zoom
- Click "Save Zoom" to persist preferences

### API Health Check

```bash
curl http://localhost:8000/health
```

Expected response:
```json
{"ok": true, "backend": "sqlite"}
```

## 🔧 Configuration

### Default Configuration

The system works out-of-the-box with SQLite. No configuration needed!

### Custom Configuration

Create `services/api/.env`:

```bash
# Storage backend (sqlite, json, sheets, pg)
STORAGE_BACKEND=sqlite

# Database location
DB_URL=sqlite:///data/markbook.db

# CORS origins
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002

# For Google Sheets (when implemented)
# GOOGLE_SA_JSON=/path/to/service-account.json
# SHEETS_SPREADSHEET_ID=your-spreadsheet-id

# For PostgreSQL (when implemented)
# POSTGRES_URL=postgresql://user:pass@localhost:5432/markbook
```

### Switching Backends

**Use JSON files:**
```bash
STORAGE_BACKEND=json
```

**Use SQLite (default):**
```bash
STORAGE_BACKEND=sqlite
DB_URL=sqlite:///data/markbook.db
```

## 📊 Database Management

### View SQLite Database

```bash
# Install sqlite3 (usually pre-installed on Linux/Mac)
sqlite3 data/markbook.db

# List tables
.tables

# View documents
SELECT * FROM documents;

# View marks with page info
SELECT m.*, p.idx as page_index 
FROM marks m 
JOIN pages p ON m.page_id = p.page_id 
ORDER BY m.order_index;

# Exit
.quit
```

### Reset Database

```bash
# Stop the API first, then:
rm data/markbook.db

# Restart API - tables will be recreated automatically
```

## 🧩 API Examples

### Create Document

```bash
curl -X POST http://localhost:8000/documents \
  -H "Content-Type: application/json" \
  -d '{"pdf_url": "https://example.com/doc.pdf", "created_by": "user123"}'
```

### Bootstrap Pages

```bash
curl -X POST http://localhost:8000/documents/DOC_ID/pages/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "page_count": 2,
    "dims": [
      {"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
      {"idx": 1, "width_pt": 612, "height_pt": 792, "rotation_deg": 0}
    ]
  }'
```

### Create Mark Set

```bash
curl -X POST http://localhost:8000/mark-sets \
  -H "Content-Type: application/json" \
  -d '{
    "doc_id": "DOC_ID",
    "label": "v1",
    "marks": [
      {
        "page_index": 0,
        "order_index": 0,
        "name": "Section 1",
        "nx": 0.1, "ny": 0.1, "nw": 0.5, "nh": 0.3
      }
    ]
  }'
```

### List Marks

```bash
curl http://localhost:8000/mark-sets/MARK_SET_ID/marks
```

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Find and kill process on port 8000
lsof -ti:8000 | xargs kill -9

# Or use different port
uvicorn main:app --reload --port 8001
```

### CORS Errors

Make sure frontend URLs are in `ALLOWED_ORIGINS`:
```bash
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002
```

### Module Import Errors

```bash
# Make sure you're in the right directory
cd services/api
python -c "from settings import get_settings; print(get_settings())"
```

### PDF.js Worker Not Loading

Check browser console. If you see worker errors, the CDN URL might be blocked. The worker URL is:
```
https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
```

### Database Locked (SQLite)

SQLite supports only one writer at a time. If you get "database is locked" errors:
- Close all connections to the database
- Restart the API server
- Consider using PostgreSQL for production

## 📚 Next Steps

1. **Explore the API**: Visit http://localhost:8000/docs for interactive API documentation
2. **Run Tests**: `cd services/api && pytest -v`
3. **Customize**: Modify page designs in `apps/editor/app/page.tsx` and `apps/viewer/app/page.tsx`
4. **Extend**: Add new features following the adapter pattern

## 💡 Tips

- Use `Ctrl+C` to stop each service
- Check terminal logs for errors
- Use browser DevTools Network tab to debug API calls
- SQLite database is in `data/markbook.db` - you can inspect it directly
- Seed script is great for quick testing: `python -m core.seed_local`

## 🤝 Getting Help

- Check README.md for detailed documentation
- Review API docs at http://localhost:8000/docs
- Examine test files for usage examples
- Look at the seed script for API integration patterns

---

**You're all set! Start the system and create your first mark set.** 🎉