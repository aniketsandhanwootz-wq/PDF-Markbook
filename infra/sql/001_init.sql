-- PDF Markbook Database Schema
-- Compatible with SQLite and PostgreSQL
-- For PostgreSQL: replace TEXT with VARCHAR where appropriate, use UUID type

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    pdf_url TEXT NOT NULL,
    page_count INTEGER,
    created_by TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
    page_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    idx INTEGER NOT NULL,  -- 0-based page index
    width_pt REAL NOT NULL,  -- Page width in points (unrotated)
    height_pt REAL NOT NULL,  -- Page height in points (unrotated)
    rotation_deg INTEGER NOT NULL DEFAULT 0,  -- 0, 90, 180, or 270
    FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    UNIQUE (doc_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_pages_doc_id ON pages(doc_id);

-- Mark sets table
CREATE TABLE IF NOT EXISTS mark_sets (
    mark_set_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'v1',
    is_active BOOLEAN NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marksets_doc_id ON mark_sets(doc_id);
CREATE INDEX IF NOT EXISTS idx_marksets_active ON mark_sets(doc_id, is_active);

-- Marks table
CREATE TABLE IF NOT EXISTS marks (
    mark_id TEXT PRIMARY KEY,
    mark_set_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,  -- Navigation order
    name TEXT NOT NULL,  -- User-friendly label
    
    -- Normalized coordinates (0-1 range, relative to unrotated page)
    nx REAL NOT NULL CHECK (nx >= 0 AND nx <= 1),
    ny REAL NOT NULL CHECK (ny >= 0 AND ny <= 1),
    nw REAL NOT NULL CHECK (nw > 0 AND nw <= 1),
    nh REAL NOT NULL CHECK (nh > 0 AND nh <= 1),
    
    -- Display preferences
    zoom_hint REAL,  -- Custom zoom multiplier
    padding_pct REAL NOT NULL DEFAULT 0.1,  -- Padding percentage
    anchor TEXT NOT NULL DEFAULT 'auto',  -- 'auto', 'center', or 'top-left'
    
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (mark_set_id) REFERENCES mark_sets(mark_set_id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE,
    UNIQUE (mark_set_id, order_index)
);

CREATE INDEX IF NOT EXISTS idx_marks_mark_set_id ON marks(mark_set_id);
CREATE INDEX IF NOT EXISTS idx_marks_page_id ON marks(page_id);
CREATE INDEX IF NOT EXISTS idx_marks_order ON marks(mark_set_id, order_index);

-- Comments for documentation
-- 
-- Coordinate System:
-- All mark coordinates (nx, ny, nw, nh) are normalized to [0,1] range
-- relative to the UNROTATED page dimensions (width_pt x height_pt).
-- This ensures coordinates remain valid regardless of page rotation.
--
-- When rendering:
-- 1. Get page dimensions and rotation from pages table
-- 2. Apply rotation transform to coordinates
-- 3. Scale to viewport/canvas dimensions
--
-- Navigation:
-- Marks are ordered by order_index within each mark_set
-- Use ORDER BY order_index when fetching marks for sequential navigation