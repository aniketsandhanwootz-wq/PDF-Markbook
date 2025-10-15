# PDF Markbook

A local-first system for creating and viewing marked regions of interest in PDF documents. Built with FastAPI, Next.js, and SQLite.

## Features

- 📝 **Editor**: Draw rectangular regions on PDF pages and save them as mark sets
- 👁️ **Viewer**: Navigate through marked regions with automatic zoom-to-fit
- 🔄 **Flexible Storage**: SQLite by default, with adapter pattern for Google Sheets or PostgreSQL
- 📐 **Rotation-Aware**: Coordinates are normalized to handle page rotation correctly
- 🎯 **Smart Navigation**: Sequential mark navigation with customizable zoom levels

## Architecture

```
pdf-markbook/
├── apps/
│   ├── editor/          # Next.js app for creating mark sets (port 3001)
│   └── viewer/          # Next.js app for viewing mark sets (port 3002)
├── services/
│   └── api/             # FastAPI backend (port 8000)
│       ├── adapters/    # Storage adapters (SQLite, JSON, Sheets, Postgres)
│       ├── routers/     # API endpoints
│       ├── models/      # Domain models
│       ├── schemas/     # Pydantic I/O schemas
│       └── core/        # Validation and utilities
├── data/                # SQLite database and JSON files
└── infra/
    └── sql/             # Database schema
```

## Prerequisites

- **Python 3.11+** with pip
- **Node.js 18+** with npm
- **Git**

## Quick Start

### 1. Install Dependencies

**Backend (FastAPI):**
```bash
cd services/api
pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings
```

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

### 2. Run Everything

**Option A: Use VSCode Tasks (Recommended)**

1. Open the project in VSCode
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Select "Tasks: Run Task" → "dev: all"

This starts all three services in parallel.

**Option B: Manual Start**

In three separate terminals:

```bash
# Terminal 1: API
cd services/api
uvicorn main:app --reload --port 8000

# Terminal 2: Editor
cd apps/editor
npm run dev

# Terminal 3: Viewer
cd apps/viewer
npm run dev
```

### 3. Test the System

**Create a Mark Set:**
1. Open [http://localhost:3001/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&user_id=test](http://localhost:3001/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&user_id=test)
2. Click and drag to draw rectangles on the PDF
3. Name each mark when prompted
4. Reorder marks using ↑ / ↓ buttons
5. Click "Save Mark Set"
6. Copy the `mark_set_id` from the alert

**View the Mark Set:**
1. Open [http://localhost:3002/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&mark_set_id=YOUR_MARK_SET_ID](http://localhost:3002/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&mark_set_id=YOUR_MARK_SET_ID)
2. Navigate with Next/Previous buttons
3. Use the List button to jump to specific marks
4. Adjust zoom with +/- and save custom zoom levels

## API Endpoints

### Documents
- `POST /documents` - Create a document
- `POST /documents/{doc_id}/pages/bootstrap` - Add page dimensions

### Mark Sets & Marks
- `POST /mark-sets` - Create a mark set with marks
- `GET /mark-sets/{mark_set_id}/marks` - List marks (ordered)
- `PATCH /marks/{mark_id}` - Update mark display preferences
- `POST /mark-sets/{mark_set_id}/activate` - Activate a mark set

### Health
- `GET /health` - Check API status

## Configuration

### Environment Variables

Create a `.env` file in `services/api/`:

```bash
# Storage backend: sqlite, json, sheets, or pg
STORAGE_BACKEND=sqlite

# SQLite database path
DB_URL=sqlite:///data/markbook.db

# CORS origins (comma-separated)
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002

# For Google Sheets (future)
# GOOGLE_SA_JSON={"type":"service_account",...}
# SHEETS_SPREADSHEET_ID=your-spreadsheet-id

# For PostgreSQL (future)
# POSTGRES_URL=postgresql://user:pass@host:5432/dbname
```

### Switching Storage Backends

**Use JSON files (for quick testing):**
```bash
STORAGE_BACKEND=json
```

**Use Google Sheets (when implemented):**
```bash
STORAGE_BACKEND=sheets
GOOGLE_SA_JSON=path/to/service-account.json
SHEETS_SPREADSHEET_ID=your-spreadsheet-id
```

**Use PostgreSQL (when implemented):**
```bash
STORAGE_BACKEND=pg
POSTGRES_URL=postgresql://user:pass@localhost:5432/markbook
```

## Coordinate System

All mark coordinates are **normalized** to the range [0, 1] relative to the **unrotated** page dimensions. This ensures coordinates remain valid regardless of page rotation.

- `nx`, `ny`: Normalized x and y position (top-left corner)
- `nw`, `nh`: Normalized width and height
- Rotation is handled automatically during rendering

## Development

### Project Structure

- **Adapters Pattern**: Storage backends implement `StorageAdapter` protocol
- **Clean Layering**: Routers → Core (validation) → Adapters (storage)
- **Type Safety**: Pydantic schemas for validation, TypeScript for frontends
- **Extensibility**: Easy to add new mark shapes or features

### Adding a New Feature

1. Update domain models if needed (`services/api/models/`)
2. Add validation logic (`services/api/core/validation.py`)
3. Implement in storage adapters (`services/api/adapters/*/`)
4. Add API endpoints (`services/api/routers/`)
5. Update frontend UI

### Testing

**Backend Tests:**
```bash
cd services/api
pytest
```

**Run individual tests:**
```bash
pytest -v -k test_validate_normalized_rect
```

## Database Schema

See `infra/sql/001_init.sql` for the complete schema.

**Key tables:**
- `documents` - PDF documents
- `pages` - Page dimensions and rotation
- `mark_sets` - Collections of marks (only one active per document)
- `marks` - Rectangular regions with normalized coordinates

## Troubleshooting

**"Module not found" errors:**
- Ensure you're in the correct directory
- Run `pip install -r requirements.txt` for Python dependencies
- Run `npm install` for Node.js dependencies

**CORS errors:**
- Check that `ALLOWED_ORIGINS` includes your frontend URLs
- Restart the API server after changing environment variables

**PDF not loading:**
- Ensure the PDF URL is publicly accessible
- Check browser console for errors
- Verify PDF.js worker is loading correctly

**Database locked (SQLite):**
- Only one writer at a time; close other connections
- Consider switching to PostgreSQL for concurrent access

## Future Enhancements

- [ ] Implement Google Sheets adapter
- [ ] Implement PostgreSQL adapter
- [ ] Add polygon marks (non-rectangular regions)
- [ ] Add thumbnail previews
- [ ] Support for mark annotations/notes
- [ ] Export mark sets to JSON
- [ ] Import mark sets from JSON
- [ ] Multi-user collaboration features
- [ ] Authentication and authorization

## License

MIT

## Support

For issues, questions, or contributions, please open an issue on GitHub.