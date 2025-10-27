# PDF Marker

A production-ready system for marking and navigating regions of interest in PDF documents, with support for multiple storage backends.

## 🌟 Features

### Core Features
- Create, edit and navigate rectangular marks on PDF documents 
- Support for both SQLite (development) and Google Sheets (production) storage
- Mobile-optimized viewer interface
- Dual interface modes: Editor and Viewer
- Normalized coordinate system (0-1 range) for page-independent marking

### Technical Features
- FastAPI backend with storage adapter pattern
- Next.js frontend applications (Editor + Viewer)
- PDF.js integration for rendering
- Automatic retry logic for API calls
- Caching with TTL for improved performance
- Input validation using Pydantic schemas

## 🏗️ System Architecture

```
┌──────────────┐    ┌──────────────┐
│ Editor (3001)│    │ Viewer (3002)│
└──────┬───────┘    └──────┬───────┘
       │                   │
       └─────────┬────────┘
                 ▼
         ┌──────────────┐
         │ FastAPI (8000)│
         └──────┬───────┘
                │
        ┌───────┴────────┐
        ▼                ▼
┌──────────────┐  ┌──────────────┐
│    SQLite    │  │Google Sheets │
└──────────────┘  └──────────────┘
```

## 🚀 Getting Started

### Prerequisites
- Python 3.8+
- Node.js 16+
- Google service account (for Sheets backend)

### Installation

1. **Clone the repository:**
```bash
git clone <repository-url>
cd pdf-marker
```

2. **Set up the API:**
```bash
cd services/api
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
```

3. **Set up the frontend apps:**
```bash
# Editor
cd apps/editor
npm install

# Viewer
cd apps/viewer
npm install
```

### Configuration

Create `.env` in `services/api`:

```bash
# Storage backend (sqlite or sheets)
STORAGE_BACKEND=sqlite

# SQLite settings
DATABASE_URL=sqlite:///data/markbook.db

# Google Sheets settings (if using sheets backend)
GOOGLE_SA_JSON=/path/to/service-account.json
SHEETS_SPREADSHEET_ID=your-spreadsheet-id

# CORS settings
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002
```

### Running the System

1. **Start the API server:**
```bash
cd services/api
uvicorn main:app --reload --port 8000
```

2. **Start the Editor:**
```bash
cd apps/editor
npm run dev
```

3. **Start the Viewer:**
```bash
cd apps/viewer
npm run dev
```

Access:
- Editor: http://localhost:3001
- Viewer: http://localhost:3002 
- API Docs: http://localhost:8000/docs

## 📚 Usage

### Creating Marks
1. Open the Editor (port 3001)
2. Enter a PDF URL
3. Draw rectangles on pages
4. Name each mark
5. Save the mark set

### Viewing Marks
1. Open the Viewer (port 3002)
2. Enter PDF URL and mark set ID
3. Navigate marks using prev/next
4. Use zoom controls to adjust view

## 🔧 Development

### Project Structure
```
├── apps/
│   ├── editor/          # Mark creation interface
│   └── viewer/          # Mark navigation interface
├── services/
│   └── api/
│       ├── adapters/    # Storage implementations
│       ├── core/        # Core logic
│       ├── models/      # Data models
│       ├── routers/     # API routes
│       └── schemas/     # Data validation
└── data/               # SQLite storage (if used)
```

### Mark Schema
```typescript
interface Mark {
  mark_id: string;
  page_index: number;
  order_index: number;
  name: string;
  nx: number;  // Normalized X (0-1)
  ny: number;  // Normalized Y (0-1)
  nw: number;  // Normalized width (0-1)  
  nh: number;  // Normalized height (0-1)
  zoom_hint?: number;
}
```

## 🐛 Troubleshooting

### Common Issues
- **Database Locked**: Restart API server
- **PDF Load Failed**: Check PDF URL accessibility
- **CORS Errors**: Verify ALLOWED_ORIGINS setting

### Performance Tips
- Use SQLite for development/testing
- Enable caching in production
- Keep mark sets under 1000 marks

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

Built with FastAPI, Next.js and PDF.js.