# services/api/routers/documents.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, Optional, Dict, Any, List
from pydantic import BaseModel, Field
from main import clean_pdf_url
from main import get_storage_adapter  # DI helper from main

router = APIRouter(prefix="/documents", tags=["documents"])

# ---- DI alias (no default value allowed) ----
Storage = Annotated[object, Depends(get_storage_adapter)]


# ====== Schemas used by this router only ======

class ByIdentifierQuery(BaseModel):
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1, description="Business id (ProjectName + PartName)")
    part_number: str = Field(min_length=1)


class MarkSetCreateForDoc(BaseModel):
    # 3-part business key
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1)
    part_number: str = Field(min_length=1)

    # markset metadata
    label: str = Field(min_length=1, description="Markset label to show in UI")
    created_by: Optional[str] = None
    is_master: bool = False

class DocumentInitPayload(BaseModel):
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1, description="Business id (ProjectName + PartName)")
    part_number: str = Field(min_length=1)
    user_mail: Optional[str] = None
    # Either give pdf_url OR assembly_drawing (we’ll clean/convert)
    pdf_url: Optional[str] = None
    assembly_drawing: Optional[str] = None  # may be a Glide/Cloudinary wrapped URL

# ====== Helpers ======

def _master_mark_set_id(mark_sets: List[Dict[str, Any]]) -> Optional[str]:
    """
    Return the mark_set_id where is_master == 'TRUE' (Google Sheets stores T/F as strings).
    If multiple are TRUE due to legacy data, pick the first.
    """
    for ms in mark_sets:
        if (ms.get("is_master") or "").upper() == "TRUE":
            return ms.get("mark_set_id")
    return None


def _ensure_document(storage, *, project_name: str, external_id: str, part_number: str, pdf_url: Optional[str], created_by: Optional[str]) -> str:
    """
    Find a document by the 3-part business key; if not found, create it.
    """
    doc = storage.get_document_by_business_key(
        project_name=project_name,
        external_id=external_id,
        part_number=part_number,
    )
    if doc:
        return doc["doc_id"]

    if not pdf_url:
        raise HTTPException(status_code=400, detail="pdf_url is required to create a new document")

    return storage.create_document(
        pdf_url=pdf_url,
        created_by=created_by or "",
        part_number=part_number,
        project_name=project_name,
        external_id=external_id,
    )


# ====== Endpoints ======

@router.get("/by-identifier", status_code=status.HTTP_200_OK)
async def get_by_identifier(
    storage: Storage,
    project_name: str = Query(..., min_length=1),
    id: str = Query(..., min_length=1, description="Business id (ProjectName + PartName)"),
    part_number: str = Query(..., min_length=1),
):

    """
    Resolve a document by (project_name, id, part_number) and return:
      - the document row
      - all marksets for that doc (with is_master/is_active flags as in Sheets)
      - master_mark_set_id (computed)
    """
    try:
        doc = storage.get_document_by_business_key(
            project_name=project_name,
            external_id=id,
            part_number=part_number,
        )
        if not doc:
            raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

        mark_sets = storage.list_mark_sets_by_document(doc["doc_id"])
        master_id = _master_mark_set_id(mark_sets)
        counts = storage.count_marks_by_mark_set(doc["doc_id"]) if hasattr(storage, "count_marks_by_mark_set") else {}

        # minimal, viewer-friendly payload
        return {
            "document": {
                "doc_id": doc["doc_id"],
                "project_name": doc.get("project_name", ""),
                "id": doc.get("external_id", ""),
                "part_number": doc.get("part_number", ""),
                "pdf_url": doc.get("pdf_url", ""),
                "page_count": doc.get("page_count", 0),
            },
            "mark_sets": [
                {
                    "mark_set_id": ms.get("mark_set_id"),
                    "label": ms.get("label"),
                    "is_master": (ms.get("is_master") or "").upper() == "TRUE",
                    "is_active": (ms.get("is_active") or "").upper() == "TRUE",
                    "created_by": ms.get("created_by", ""),
                    "created_at": ms.get("created_at", ""),
                    "updated_by": ms.get("updated_by", ""),
                    "marks_count": counts.get(ms.get("mark_set_id"), 0),
                }
                for ms in mark_sets
            ],

            "master_mark_set_id": master_id,
            "mark_set_count": len(mark_sets),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/init", status_code=status.HTTP_200_OK)
async def init_document(
    storage: Storage,
    payload: DocumentInitPayload,
):
    """
    Editor 'Map Creation' entry:
    - Upsert by (project_name, id, part_number).
    - Clean Cloudinary/Glide URL → storage.googleapis.com/...pdf
    - If doc exists, return it with marksets.
    - If not, create it with cleaned pdf_url.
    """
    try:
      # 1) Try to find existing
      doc = storage.get_document_by_business_key(
          project_name=payload.project_name,
          external_id=payload.id,
          part_number=payload.part_number,
      )
      if not doc:
          # 2) Resolve/clean the PDF URL to store
          pdf_url = payload.pdf_url
          if not pdf_url:
              # if only assembly_drawing provided, clean it
              if payload.assembly_drawing:
                  pdf_url = clean_pdf_url(payload.assembly_drawing)
              else:
                  raise HTTPException(status_code=400, detail="Provide pdf_url or assembly_drawing")

          cleaned = clean_pdf_url(pdf_url)
          if not cleaned.lower().endswith(".pdf"):
              raise HTTPException(status_code=400, detail="Resolved URL is not a PDF")

          # 3) Create new document
          doc_id = storage.create_document(
              pdf_url=cleaned,
              created_by=payload.user_mail or "",
              part_number=payload.part_number,
              project_name=payload.project_name,
              external_id=payload.id,
          )
          doc = storage.get_document(doc_id)

      # 4) Return doc + its marksets
      mark_sets = storage.list_mark_sets_by_document(doc["doc_id"])
      master_id = _master_mark_set_id(mark_sets)
      counts = storage.count_marks_by_mark_set(doc["doc_id"]) if hasattr(storage, "count_marks_by_mark_set") else {}

      return {
          "document": {
              "doc_id": doc["doc_id"],
              "project_name": doc.get("project_name", ""),
              "id": doc.get("external_id", ""),
              "part_number": doc.get("part_number", ""),
              "pdf_url": doc.get("pdf_url", ""),
              "page_count": doc.get("page_count", 0),
          },
          "mark_sets": [
              {
                  "mark_set_id": ms.get("mark_set_id"),
                  "label": ms.get("label"),
                  "is_master": (ms.get("is_master") or "").upper() == "TRUE",
                  "is_active": (ms.get("is_active") or "").upper() == "TRUE",
                  "created_by": ms.get("created_by", ""),
                  "created_at": ms.get("created_at", ""),
                  "updated_by": ms.get("updated_by", ""),
                  "marks_count": counts.get(ms.get("mark_set_id"), 0),
              }
              for ms in mark_sets
          ],
          "master_mark_set_id": master_id,
          "mark_set_count": len(mark_sets),
          "status": "existing" if master_id or mark_sets else "new_or_empty"
      }
    except HTTPException:
      raise
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))

@router.post("/mark-sets", status_code=status.HTTP_201_CREATED)
async def create_mark_set_for_document(
    storage: Storage,
    payload: MarkSetCreateForDoc,
):
    """
    Editor flow:
      - Given the 3-part business key and a label, create a markset on that document.
      - If is_master=True, enforce single master for that document.
    Notes:
      - This does NOT accept marks; Editor will PUT marks later to /mark-sets/{id}/marks.
      - If document doesn't exist yet, this endpoint will fail (to avoid creating without a pdf_url).
        Use your existing /documents/init flow to create the doc first.
    """
    try:
        # resolve existing doc
        doc = storage.get_document_by_business_key(
            project_name=payload.project_name,
            external_id=payload.id,
            part_number=payload.part_number,
        )
        if not doc:
            raise HTTPException(status_code=400, detail="DOCUMENT_NOT_INITIALIZED")

        mark_set_id = storage.create_mark_set(
            doc_id=doc["doc_id"],
            label=payload.label,
            created_by=payload.created_by or "",
            marks=[],
            is_master=payload.is_master,  # default False handled in adapter
        )

        # If user checked "Is Master", enforce single master
        if payload.is_master:
            storage.set_master_mark_set(mark_set_id)

        return {
            "status": "created",
            "mark_set_id": mark_set_id,
            "is_master": payload.is_master,
            "doc_id": doc["doc_id"],
            "label": payload.label,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{doc_id}/mark-sets", status_code=status.HTTP_200_OK)
async def list_mark_sets_for_doc(
    storage: Storage,
    doc_id: str,
):
    """
    Return raw mark_sets rows for a given doc_id (includes is_master/is_active).
    """
    try:
        rows = storage.list_mark_sets_by_document(doc_id)
        return rows
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/clean-link", status_code=status.HTTP_200_OK)
async def clean_link(url: str):
    """
    Utility: given a Glide/Cloudinary fetch URL, return the final storage.googleapis.com/...pdf
    """
    try:
        cleaned = clean_pdf_url(url)
        return {"cleaned_pdf_url": cleaned}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
