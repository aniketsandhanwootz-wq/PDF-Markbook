"""
Complete 4-Tab Google Sheets Setup for PDF Mark System
Handles documents with mixed page sizes and rotations
"""

import os
import gspread
from google.oauth2.service_account import Credentials

# Load from environment
GOOGLE_SA_JSON_PATH = os.getenv(
    "GOOGLE_SA_JSON", 
    "/Users/aniketsandhan/Desktop/PDF_Marker/services/api/creds/sa.json"
)
SHEETS_SPREADSHEET_ID = os.getenv(
    "SHEETS_SPREADSHEET_ID", 
    "1TSeXTmVazO6x3ooms1TjXl55fOuEWaC_QB2BR4KYJmI"
)

print("🔧 Initializing 4-Tab Google Sheets (Full Schema)...")
print(f"📄 Spreadsheet ID: {SHEETS_SPREADSHEET_ID}\n")

# Authenticate
try:
    creds = Credentials.from_service_account_file(
        GOOGLE_SA_JSON_PATH,
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(SHEETS_SPREADSHEET_ID)
    print(f"✓ Connected to spreadsheet: '{spreadsheet.title}'\n")
except Exception as e:
    print(f"✗ Failed to connect: {e}")
    exit(1)

# Define all 4 tabs with proper schema
SHEETS_CONFIG = {
    "documents": {
        "headers": [
            "doc_id",           # Document UUID
            "pdf_url",          # PDF URL
            "page_count",       # Total pages
            "created_by",       # Creator
            "created_at",       # Timestamp
            "updated_at"        # Timestamp
        ],
        "rows": 1000,
        "cols": 10,
        "description": "PDF document metadata"
    },
    "pages": {
        "headers": [
            "page_id",          # Page UUID
            "doc_id",           # Parent document
            "idx",              # 0-based page index
            "width_pt",         # Page width in points
            "height_pt",        # Page height in points
            "rotation_deg"      # 0, 90, 180, or 270
        ],
        "rows": 5000,
        "cols": 10,
        "description": "Individual page dimensions & rotation"
    },
    "mark_sets": {
        "headers": [
            "mark_set_id",      # Mark set UUID
            "doc_id",           # Parent document
            "label",            # Version label
            "is_active",        # Boolean (TRUE/FALSE)
            "created_by",       # Creator
            "created_at"        # Timestamp
        ],
        "rows": 1000,
        "cols": 10,
        "description": "Collections of marks (versions)"
    },
    "marks": {
        "headers": [
            "mark_id",          # Mark UUID
            "mark_set_id",      # Parent mark set
            "page_id",          # Page reference (NOT page_index!)
            "order_index",      # Navigation order
            "name",             # User label
            "nx",               # Normalized x (0-1, unrotated)
            "ny",               # Normalized y (0-1, unrotated)
            "nw",               # Normalized width (0-1)
            "nh",               # Normalized height (0-1)
            "zoom_hint",        # Optional zoom
            "padding_pct",      # Padding percentage
            "anchor"            # Zoom anchor
        ],
        "rows": 10000,
        "cols": 15,
        "description": "Individual marked regions"
    }
}

# Create or verify each tab
created_count = 0
updated_count = 0

for tab_name, config in SHEETS_CONFIG.items():
    try:
        worksheet = spreadsheet.worksheet(tab_name)
        print(f"✓ Tab '{tab_name}' exists")
        
        # Verify and update headers if needed
        existing_headers = worksheet.row_values(1)
        if existing_headers != config['headers']:
            print(f"  ⚠️  Updating headers...")
            range_end = chr(ord('A') + len(config['headers']) - 1)
            worksheet.update(f'A1:{range_end}1', [config['headers']])
            print(f"  ✓ Headers updated")
            updated_count += 1
            
    except gspread.WorksheetNotFound:
        print(f"📝 Creating tab '{tab_name}'...")
        worksheet = spreadsheet.add_worksheet(
            title=tab_name,
            rows=config['rows'],
            cols=config['cols']
        )
        
        # Add headers
        range_end = chr(ord('A') + len(config['headers']) - 1)
        worksheet.update(f'A1:{range_end}1', [config['headers']])
        
        print(f"✅ Created '{tab_name}' - {config['description']}")
        print(f"   └─ {len(config['headers'])} columns, {config['rows']} rows")
        created_count += 1

print("\n" + "="*70)
print("✅ SETUP COMPLETE!")
print("="*70)
print(f"\n📊 Summary:")
print(f"   • Created: {created_count} new tabs")
print(f"   • Updated: {updated_count} existing tabs")
print(f"\n📋 Your 4-Tab Structure:")
print(f"   1️⃣  documents   → Stores PDF metadata")
print(f"   2️⃣  pages       → Stores page dimensions & rotation ⭐")
print(f"   3️⃣  mark_sets   → Stores mark collections")
print(f"   4️⃣  marks       → Stores individual marks")
print(f"\n🎯 Why 4 tabs?")
print(f"   ✓ Handles mixed page sizes (Letter, A4, etc.)")
print(f"   ✓ Handles rotated pages (0°, 90°, 180°, 270°)")
print(f"   ✓ Normalized coordinates work on ANY page")
print(f"   ✓ Future-proof for advanced features")
print(f"\n🚀 Next Steps:")
print(f"   1. View your sheet:")
print(f"      https://docs.google.com/spreadsheets/d/{SHEETS_SPREADSHEET_ID}/edit")
print(f"   2. Update your main.py (I'll provide the code)")
print(f"   3. Start server: uvicorn main:app --reload")
print("\n✨ Your PDF viewer will now handle ANY PDF correctly!")