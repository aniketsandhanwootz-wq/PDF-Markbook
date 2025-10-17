"""
PDF Mark System - Backend API
FastAPI implementation with SQLite

Install dependencies:
pip install fastapi uvicorn sqlalchemy pydantic

Run server:
uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from sqlalchemy import create_engine, Column, String, Integer, Float, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
import uuid

# Database setup
SQLALCHEMY_DATABASE_URL = "sqlite:///./marks.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Models
class MarkSetDB(Base):
    __tablename__ = "mark_sets"
    
    id = Column(String, primary_key=True, index=True)
    pdf_url = Column(String)
    name = Column(String)

class MarkDB(Base):
    __tablename__ = "marks"
    
    mark_id = Column(String, primary_key=True, index=True)
    mark_set_id = Column(String, ForeignKey("mark_sets.id"))
    page_index = Column(Integer)
    order_index = Column(Integer)
    name = Column(String)
    nx = Column(Float)
    ny = Column(Float)
    nw = Column(Float)
    nh = Column(Float)
    zoom_hint = Column(Float, nullable=True)

Base.metadata.create_all(bind=engine)

# Pydantic models
class Mark(BaseModel):
    mark_id: Optional[str] = None
    page_index: int
    order_index: int
    name: str
    nx: float
    ny: float
    nw: float
    nh: float
    zoom_hint: Optional[float] = None

class MarkSet(BaseModel):
    id: str
    pdf_url: str
    name: str

class MarkSetCreate(BaseModel):
    pdf_url: str
    name: str

# FastAPI app
app = FastAPI(title="PDF Mark System API")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001", "http://localhost:3002"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Endpoints

@app.post("/mark-sets", response_model=MarkSet)
async def create_mark_set(mark_set: MarkSetCreate):
    """Create a new mark set for a PDF"""
    db = SessionLocal()
    try:
        new_id = str(uuid.uuid4())
        db_mark_set = MarkSetDB(
            id=new_id,
            pdf_url=mark_set.pdf_url,
            name=mark_set.name
        )
        db.add(db_mark_set)
        db.commit()
        db.refresh(db_mark_set)
        return MarkSet(
            id=db_mark_set.id,
            pdf_url=db_mark_set.pdf_url,
            name=db_mark_set.name
        )
    finally:
        db.close()

@app.get("/mark-sets")
async def list_mark_sets():
    """List all mark sets"""
    db = SessionLocal()
    try:
        mark_sets = db.query(MarkSetDB).all()
        return [
            MarkSet(id=ms.id, pdf_url=ms.pdf_url, name=ms.name)
            for ms in mark_sets
        ]
    finally:
        db.close()

@app.get("/mark-sets/{mark_set_id}/marks", response_model=List[Mark])
async def get_marks(mark_set_id: str):
    """Get all marks for a mark set"""
    db = SessionLocal()
    try:
        # Check if mark set exists
        mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
        if not mark_set:
            raise HTTPException(status_code=404, detail="Mark set not found")
        
        marks = db.query(MarkDB).filter(MarkDB.mark_set_id == mark_set_id).all()
        return [
            Mark(
                mark_id=m.mark_id,
                page_index=m.page_index,
                order_index=m.order_index,
                name=m.name,
                nx=m.nx,
                ny=m.ny,
                nw=m.nw,
                nh=m.nh,
                zoom_hint=m.zoom_hint
            )
            for m in marks
        ]
    finally:
        db.close()

@app.put("/mark-sets/{mark_set_id}/marks")
async def replace_marks(mark_set_id: str, marks: List[Mark]):
    """
    REPLACE all marks for a mark set (no versioning).
    This deletes all existing marks and saves the new ones.
    """
    db = SessionLocal()
    try:
        # Check if mark set exists
        mark_set = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).first()
        if not mark_set:
            raise HTTPException(status_code=404, detail="Mark set not found")
        
        # Delete all existing marks for this set
        db.query(MarkDB).filter(MarkDB.mark_set_id == mark_set_id).delete()
        
        # Add new marks
        for mark in marks:
            # Generate new ID if temp ID
            mark_id = mark.mark_id
            if not mark_id or mark_id.startswith('temp-'):
                mark_id = str(uuid.uuid4())
            
            db_mark = MarkDB(
                mark_id=mark_id,
                mark_set_id=mark_set_id,
                page_index=mark.page_index,
                order_index=mark.order_index,
                name=mark.name,
                nx=mark.nx,
                ny=mark.ny,
                nw=mark.nw,
                nh=mark.nh,
                zoom_hint=mark.zoom_hint
            )
            db.add(db_mark)
        
        db.commit()
        return {"status": "success", "count": len(marks)}
    finally:
        db.close()

@app.delete("/mark-sets/{mark_set_id}")
async def delete_mark_set(mark_set_id: str):
    """Delete a mark set and all its marks"""
    db = SessionLocal()
    try:
        # Delete marks first
        db.query(MarkDB).filter(MarkDB.mark_set_id == mark_set_id).delete()
        # Delete mark set
        result = db.query(MarkSetDB).filter(MarkSetDB.id == mark_set_id).delete()
        if result == 0:
            raise HTTPException(status_code=404, detail="Mark set not found")
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()

@app.get("/")
async def root():
    return {"message": "PDF Mark System API", "version": "1.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)