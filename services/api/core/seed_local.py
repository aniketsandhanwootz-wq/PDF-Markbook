"""
Seed script for local testing of PDF Markbook.
Creates a sample document with pages and marks for quick testing.

Usage:
    python -m core.seed_local
"""
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from settings import get_settings
from adapters.sqlite import SqliteAdapter
from adapters.json import JsonAdapter

# Sample PDF (publicly accessible)
SAMPLE_PDF = "https://arxiv.org/pdf/1706.03762.pdf"  # "Attention is All You Need" paper

def seed():
    """Create sample data for testing."""
    print("🌱 Seeding PDF Markbook...")
    
    # Get settings and adapter
    settings = get_settings()
    print(f"📦 Using {settings.storage_backend} backend")
    
    if settings.storage_backend == "sqlite":
        adapter = SqliteAdapter(settings.db_url)
    elif settings.storage_backend == "json":
        adapter = JsonAdapter("data")
    else:
        print(f"❌ Seeding not implemented for {settings.storage_backend}")
        return
    
    # Create document
    print(f"📄 Creating document for {SAMPLE_PDF}...")
    doc_id = adapter.create_document(
        pdf_url=SAMPLE_PDF,
        created_by="seed_script"
    )
    print(f"✅ Document created: {doc_id}")
    
    # Bootstrap pages (mock dimensions for the first 3 pages)
    print("📐 Bootstrapping pages...")
    page_dims = [
        {"idx": 0, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
        {"idx": 1, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
        {"idx": 2, "width_pt": 612, "height_pt": 792, "rotation_deg": 0},
    ]
    adapter.bootstrap_pages(doc_id, 3, page_dims)
    print("✅ Pages bootstrapped")
    
    # Create mark set with sample marks
    print("🎯 Creating mark set...")
    marks = [
        {
            "page_index": 0,
            "order_index": 0,
            "name": "Title",
            "nx": 0.1,
            "ny": 0.1,
            "nw": 0.8,
            "nh": 0.15,
            "padding_pct": 0.1,
            "anchor": "auto"
        },
        {
            "page_index": 0,
            "order_index": 1,
            "name": "Abstract",
            "nx": 0.1,
            "ny": 0.3,
            "nw": 0.8,
            "nh": 0.2,
            "padding_pct": 0.1,
            "anchor": "auto"
        },
        {
            "page_index": 1,
            "order_index": 2,
            "name": "Introduction",
            "nx": 0.1,
            "ny": 0.1,
            "nw": 0.8,
            "nh": 0.3,
            "padding_pct": 0.1,
            "anchor": "auto"
        }
    ]
    
    mark_set_id = adapter.create_mark_set(
        doc_id=doc_id,
        label="sample_v1",
        marks=marks,
        created_by="seed_script"
    )
    print(f"✅ Mark set created: {mark_set_id}")
    
    # Activate the mark set
    print("🔄 Activating mark set...")
    adapter.activate_mark_set(mark_set_id)
    print("✅ Mark set activated")
    
    print("\n" + "="*60)
    print("🎉 Seeding complete!")
    print("="*60)
    print(f"\n📋 Document ID: {doc_id}")
    print(f"📋 Mark Set ID: {mark_set_id}")
    print(f"\n🔗 Test URLs:")
    print(f"   Editor:  http://localhost:3001/?pdf_url={SAMPLE_PDF}&user_id=test")
    print(f"   Viewer:  http://localhost:3002/?pdf_url={SAMPLE_PDF}&mark_set_id={mark_set_id}")
    print()


if __name__ == "__main__":
    seed()