# PDF Markbook - Complete Setup Guide

## 📁 Complete File Structure

Understanding the file structure is crucial for navigating the project effectively. Below is the complete layout of the PDF Markbook project:

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

Setting up the PDF Markbook project involves installing dependencies, verifying installations, and running the system. Follow these steps carefully to ensure a smooth setup.

### Step 1: Install Python Dependencies

To begin, navigate to the API service directory and install the required Python packages. These packages are essential for the backend functionality of the application.

```bash
cd services/api
pip install -r requirements.txt
```

**Required packages:**
- **fastapi**: A modern web framework for building APIs with Python 3.6+ based on standard Python type hints.
- **uvicorn[standard]**: An ASGI server for running FastAPI applications.
- **sqlalchemy**: A SQL toolkit and Object-Relational Mapping (ORM) system for Python.
- **pydantic**: Data validation and settings management using Python type annotations.
- **pydantic-settings**: A library for managing settings in Python applications.

### Step 2: Install Node.js Dependencies

Next, you need to install the necessary Node.js packages for both the editor and viewer applications. These packages are required for the frontend functionality.

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

After installing the dependencies, it's important to verify that everything is set up correctly. Run the following commands to check the versions of Python and Node.js, as well as to confirm that the necessary packages are installed.

```bash
# Check Python version
python --version  # Should be 3.11+

# Check Node version
node --version    # Should be 18+

# Check FastAPI installation
cd services/api && python -c "import fastapi; print('FastAPI OK')"

# Check Next.js installation in Editor
cd apps/editor && npm list next

# Check Next.js installation in Viewer
cd apps/viewer && npm list next
```

## ▶️ Running the System

Once the setup is complete, you can run the system using one of the following methods. Each method has its advantages, so choose the one that best fits your workflow.

### Method 1: VSCode Tasks (Recommended)

Using VSCode tasks is the most convenient way to start all services simultaneously. Follow these steps:

1. Open the project in Visual Studio Code.
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac) to open the command palette.
3. Type "Tasks: Run Task" and select it.
4. Choose **"dev: all"** from the list of tasks.

This will start all three services (API, Editor, and Viewer) in separate terminals.

### Method 2: Individual Terminals

If you prefer to run each service in its own terminal, follow these commands:

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

You can also run the API as a Python module. This method is useful for debugging or when you want to run the API without using Uvicorn directly.

**Run API as module:**
```bash
cd services/api
python -m uvicorn main:app --reload --port 8000
```

## 🧪 Testing the System

After running the system, it's a good idea to create some sample data and perform manual testing to ensure everything is functioning as expected.

### Create Sample Data

To create sample documents and marks for testing, run the following command:

```bash
cd services/api
python -m core.seed_local
```

This command will generate a sample document with marks and print test URLs for easy access.

### Manual Testing

You can manually test the editor and viewer by following these steps:

**1. Create marks in the Editor:**
Open your browser and navigate to the following URL:
```
http://localhost:3001/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&user_id=test
```

**Steps:**
- Wait for the PDF to load completely.
- Click and drag to draw rectangles on the PDF.
- Enter a name for each mark you create.
- Use the ↑/↓ keys to reorder the marks as needed.
- Click "Save Mark Set" to save your marks.
- Copy the `mark_set_id` provided after saving.

**2. View marks in the Viewer:**
Open another tab and navigate to:
```
http://localhost:3002/?pdf_url=https://arxiv.org/pdf/1706.03762.pdf&mark_set_id=YOUR_ID
```
Replace `YOUR_ID` with the `mark_set_id` you copied earlier.

**Features:**
- Navigate through marks using the Next/Previous buttons.
- Click "List" to see all marks associated with the document.
- Use the +/- buttons to zoom in and out of the PDF.
- Click "Save Zoom" to persist your zoom preferences.

### API Health Check

To ensure that the API is running correctly, you can perform a health check using the following command:

```bash
curl http://localhost:8000/health
```

**Expected response:**
```json
{"ok": true, "backend": "sqlite"}
```

This response indicates that the API is operational and connected to the SQLite backend.

## 🔧 Configuration

### Default Configuration

The system is designed to work out-of-the-box with SQLite as the default storage backend. No additional configuration is needed for basic functionality.

### Custom Configuration

If you wish to customize the configuration, create a `.env` file in the `services/api` directory with the following parameters:

```bash
# Storage backend options: sqlite, json, sheets, pg
STORAGE_BACKEND=sqlite

# Database location
DB_URL=sqlite:///data/markbook.db

# CORS origins for frontend applications
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002

# For Google Sheets (when implemented)
# GOOGLE_SA_JSON=/path/to/service-account.json
# SHEETS_SPREADSHEET_ID=your-spreadsheet-id

# For PostgreSQL (when implemented)
# POSTGRES_URL=postgresql://user:pass@localhost:5432/markbook
```

### Switching Backends

To switch between different storage backends, modify the `STORAGE_BACKEND` variable in your `.env` file:

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

Managing the SQLite database is straightforward. Below are commands to view and manipulate the database.

### View SQLite Database

To view the SQLite database, you can use the `sqlite3` command-line tool. If it's not installed, you can usually find it pre-installed on Linux and Mac systems.

```bash
# Open the SQLite database
sqlite3 data/markbook.db

# List all tables in the database
.tables

# View documents in the database
SELECT * FROM documents;

# View marks along with page information
SELECT m.*, p.idx as page_index 
FROM marks m 
JOIN pages p ON m.page_id = p.page_id 
ORDER BY m.order_index;

# Exit the SQLite prompt
.quit
```

### Reset Database

If you need to reset the database (for example, during development), follow these steps:

1. Stop the API server first.
2. Remove the existing database file:
   ```bash
   rm data/markbook.db
   ```
3. Restart the API server. The tables will be recreated automatically.

## 🧩 API Examples

The API provides various endpoints for interacting with documents and marks. Below are examples of how to use these endpoints.

### Create Document

To create a new document, use the following `curl` command:

```bash
curl -X POST http://localhost:8000/documents \
  -H "Content-Type: application/json" \
  -d '{"pdf_url": "https://example.com/doc.pdf", "created_by": "user123"}'
```

### Bootstrap Pages

To bootstrap pages for a document, use the following command:

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

To create a new mark set, use the following command:

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

To list all marks in a specific mark set, use the following command:

```bash
curl http://localhost:8000/mark-sets/MARK_SET_ID/marks
```

## 🐛 Troubleshooting

If you encounter issues while running the system, refer to the troubleshooting section below for common problems and their solutions.

### Port Already in Use

If you receive an error indicating that the port is already in use, you can find and kill the process using the following command:

```bash
# Find and kill process on port 8000
lsof -ti:8000 | xargs kill -9

# Alternatively, you can run the API on a different port
uvicorn main:app --reload --port 8001
```

### CORS Errors

If you encounter CORS errors, ensure that the frontend URLs are included in the `ALLOWED_ORIGINS` variable in your `.env` file:

```bash
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002
```

### Module Import Errors

If you experience module import errors, ensure you are in the correct directory:

```bash
# Navigate to the API service directory
cd services/api

# Test the settings import
python -c "from settings import get_settings; print(get_settings())"
```

### PDF.js Worker Not Loading

If you see errors related to the PDF.js worker in your browser console, it may be due to the worker URL being blocked. The worker URL is:
```
https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
```

### Database Locked (SQLite)

SQLite supports only one writer at a time. If you encounter "database is locked" errors:
- Close all connections to the database.
- Restart the API server.
- For production, consider using PostgreSQL to avoid this limitation.

## 📚 Next Steps

After successfully setting up the system, consider the following next steps to further explore and utilize the PDF Markbook:

1. **Explore the API**: Visit the interactive API documentation at http://localhost:8000/docs to learn about available endpoints and their usage.
2. **Run Tests**: Ensure the system is functioning correctly by running tests. Navigate to the API service directory and execute:
   ```bash
   cd services/api && pytest -v
   ```
3. **Customize the UI**: Modify the page designs in `apps/editor/app/page.tsx` and `apps/viewer/app/page.tsx` to tailor the user experience to your needs.
4. **Extend Functionality**: Consider adding new features following the adapter pattern to enhance the capabilities of the application.

## 💡 Tips

- Use `Ctrl+C` to stop each service when you're done testing.
- Check terminal logs for any errors or warnings that may arise during execution.
- Utilize the browser's DevTools Network tab to debug API calls and monitor requests/responses.
- The SQLite database file is located in `data/markbook.db`, and you can inspect it directly using SQLite tools.
- The seed script is a great way to quickly populate the database with test data: `python -m core.seed_local`.

## 🤝 Getting Help

If you need assistance, consider the following resources:

- Review the README.md for detailed documentation on setup and usage.
- Check the API documentation at http://localhost:8000/docs for endpoint details and examples.
- Examine test files for usage examples and best practices.
- Look at the seed script for patterns on how to integrate with the API.

---

**You're all set! Start the system and create your first mark set.** 🎉