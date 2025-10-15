"""
SQLite storage adapter for PDF Markbook.
Fully functional implementation using SQLAlchemy.
"""
import os
import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional

from sqlalchemy import (
    create_engine, Column, String, Integer, Float, Boolean, 
    DateTime, ForeignKey, CheckConstraint, UniqueConstraint, Index
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException

Base = declarative_base()


# ============ SQLAlchemy Models ============

class DocumentModel(Base):
    __tablename__ = "documents"
    
    doc_id = Column(String, primary_key=True)
    pdf_url = Column(String, nullable=False)
    page_count = Column(Integer, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class PageModel(Base):
    __tablename__ = "pages"
    
    page_id = Column(String, primary_key=True)
    doc_id = Column(String, ForeignKey("documents.doc_id"), nullable=False)
    idx = Column(Integer, nullable=False)  # 0-based page index
    width_pt = Column(Float, nullable=False)
    height_pt = Column(Float, nullable=False)
    rotation_deg = Column(Integer, nullable=False, default=0)
    
    __table_args__ = (
        Index("idx_pages_doc_id", "doc_id"),
        UniqueConstraint("doc_id", "idx", name="uq_pages_doc_idx"),
    )


class MarkSetModel(Base):
    __tablename__ = "mark_sets"
    
    mark_set_id = Column(String, primary_key=True)
    doc_id = Column(String, ForeignKey("documents.doc_id"), nullable=False)
    label = Column(String, nullable=False, default="v1")
    is_active = Column(Boolean, nullable=False, default=False)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    __table_args__ = (
        Index("idx_marksets_doc_id", "doc_id"),
    )


class MarkModel(Base):
    __tablename__ = "marks"
    
    mark_id = Column(String, primary_key=True)
    mark_set_id = Column(String, ForeignKey("mark_sets.mark_set_id"), nullable=False)
    page_id = Column(String, ForeignKey("pages.page_id"), nullable=False)
    order_index = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    
    # Normalized coordinates (0-1 range)
    nx = Column(Float, nullable=False)
    ny = Column(Float, nullable=False)
    nw = Column(Float, nullable=False)
    nh = Column(Float, nullable=False)
    
    # Display preferences
    zoom_hint = Column(Float, nullable=True)
    padding_pct = Column(Float, nullable=False, default=0.1)
    anchor = Column(String, nullable=False, default="auto")
    
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    __table_args__ = (
        # Unique order_index per mark set
        UniqueConstraint("mark_set_id", "order_index", name="uq_marks_set_order"),
        
        # Check constraints for normalized coordinates
        CheckConstraint("nx >= 0 AND nx <= 1", name="ck_marks_nx"),
        CheckConstraint("ny >= 0 AND ny <= 1", name="ck_marks_ny"),
        CheckConstraint("nw > 0 AND nw <= 1", name="ck_marks_nw"),
        CheckConstraint("nh > 0 AND nh <= 1", name="ck_marks_nh"),
        
        # Indexes for performance
        Index("idx_marks_mark_set_id", "mark_set_id"),
        Index("idx_marks_page_id", "page_id"),
    )


# ============ SQLite Adapter ============

class SqliteAdapter:
    """
    SQLite storage adapter implementation.
    Provides full CRUD operations for documents, pages, mark sets, and marks.
    """
    
    def __init__(self, db_url: str):
        """
        Initialize the SQLite adapter.
        
        Args:
            db_url: SQLAlchemy database URL (e.g., "sqlite:///data/markbook.db")
        """
        # Ensure data directory exists
        if db_url.startswith("sqlite:///"):
            db_path = db_url.replace("sqlite:///", "")
            db_dir = os.path.dirname(db_path)
            if db_dir:
                os.makedirs(db_dir, exist_ok=True)
        
        self.engine = create_engine(db_url, echo=False)
        self.SessionLocal = sessionmaker(bind=self.engine)
        
        # Create tables if they don't exist
        Base.metadata.create_all(self.engine)
    
    def _get_session(self) -> Session:
        """Get a new database session."""
        return self.SessionLocal()
    
    def create_document(self, pdf_url: str, created_by: Optional[str] = None) -> str:
        """Create a new document."""
        doc_id = str(uuid.uuid4())
        
        with self._get_session() as session:
            doc = DocumentModel(
                doc_id=doc_id,
                pdf_url=pdf_url,
                created_by=created_by
            )
            session.add(doc)
            session.commit()
        
        return doc_id
    
    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]]
    ) -> None:
        """Bootstrap pages for a document."""
        with self._get_session() as session:
            # Check if document exists
            doc = session.query(DocumentModel).filter_by(doc_id=doc_id).first()
            if not doc:
                raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")
            
            # Check if pages already exist
            existing = session.query(PageModel).filter_by(doc_id=doc_id).first()
            if existing:
                raise HTTPException(
                    status_code=409,
                    detail=f"Pages already exist for document {doc_id}. "
                           "Bootstrap is idempotent only if called with identical data."
                )
            
            # Create page records
            pages = []
            for dim in dims:
                page_id = str(uuid.uuid4())
                page = PageModel(
                    page_id=page_id,
                    doc_id=doc_id,
                    idx=dim["idx"],
                    width_pt=dim["width_pt"],
                    height_pt=dim["height_pt"],
                    rotation_deg=dim.get("rotation_deg", 0)
                )
                pages.append(page)
            
            # Update document page count
            doc.page_count = page_count
            doc.updated_at = datetime.utcnow()
            
            # Add all pages
            session.add_all(pages)
            session.commit()
    
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks: List[Dict[str, Any]],
        created_by: Optional[str] = None
    ) -> str:
        """Create a new mark set with all its marks atomically."""
        mark_set_id = str(uuid.uuid4())
        
        with self._get_session() as session:
            try:
                # Verify document exists
                doc = session.query(DocumentModel).filter_by(doc_id=doc_id).first()
                if not doc:
                    raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")
                
                # Create mark set
                mark_set = MarkSetModel(
                    mark_set_id=mark_set_id,
                    doc_id=doc_id,
                    label=label,
                    is_active=False,
                    created_by=created_by
                )
                session.add(mark_set)
                session.flush()  # Ensure mark_set_id is available
                
                # Create all marks
                mark_models = []
                for mark_data in marks:
                    # Find the page_id for this page_index
                    page = session.query(PageModel).filter_by(
                        doc_id=doc_id,
                        idx=mark_data["page_index"]
                    ).first()
                    
                    if not page:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Page index {mark_data['page_index']} not found in document {doc_id}"
                        )
                    
                    mark = MarkModel(
                        mark_id=str(uuid.uuid4()),
                        mark_set_id=mark_set_id,
                        page_id=page.page_id,
                        order_index=mark_data["order_index"],
                        name=mark_data["name"],
                        nx=mark_data["nx"],
                        ny=mark_data["ny"],
                        nw=mark_data["nw"],
                        nh=mark_data["nh"],
                        zoom_hint=mark_data.get("zoom_hint"),
                        padding_pct=mark_data.get("padding_pct", 0.1),
                        anchor=mark_data.get("anchor", "auto")
                    )
                    mark_models.append(mark)
                
                session.add_all(mark_models)
                session.commit()
                
            except IntegrityError as e:
                session.rollback()
                # Check for duplicate order_index
                if "uq_marks_set_order" in str(e):
                    raise HTTPException(
                        status_code=400,
                        detail="Duplicate order_index detected in marks"
                    )
                # Check for coordinate constraint violations
                elif "ck_marks_" in str(e):
                    raise HTTPException(
                        status_code=400,
                        detail="Invalid normalized coordinates (must be in range [0,1])"
                    )
                raise HTTPException(status_code=400, detail=f"Database constraint violation: {str(e)}")
        
        return mark_set_id
    
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """List all marks in a mark set, ordered by order_index."""
        with self._get_session() as session:
            # Verify mark set exists
            mark_set = session.query(MarkSetModel).filter_by(mark_set_id=mark_set_id).first()
            if not mark_set:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            
            # Join marks with pages to get page index
            results = session.query(
                MarkModel.mark_id,
                MarkModel.order_index,
                MarkModel.name,
                MarkModel.nx,
                MarkModel.ny,
                MarkModel.nw,
                MarkModel.nh,
                MarkModel.zoom_hint,
                MarkModel.padding_pct,
                MarkModel.anchor,
                PageModel.idx.label("page_index")
            ).join(
                PageModel, MarkModel.page_id == PageModel.page_id
            ).filter(
                MarkModel.mark_set_id == mark_set_id
            ).order_by(
                MarkModel.order_index
            ).all()
            
            # Convert to dictionaries
            marks = []
            for row in results:
                marks.append({
                    "mark_id": row.mark_id,
                    "page_index": row.page_index,
                    "order_index": row.order_index,
                    "name": row.name,
                    "nx": row.nx,
                    "ny": row.ny,
                    "nw": row.nw,
                    "nh": row.nh,
                    "zoom_hint": row.zoom_hint,
                    "padding_pct": row.padding_pct,
                    "anchor": row.anchor
                })
            
            return marks
    
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Partially update a mark's display preferences."""
        with self._get_session() as session:
            mark = session.query(MarkModel).filter_by(mark_id=mark_id).first()
            if not mark:
                raise HTTPException(status_code=404, detail=f"Mark {mark_id} not found")
            
            # Update only provided fields
            if "zoom_hint" in data:
                mark.zoom_hint = data["zoom_hint"]
            if "padding_pct" in data:
                mark.padding_pct = data["padding_pct"]
            if "anchor" in data:
                mark.anchor = data["anchor"]
            
            session.commit()
            
            # Get page index for response
            page = session.query(PageModel).filter_by(page_id=mark.page_id).first()
            
            return {
                "mark_id": mark.mark_id,
                "page_index": page.idx if page else 0,
                "order_index": mark.order_index,
                "name": mark.name,
                "nx": mark.nx,
                "ny": mark.ny,
                "nw": mark.nw,
                "nh": mark.nh,
                "zoom_hint": mark.zoom_hint,
                "padding_pct": mark.padding_pct,
                "anchor": mark.anchor
            }
    
    def activate_mark_set(self, mark_set_id: str) -> None:
        """Activate a mark set and deactivate all others for the same document."""
        with self._get_session() as session:
            # Get the mark set
            mark_set = session.query(MarkSetModel).filter_by(mark_set_id=mark_set_id).first()
            if not mark_set:
                raise HTTPException(status_code=404, detail=f"Mark set {mark_set_id} not found")
            
            # Deactivate all mark sets for this document
            session.query(MarkSetModel).filter_by(doc_id=mark_set.doc_id).update(
                {"is_active": False}
            )
            
            # Activate this mark set
            mark_set.is_active = True
            
            session.commit()