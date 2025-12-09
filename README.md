# **PDF Markbook System**

A complete end-to-end system for creating, managing, and filling inspection maps on engineering drawings (PDF).
Designed for manufacturing QC teams.

Built with:

* **Next.js + React** — Editor & Viewer
* **FastAPI** — backend API
* **Google Sheets (4-Tab Schema)** — storage layer
* **pdf.js** — PDF rendering
* **pdf-lib / ReportLab** — report generation

---

# 🧭 **1. What This System Does**

The PDF Markbook system has **two user-facing applications**:

### **1. Editor (Marker App)**

Used by engineers to define “mark sets” on a PDF by drawing rectangles, grouping them, naming them, and assigning instruments.

### **2. Viewer (Inspection App)**

Used by field inspectors to:

* Open a drawing
* Select a mark set
* Navigate mark-by-mark
* Enter QC values
* Generate a final annotated PDF/Excel report
* View completion status of users

Both apps share the same backend & sheet storage.

---

# 🧱 **2. High-Level Architecture**

```
┌──────────────────────────────────────────┐
│               Viewer App                 │
│   (Next.js + React + pdf.js windowing)   │
└──────────────────────────────────────────┘
                  ▲
     loads mark_sets, marks, groups, pages
                  │
┌──────────────────────────────────────────┐
│                 API                      │
│   FastAPI + SheetsAdapter + Proxy PDF     │
└──────────────────────────────────────────┘
                  ▲
      CRUD documents/pages/marks/groups
                  │
┌──────────────────────────────────────────┐
│          Google Sheets (4 Tabs)          │
│ documents | pages | mark_sets | marks    │
│ + mark_user_input + inspection_reports    │
└──────────────────────────────────────────┘
                  ▲
                  │
┌──────────────────────────────────────────┐
│         Editor App (Next.js UI)          │
│ Create maps → push marks → groups        │
└──────────────────────────────────────────┘
```

---

# 📂 **3. Sheets Storage Schema (4-Tab System)**

### **`documents`**

Stores PDF metadata.

| Column                  | Description                          |
| ----------------------- | ------------------------------------ |
| doc_id (UUID)           | internal identifier                  |
| project_name            | “Unnati 117”                         |
| id                      | business identifier (Project + Part) |
| part_number             | drawing part no                      |
| pdf_url                 | source PDF (Glide/GCS URL)           |
| page_count              | total pages                          |
| created_by / updated_by | audit                                |

---

### **`pages`**

Stores per-page sizes from PDF metadata.

| Column               | Description    |
| -------------------- | -------------- |
| doc_id               | FK             |
| page_index           | 0-based        |
| width_pt / height_pt | PDF point size |
| rotation_deg         | 0/90/180/270   |

---

### **`mark_sets`**

A PDF can have multiple mark sets:

* 1 master map (template)
* Many QC maps

Each is:

| Column                  | Description          |
| ----------------------- | -------------------- |
| mark_set_id             | UUID                 |
| doc_id                  | FK                   |
| label                   | e.g., “QC – Welding” |
| is_master               | TRUE/FALSE           |
| is_active               | show/hide in viewer  |
| created_by / created_at | audit                |

---

### **`marks`**

Each rectangle drawn in editor.

| Column         | Description                 |
| -------------- | --------------------------- |
| mark_id        | UUID                        |
| mark_set_id    | FK                          |
| page_index     | 0-based                     |
| order_index    | sort within group or master |
| nx, ny, nw, nh | normalized rectangle        |
| label          | text shown to user          |
| instrument     | (e.g., Vernier, Gauge)      |
| anchor         | optional                    |
| padding_pct    | zoom padding                |

---

### **Additional Tables**

(Not required for rendering but used for report generation.)

* `mark_user_input`
* `inspection_reports`

---

# 📌 **4. Backend API Overview (FastAPI)**

Backend routes include:

### **Document initialization**

```
POST /documents/init
```

Creates or fetches `documents` row.

### **Document lookup**

```
GET /documents/by-identifier
```

Used by Viewer Setup Screen.

### **Page sizes**

```
GET /viewer/page-sizes
```

Returns point sizes → avoids expensive pdf.js first-pass scan.

### **Master marks**

```
GET /mark-sets/{id}/marks
```

### **QC groups**

```
GET /viewer/groups/{mark_set_id}
```

Returns:

* groups
* group bounding box
* nested marks (sorted by instrument, label)

### **Proxy for PDF (CORS-safe)**

```
GET /proxy-pdf?url=<gcs-url>
```

Fast streaming of PDF bytes → used by pdf.js.

### **Report builder**

```
POST /reports/generate-bundle
```

---

# 📄 **5. Viewer (Inspection App)**

Built with React + Next.js.
The viewer is extremely optimized for performance on **mobile devices**.

### ✔ Workflow

1. Viewer loads with query params:

   ```
   project_name, id, part_number, user_mail, pdf_url?, mark_set_id?
   ```

2. If no pdf_url → show **Setup Screen**:

   * Calls `/documents/init`
   * Fetches mark_sets
   * For each QC markset fetches `/viewer/groups/{id}` to show total marks

3. After user picks a mark set:

   * Viewer loads PDF via `/proxy-pdf`
   * Loads mark list OR groups (QC mode)
   * Precomputes layout (prefix heights)
   * Renders only visible pages (windowing)

4. Inspector presses **Next / Prev**:

   * Viewer jumps to next mark with zoom logic:

     * Center mark
     * Flash red + persistent yellow
     * Avoid covering with InputPanel

5. At end:

   * ReviewScreen shows all entries
   * User can jump to edit
   * Finally submit → report generated via backend

---

# 🎨 **6. Viewer Rendering Pipeline**

### **Step 1 — Clean PDF URL**

Handles nested encoded Glide/GCS URLs.

### **Step 2 — Proxy Fetch**

PDF loaded from:

```
http://backend/proxy-pdf?url=<clean-url>
```

### **Step 3 — pdf.js document init**

```
const doc = await pdfjsLib.getDocument({ url: proxyUrl }).promise
```

### **Step 4 — Page size strategy**

Two paths:

#### Preferred:

```
GET /viewer/page-sizes
```

→ skip expensive pdf.getPage(i) metadata scans
→ instant load on mobile

Fallback:

```
for page i: await pdf.getPage(i)
```

(used the first time a document is ever processed)

### **Step 5 — Windowing**

Only 3–5 pages are rendered at any time.

### **Step 6 — Double-buffered Canvas (PageCanvas.tsx)**

* front canvas
* back canvas
* overlay canvas
* imageBitmap caching
* DPR clamped for mobile
* max 6MP canvas size to avoid GPU stalls

### **Step 7 — Overlay**

Draws:

* yellow persistent rectangle
* optional red flash for mark navigation

---

# 🖋 **7. Editor (Marker App)**

Used by engineers to create mark sets.

Features:

* Upload / load PDF (via documents.init)
* Draw rectangles
* Resize & reposition
* Assign label, instrument
* Order marks
* Create groups
* Save to Sheets in normalized coords
* Generate QC mark sets cloned from master templates

---

# ⚙️ **8. Performance Design**

The whole system was built for **low-end Android devices** on shop floors.

Key principles:

### ✔ PDF never fetched directly

Always proxied through `/proxy-pdf`.

### ✔ Use page-sizes API to skip page metadata scanning

Huge win on PDFs with 30+ pages.

### ✔ Windowed rendering

Only render 3–5 pages at a time.

### ✔ Double-buffered canvas

No flicker, no blocking, smoother zoom.

### ✔ Global bitmap caching

Stores rendered pages per-zoom-level (max 10).

### ✔ Clamped DPI

Mobile = 1.3–1.5 DPR
Desktop = min(2, devicePixelRatio)

### ✔ Avoid re-render during small zoom deltas

Zoom threshold ~0.03 before re-render.

---

# 🚀 **9. Deployment**

### **Frontend (Editor & Viewer)**

Can be deployed to **Vercel**, **Netlify**, or any Node hosting.

### **Backend**

Can be deployed to:

* Render
* Fly.io
* Railway
* Docker on VM

Requires:

* Python 3.11+
* GOOGLE_SA_JSON (base64)
* SHEETS_SPREADSHEET_ID

---

# 🔧 **10. Environment Variables**

```
# Backend
STORAGE_BACKEND=sheets
GOOGLE_SA_JSON=<base64-service-account>
SHEETS_SPREADSHEET_ID=<google-sheet-id>
ALLOWED_ORIGINS=*

# Frontend
NEXT_PUBLIC_API_BASE=http://localhost:8000
NEXT_PUBLIC_ENV=local
```

---

# 🧪 **11. Local Development**

## Backend

```
cd services/api
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Viewer

```
cd apps/viewer
npm install
npm run dev
```

## Editor

```
cd apps/editor
npm install
npm run dev
```

---

# 🧭 **12. Future Improvements**

* PDF progressive streaming
* Service Worker caching
* Prefetch next-page bytes
* Prefetch group bounding boxes
* Canvas pool instead of create/destroy
* Offline submission queue
* Native App (React Native wrapper)

---

# 🤝 **13. Contributing**

1. Use feature branches
2. Follow conventional commits
3. Add backend integration tests
4. Keep Sheets schema backward-compatible
5. Run Prettier + ESLint before PR

# Future context
#
