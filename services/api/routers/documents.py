"""
Document and page management endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from typing import Annotated

from schemas import DocumentCreate, DocumentOut, PagesBootstrap
from core.validation import validate_page_dims
from adapters.base import StorageAdapter


router = APIRouter(prefix="/documents", tags=["documents"])


@router.post("", response_model=DocumentOut, status_code=201)
async def create_document(
    doc: DocumentCreate,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Create a new PDF document record.
    
    This initializes a document in the system but does not yet add page information.
    After creating a document, use the bootstrap endpoint to add page dimensions.
    """
    doc_id = storage.create_document(
        pdf_url=doc.pdf_url,
        created_by=doc.created_by
    )
    return DocumentOut(doc_id=doc_id)


@router.post("/{doc_id}/pages/bootstrap", status_code=201)
async def bootstrap_pages(
    doc_id: str,
    pages: PagesBootstrap,
    storage: Annotated[StorageAdapter, Depends()]
):
    """
    Bootstrap page dimensions for a document.
    
    This endpoint should be called once per document after creation,
    typically right after the frontend loads the PDF and determines
    the dimensions of each page.
    
    **Idempotency note:** If pages already exist for this document,
    this endpoint will return 409 Conflict. In a production system,
    you might want to implement idempotency by checking if the
    provided dimensions match existing records.
    """
    # Validate page dimensions
    validate_page_dims([dim.model_dump() for dim in pages.dims])
    
    # Bootstrap pages
    storage.bootstrap_pages(
        doc_id=doc_id,
        page_count=pages.page_count,
        dims=[dim.model_dump() for dim in pages.dims]
    )
    
    return {"status": "ok", "message": f"Bootstrapped {pages.page_count} pages"}