"""
JSON file storage adapter for PDF Markbook.
Simple file-based storage for quick demos and testing.
Not production-ready (no proper locking, not suitable for concurrent access).
"""
import os
import json
import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional
from pathlib import Path
from fastapi import HTTPException


class JsonAdapter:
    """
    JSON file-based storage adapter.
    Stores data in separate JSON files under the data directory.
    Uses atomic file operations for basic consistency.
    """
    
    def __init__(self, data_dir: str = "data"):
        """
        Initialize the JSON adapter.
        
        Args:
            data_dir: Directory to store JSON files
        """
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        # File paths
        self.documents_file = self.data_dir / "documents.json"
        self.pages_file = self.data_dir / "pages.json"
        self.mark_sets_file = self.data_dir / "mark_sets.json"
        self.marks_file = self.data_dir / "marks.json"
        
        # Initialize files if they don't exist
        for file in [self.documents_file, self.pages_file, self.mark_sets_file, self.marks_file]:
            if not file.exists():
                self._write_file(file, [])
    
    def _read_file(self, filepath: Path) -> List[Dict[str, Any]]:
        """Read and parse a JSON file."""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return []
    
    def _write_file(self, filepath: Path, data: List[Dict[str, Any]]) -> None:
        """Write data to a JSON file atomically."""
        # Write to temporary file first
        tmp_file = filepath.with_suffix(".tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        
        # Atomic rename
        tmp_file.replace(filepath)
    
    def create_document(self, pdf_url: str, created_by: Optional[str] = None) -> str:
        """Create a new document."""
        doc_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        
        documents = self._read_file(self.documents_file)
        documents.append({
            "doc_id": doc_id,
            "pdf_url": pdf_url,
            "page_count": None,
            "created_by": created_by,
            "created_at": now,
            "updated_at": now
        })
        self._write_file(self.documents_file, documents)
        
        return doc_id
    
    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]]
    ) -> None:
        """Bootstrap pages for a document."""
        # Check if document exists
        documents = self._read_file(self.documents_file)
        doc = next((d for d in documents if d["doc_id"] == doc_id), None)
        if not doc:
            raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")
        
        # Check if pages already exist
        pages = self._read_file(self.pages_file)
        existing = next((p for p in pages if p["doc_id"] == doc_id), None)
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Pages already exist for document {doc_id}"
            )
        
        # Create page records
        for dim in dims:
            pages.append({
                "page_id": str(uuid.uuid4()),
                "doc_id": doc_id,
                "idx": dim["idx"],
                "width_pt": dim["width_pt"],
                "height_pt": dim["height_pt"],
                "rotation_deg": dim.get("rotation_deg", 0)
            })
        
        # Update document page count
        doc["page_count"] = page_count
        doc["updated_at"] = datetime.utcnow().isoformat()
        
        self._write_file(self.pages_file, pages)
        self._write_file(self.documents_file, documents)
    
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks: List[Dict[str, Any]],
        created_by: Optional[str] = None
    ) -> str:
        """Create a new mark set with all its marks."""
        mark_set_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        
        # Verify document exists
        documents = self._read_file(self.documents_file)
        if not any(d["doc_id"] == doc_id for d in documents):
            raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")
        
        # Get pages for this document
        pages = self._read_file(self.pages_file)
        doc_pages = {p["idx"]: p for p in pages if p["doc_id"] == doc_id}
        
        # Verify all page indices exist
        for mark_data in marks:
            if mark_data["page_index"] not in doc_pages:
                raise HTTPException(
                    status_code=400,
                    detail=f"Page index {mark_data['page_index']} not found in document {doc_id}"
                )
        
        # Check for duplicate order_index
        order_indices = [m["order_index"] for m in marks]
        if len(order_indices) != len(set(order_indices)):
            raise HTTPException(
                status_code=400,
                detail="Duplicate order_index detected in marks"
            )
        
        # Create mark set
        mark_sets = self._read_file(self.mark_sets_file)
        mark_sets.append({
            "mark_set_id": mark_set_id,
            "doc_id": doc_id,
            "label": label,
            "is_active": False,
            "created_by": created_by,
            "created_at": now
        })
        
        # Create marks
        marks_data = self._read_file(self.marks_file)
        for mark_data in marks:
            page = doc_pages[mark_data["page_index"]]
            marks_data.append({
                "mark_id": str(uuid.uuid4()),
                "mark_set_id": mark_set_id,
                "page_id": page["page_id"],
                "order_index": mark_data["order_index"],
                "name": mark_data["name"],
                "nx": mark_data["nx"],
                "ny": mark_data["ny"],
                "nw": mark_data["nw"],
                "nh": mark_data["nh"],
                "zoom_hint": mark_data.get("zoom_hint"),
                "padding_pct": mark_data.get("padding_pct", 0.1),
                "anchor": mark_data.get("anchor", "auto"),
                "created_at": now
            })
        
        self._write_file(self.mark_sets_file, mark_sets)
        self._write_file(self.marks_file, marks_data)
        
        return mark_set_id
    
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """List all marks in a mark set, ordered by order_index."""
        # Verify mark set exists
        mark_sets = self._read_file(self.mark_sets_file)
        if not any(ms["mark_set_id"] == mark_set_id for ms in mark_sets):
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
        
        # Get marks for this set
        marks_data = self._read_file(self.marks_file)
        marks = [m for m in marks_data if m["mark_set_id"] == mark_set_id]
        
        # Join with pages to get page_index
        pages = self._read_file(self.pages_file)
        pages_map = {p["page_id"]: p for p in pages}
        
        result = []
        for mark in marks:
            page = pages_map.get(mark["page_id"])
            if page:
                result.append({
                    "mark_id": mark["mark_id"],
                    "page_index": page["idx"],
                    "order_index": mark["order_index"],
                    "name": mark["name"],
                    "nx": mark["nx"],
                    "ny": mark["ny"],
                    "nw": mark["nw"],
                    "nh": mark["nh"],
                    "zoom_hint": mark.get("zoom_hint"),
                    "padding_pct": mark.get("padding_pct", 0.1),
                    "anchor": mark.get("anchor", "auto")
                })
        
        # Sort by order_index
        result.sort(key=lambda m: m["order_index"])
        return result
    
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Partially update a mark's display preferences."""
        marks_data = self._read_file(self.marks_file)
        mark = next((m for m in marks_data if m["mark_id"] == mark_id), None)
        if not mark:
            raise HTTPException(status_code=404, detail=f"Mark {mark_id} not found")
        
        # Update fields
        if "zoom_hint" in data:
            mark["zoom_hint"] = data["zoom_hint"]
        if "padding_pct" in data:
            mark["padding_pct"] = data["padding_pct"]
        if "anchor" in data:
            mark["anchor"] = data["anchor"]
        
        self._write_file(self.marks_file, marks_data)
        
        # Get page index for response
        pages = self._read_file(self.pages_file)
        page = next((p for p in pages if p["page_id"] == mark["page_id"]), None)
        
        return {
            "mark_id": mark["mark_id"],
            "page_index": page["idx"] if page else 0,
            "order_index": mark["order_index"],
            "name": mark["name"],
            "nx": mark["nx"],
            "ny": mark["ny"],
            "nw": mark["nw"],
            "nh": mark["nh"],
            "zoom_hint": mark.get("zoom_hint"),
            "padding_pct": mark.get("padding_pct", 0.1),
            "anchor": mark.get("anchor", "auto")
        }
    
    def activate_mark_set(self, mark_set_id: str) -> None:
        """Activate a mark set and deactivate all others for the same document."""
        mark_sets = self._read_file(self.mark_sets_file)
        mark_set = next((ms for ms in mark_sets if ms["mark_set_id"] == mark_set_id), None)
        if not mark_set:
            raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
        
        # Deactivate all mark sets for this document
        doc_id = mark_set["doc_id"]
        for ms in mark_sets:
            if ms["doc_id"] == doc_id:
                ms["is_active"] = False
        
        # Activate this one
        mark_set["is_active"] = True
        
        self._write_file(self.mark_sets_file, mark_sets)