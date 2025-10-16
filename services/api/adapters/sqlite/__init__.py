# services/api/adapters/sqlite/__init__.py
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    select,
    insert,
    update,
    and_,
    event,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import registry
from datetime import datetime
from uuid import uuid4

# ---- Engine (SQLite) with WAL & pragmas -------------------------------------

def _ensure_dir(path: str):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)

def make_engine(db_url: str) -> Engine:
    # Create data dir if sqlite file
    if db_url.startswith("sqlite:///"):
        file_path = db_url.replace("sqlite:///", "", 1)
        _ensure_dir(file_path)

    engine = create_engine(db_url, future=True, pool_pre_ping=True)

    # Apply pragmas per-connection
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):  # type: ignore
        if isinstance(dbapi_connection, sqlite3.Connection):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            cursor.execute("PRAGMA temp_store=MEMORY;")
            cursor.execute("PRAGMA mmap_size=268435456;")  # 256MB
            cursor.execute("PRAGMA foreign_keys=ON;")
            cursor.close()

    return engine

# ---- Schema via SQLAlchemy Core ---------------------------------------------

metadata = MetaData()

documents = Table(
    "documents",
    metadata,
    Column("doc_id", String, primary_key=True),
    Column("pdf_url", Text, nullable=False),
    Column("page_count", Integer),
    Column("created_by", String),
    Column("created_at", DateTime, nullable=False, default=datetime.utcnow),
    Column("updated_at", DateTime, nullable=False, default=datetime.utcnow),
)

pages = Table(
    "pages",
    metadata,
    Column("page_id", String, primary_key=True),
    Column("doc_id", String, ForeignKey("documents.doc_id", ondelete="CASCADE"), nullable=False),
    Column("idx", Integer, nullable=False),  # 0-based
    Column("width_pt", Float, nullable=False),
    Column("height_pt", Float, nullable=False),
    Column("rotation_deg", Integer, nullable=False, default=0),
    UniqueConstraint("doc_id", "idx", name="uq_pages_doc_idx"),
)

mark_sets = Table(
    "mark_sets",
    metadata,
    Column("mark_set_id", String, primary_key=True),
    Column("doc_id", String, ForeignKey("documents.doc_id", ondelete="CASCADE"), nullable=False),
    Column("label", String, nullable=False, default="v1"),
    Column("is_active", Integer, nullable=False, default=0),  # 0/1
    Column("created_by", String),
    Column("created_at", DateTime, nullable=False, default=datetime.utcnow),
)

marks = Table(
    "marks",
    metadata,
    Column("mark_id", String, primary_key=True),
    Column("mark_set_id", String, ForeignKey("mark_sets.mark_set_id", ondelete="CASCADE"), nullable=False),
    Column("page_id", String, ForeignKey("pages.page_id", ondelete="CASCADE"), nullable=False),
    Column("order_index", Integer, nullable=False),
    Column("name", String, nullable=False),
    Column("nx", Float, nullable=False),
    Column("ny", Float, nullable=False),
    Column("nw", Float, nullable=False),
    Column("nh", Float, nullable=False),
    Column("zoom_hint", Float, nullable=True),
    Column("padding_pct", Float, nullable=False, default=0.1),
    Column("anchor", String, nullable=False, default="auto"),
    Column("created_at", DateTime, nullable=False, default=datetime.utcnow),
    UniqueConstraint("mark_set_id", "order_index", name="uq_markset_order"),
    CheckConstraint("nx >= 0 AND nx <= 1", name="ck_nx"),
    CheckConstraint("ny >= 0 AND ny <= 1", name="ck_ny"),
    CheckConstraint("nw > 0 AND nw <= 1", name="ck_nw"),
    CheckConstraint("nh > 0 AND nh <= 1", name="ck_nh"),
)

# Helpful indexes (if not present they’ll be created once when metadata.create_all runs)
# NOTE: SQLAlchemy Core creates simple indexes via Index(), but we can also rely on DDL in infra/sql.
from sqlalchemy import Index
Index("idx_pages_doc", pages.c.doc_id)
Index("idx_marksets_doc", mark_sets.c.doc_id)
Index("idx_marksets_active", mark_sets.c.doc_id, mark_sets.c.is_active)
Index("idx_marks_markset", marks.c.mark_set_id)
Index("idx_marks_page", marks.c.page_id)
Index("idx_marks_order", marks.c.mark_set_id, marks.c.order_index)

# ---- Adapter implementation --------------------------------------------------

@dataclass(frozen=True)
class SqliteAdapter:
    engine: Engine

    @classmethod
    def from_url(cls, db_url: str = "sqlite:///data/markbook.db") -> "SqliteAdapter":
        eng = make_engine(db_url)
        metadata.create_all(eng)
        return cls(engine=eng)

    # Documents
    def create_document(self, pdf_url: str, created_by: Optional[str]) -> str:
        doc_id = str(uuid4())
        with self.engine.begin() as conn:
            conn.execute(
                insert(documents).values(
                    doc_id=doc_id,
                    pdf_url=pdf_url,
                    created_by=created_by or None,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
            )
        return doc_id

    # Pages bootstrap (idempotency here = throw 409 if exists)
    def bootstrap_pages(self, doc_id: str, page_count: int, dims: List[Dict[str, Any]]) -> None:
        with self.engine.begin() as conn:
            # check if any pages exist
            existing = conn.execute(select(pages.c.page_id).where(pages.c.doc_id == doc_id)).first()
            if existing:
                raise HTTPException(status_code=409, detail="Pages already bootstrapped for this document")

            rows = []
            for d in dims:
                rows.append(
                    dict(
                        page_id=str(uuid4()),
                        doc_id=doc_id,
                        idx=int(d["idx"]),
                        width_pt=float(d["width_pt"]),
                        height_pt=float(d["height_pt"]),
                        rotation_deg=int(d.get("rotation_deg", 0)) % 360,
                    )
                )
            conn.execute(pages.insert(), rows)
            conn.execute(
                update(documents)
                .where(documents.c.doc_id == doc_id)
                .values(page_count=page_count, updated_at=datetime.utcnow())
            )

    # Create mark set + marks (atomic)
    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        marks_in: List[Dict[str, Any]],
        created_by: Optional[str],
    ) -> str:
        mark_set_id = str(uuid4())
        with self.engine.begin() as conn:
            # create mark_set
            conn.execute(
                insert(mark_sets).values(
                    mark_set_id=mark_set_id,
                    doc_id=doc_id,
                    label=label or "v1",
                    is_active=0,
                    created_by=created_by or None,
                    created_at=datetime.utcnow(),
                )
            )

            # map page_index -> page_id
            page_rows = conn.execute(
                select(pages.c.idx, pages.c.page_id).where(pages.c.doc_id == doc_id)
            ).all()
            idx_to_pid = {r.idx: r.page_id for r in page_rows}

            # build marks
            mark_rows = []
            seen_orders = set()
            for m in marks_in:
                oi = int(m["order_index"])
                if oi in seen_orders:
                    raise HTTPException(status_code=400, detail=f"Duplicate order_index {oi}")
                seen_orders.add(oi)

                pid = idx_to_pid.get(int(m["page_index"]))
                if not pid:
                    raise HTTPException(status_code=400, detail=f"Unknown page_index {m['page_index']} for this document")

                nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
                # quick validation (DB will also enforce)
                if not (0 <= nx <= 1 and 0 <= ny <= 1 and 0 < nw <= 1 and 0 < nh <= 1):
                    raise HTTPException(status_code=400, detail="Normalized rect out of range")

                mark_rows.append(
                    dict(
                        mark_id=str(uuid4()),
                        mark_set_id=mark_set_id,
                        page_id=pid,
                        order_index=oi,
                        name=str(m["name"]),
                        nx=nx,
                        ny=ny,
                        nw=nw,
                        nh=nh,
                        zoom_hint=float(m.get("zoom_hint")) if m.get("zoom_hint") is not None else None,
                        padding_pct=float(m.get("padding_pct", 0.1)),
                        anchor=str(m.get("anchor", "auto")),
                        created_at=datetime.utcnow(),
                    )
                )

            try:
                conn.execute(marks.insert(), mark_rows)
            except IntegrityError as e:
                raise HTTPException(status_code=400, detail="order_index must be unique per mark_set") from e

        return mark_set_id

    # List marks joined with page index
    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        with self.engine.begin() as conn:
            q = (
                select(
                    marks.c.mark_id,
                    marks.c.order_index,
                    marks.c.name,
                    marks.c.nx,
                    marks.c.ny,
                    marks.c.nw,
                    marks.c.nh,
                    marks.c.zoom_hint,
                    marks.c.padding_pct,
                    marks.c.anchor,
                    pages.c.idx.label("page_index"),
                )
                .select_from(marks.join(pages, marks.c.page_id == pages.c.page_id))
                .where(marks.c.mark_set_id == mark_set_id)
                .order_by(marks.c.order_index.asc())
            )
            rows = conn.execute(q).mappings().all()
            return [dict(row) for row in rows]

    # Patch mark
    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        allowed = {k: v for k, v in data.items() if k in {"zoom_hint", "padding_pct", "anchor"}}
        if not allowed:
            raise HTTPException(status_code=400, detail="No patchable fields")
        with self.engine.begin() as conn:
            res = conn.execute(
                update(marks)
                .where(marks.c.mark_id == mark_id)
                .values(**allowed)
                .returning(
                    marks.c.mark_id,
                    marks.c.order_index,
                    marks.c.name,
                    marks.c.nx,
                    marks.c.ny,
                    marks.c.nw,
                    marks.c.nh,
                    marks.c.zoom_hint,
                    marks.c.padding_pct,
                    marks.c.anchor,
                )
            ).mappings().first()
            if not res:
                raise HTTPException(status_code=404, detail="Mark not found")
            return dict(res)

    # Activate a mark set (deactivate siblings)
    def activate_mark_set(self, mark_set_id: str) -> None:
        with self.engine.begin() as conn:
            # find doc_id
            row = conn.execute(
                select(mark_sets.c.doc_id).where(mark_sets.c.mark_set_id == mark_set_id)
            ).first()
            if not row:
                raise HTTPException(status_code=404, detail="Mark set not found")
            doc_id = row.doc_id

            conn.execute(
                update(mark_sets)
                .where(mark_sets.c.doc_id == doc_id)
                .values(is_active=0)
            )
            conn.execute(
                update(mark_sets)
                .where(mark_sets.c.mark_set_id == mark_set_id)
                .values(is_active=1)
            )
