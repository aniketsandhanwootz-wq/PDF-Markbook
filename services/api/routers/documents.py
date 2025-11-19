# services/api/routers/documents.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, Optional, Dict, Any, List
from pydantic import BaseModel, Field

from main import clean_pdf_url
from main import get_storage_adapter  # DI helper from main
from models import Document, MarkSet
from models.converters import document_from_sheets, markset_from_sheets

router = APIRouter(prefix="/documents", tags=["documents"])

# ---- DI alias (no default value allowed) ----
Storage = Annotated[object, Depends(get_storage_adapter)]

from models.converters import document_from_sheets, markset_from_sheets

router = APIRouter(prefix="/documents", tags=["documents"])

# Default master-editors string for *new* documents.
# You can later override per-document directly in the Google Sheet.
DEFAULT_MASTER_EDITORS = "aniket.sandhan@wootz.work"

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
    description: Optional[str] = Field(  # 👈 NEW
        default=None,
        max_length=500,
        description="Short description shown in UI",
    )



class DocumentInitPayload(BaseModel):
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1, description="Business id (ProjectName + PartName)")
    part_number: str = Field(min_length=1)
    user_mail: Optional[str] = None
    # Either give pdf_url OR assembly_drawing (we’ll clean/convert)
    pdf_url: Optional[str] = None
    assembly_drawing: Optional[str] = None  # may be a Glide/Cloudinary wrapped URL


# ====== Helpers ======

def _master_mark_set_id(mark_sets: List[MarkSet]) -> Optional[str]:
    """
    Return the mark_set_id for the MarkSet where is_master == True.
    If multiple are True due to legacy data, pick the first.
    """
    for ms in mark_sets:
        if ms.is_master:
            return ms.mark_set_id
    return None


def _user_can_edit_master(doc: Dict[str, Any], user_email: Optional[str]) -> bool:
    """
    Check if user_email is allowed to edit master markset for this document.

    Rules:
    - If master_editors is empty/missing  -> allow everyone (backwards compatible).
    - If master_editors has emails       -> user_email must be in that list.
    """
    editors_raw = (doc.get("master_editors") or "").strip()
    if not editors_raw:
        # No restriction configured -> open
        return True

    if not user_email:
        return False

    allowed = {e.strip().lower() for e in editors_raw.split(",") if e.strip()}
    return user_email.strip().lower() in allowed


def _infer_role(doc: Dict[str, Any], user_email: Optional[str]) -> str:
    """
    Infer role = 'master' or 'qc' for this document and user_email.

    Logic:
    - If master_editors empty/missing:
        -> treat caller as 'master' (no restrictions configured).
    - If master_editors has entries:
        -> 'master' if user_email in list, else 'qc'.
    """
    editors_raw = (doc.get("master_editors") or "").strip()

    # No restriction configured: allow them to behave as master
    if not editors_raw:
        return "master"

    if not user_email:
        return "qc"

    allowed = {e.strip().lower() for e in editors_raw.split(",") if e.strip()}
    return "master" if user_email.strip().lower() in allowed else "qc"


def _ensure_document(
    storage,
    *,
    project_name: str,
    external_id: str,
    part_number: str,
    pdf_url: Optional[str],
    created_by: Optional[str],
) -> str:
    """
    Find a document by the 3-part business key; if not found, create it.
    For newly created documents we also seed `master_editors` with
    DEFAULT_MASTER_EDITORS so that master-edit permissions are not empty.
    """
    doc = storage.get_document_by_business_key(
        project_name=project_name,
        external_id=external_id,
        part_number=part_number,
    )
    if doc:
        return doc["doc_id"]

    if not pdf_url:
        raise HTTPException(
            status_code=400,
            detail="pdf_url is required to create a new document",
        )

    return storage.create_document(
        pdf_url=pdf_url,
        created_by=created_by or "",
        part_number=part_number,
        project_name=project_name,
        external_id=external_id,
        master_editors=DEFAULT_MASTER_EDITORS,  # 👈 NEW
    )


# ====== Endpoints ======

@router.get("/by-identifier", status_code=status.HTTP_200_OK)
async def get_by_identifier(
    storage: Storage,
    project_name: str = Query(..., min_length=1),
    id: str = Query(..., min_length=1, description="Business id (ProjectName + PartName)"),
    part_number: str = Query(..., min_length=1),
    user_mail: Optional[str] = Query(None, description="Caller email (used for role=master/qc)"),
):
    """
    Resolve a document by (project_name, id, part_number) and return:
      - the document row
      - all marksets for that doc (with is_master/is_active flags as in Sheets)
      - master_mark_set_id (computed)
      - role: 'master' or 'qc' for this user on this document
      - can_edit_master: boolean convenience flag
    """
    try:
        # 1) Resolve document via Sheets (raw dict, needed for master_editors)
        doc_raw = storage.get_document_by_business_key(
            project_name=project_name,
            external_id=id,
            part_number=part_number,
        )
        if not doc_raw:
            raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

        # 2) Domain model (for nice typing, page_count, etc.)
        doc: Document = document_from_sheets(doc_raw)

        # 3) List mark-sets for this document
        mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
        mark_set_models: List[MarkSet] = [
            markset_from_sheets(ms) for ms in mark_sets_raw
        ]

        master_id = _master_mark_set_id(mark_set_models)

        # 4) Count marks per mark-set
        counts = (
            storage.count_marks_by_mark_set(doc.doc_id)
            if hasattr(storage, "count_marks_by_mark_set")
            else {}
        )

        # 5) Role / permissions for this user
        role = _infer_role(doc_raw, user_mail)
        can_edit_master = _user_can_edit_master(doc_raw, user_mail)

        # 6) Build viewer/editor-friendly payload
        return {
            "document": {
                "doc_id": doc.doc_id,
                "project_name": doc.project_name or "",
                "id": doc.external_id or "",
                "part_number": doc.part_number or "",
                "pdf_url": doc.pdf_url,
                "page_count": doc.page_count,
                "master_editors": (doc_raw.get("master_editors") or "").strip(),
            },
            "mark_sets": [
                {
                    "mark_set_id": ms.mark_set_id,
                    "label": ms.label,
                    "is_master": ms.is_master,
                    "is_active": ms.is_active,
                    "created_by": ms.created_by or "",
                    "created_at": ms.created_at or "",
                    "updated_by": ms.updated_by or "",
                    "marks_count": counts.get(ms.mark_set_id, 0),
                    "description": getattr(ms, "description", None) or "",
                }
                for ms in mark_set_models
            ],

            "master_mark_set_id": master_id,
            "mark_set_count": len(mark_set_models),
            "role": role,  # 'master' or 'qc'
            "can_edit_master": can_edit_master,
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
    - Also infer role = 'master' / 'qc' based on documents.master_editors + user_mail.
    - Ensure there is ALWAYS exactly one master markset for this document.
    """
    try:
        # 1) Try to find existing (Sheets → Domain)
        doc_raw = storage.get_document_by_business_key(
            project_name=payload.project_name,
            external_id=payload.id,
            part_number=payload.part_number,
        )

        if not doc_raw:
            # 2) Resolve/clean the PDF URL to store
            pdf_url = payload.pdf_url
            if not pdf_url:
                # if only assembly_drawing provided, clean it
                if payload.assembly_drawing:
                    pdf_url = clean_pdf_url(payload.assembly_drawing)
                else:
                    raise HTTPException(
                        status_code=400,
                        detail="Provide pdf_url or assembly_drawing",
                    )

            cleaned = clean_pdf_url(pdf_url)
            if not cleaned.lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=400,
                    detail="Resolved URL is not a PDF",
                )

            # 3) Create new document in Sheets
            doc_id = storage.create_document(
                pdf_url=cleaned,
                created_by=payload.user_mail or "",
                part_number=payload.part_number,
                project_name=payload.project_name,
                external_id=payload.id,
                master_editors=DEFAULT_MASTER_EDITORS,  # 👈 NEW: seed master editors
            )
            doc_raw = storage.get_document(doc_id)

        # 4) Convert to domain model
        doc: Document = document_from_sheets(doc_raw)

        # 5) Fetch mark sets (Sheets → Domain)
        mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
        mark_set_models: List[MarkSet] = [
            markset_from_sheets(ms) for ms in mark_sets_raw
        ]
        master_id = _master_mark_set_id(mark_set_models)

        # 5.1) 🔥 Ensure a MASTER markset exists for this document
        if not master_id:
            # System-level creation; we don't enforce master_editors here.
            new_master_id = storage.create_mark_set(
                doc_id=doc.doc_id,
                label="MASTER",
                created_by=payload.user_mail or "",
                marks=[],
                is_master=True,
                description="Auto-created master markset",
            )
            # Make sure this is the ONLY master
            storage.set_master_mark_set(new_master_id)

            # Reload marksets & counts after creation
            mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
            mark_set_models = [markset_from_sheets(ms) for ms in mark_sets_raw]
            master_id = new_master_id

        counts = (
            storage.count_marks_by_mark_set(doc.doc_id)
            if hasattr(storage, "count_marks_by_mark_set")
            else {}
        )

        # 6) Role / permissions for this user on this document
        user_email = payload.user_mail
        role = _infer_role(doc_raw, user_email)
        can_edit_master = _user_can_edit_master(doc_raw, user_email)

        return {
            "document": {
                "doc_id": doc.doc_id,
                "project_name": doc.project_name or "",
                "id": doc.external_id or "",
                "part_number": doc.part_number or "",
                "pdf_url": doc.pdf_url,
                "page_count": doc.page_count,
                "master_editors": (doc_raw.get("master_editors") or "").strip(),
            },
        "mark_sets": [
            {
                "mark_set_id": ms.mark_set_id,
                "label": ms.label,
                "is_master": ms.is_master,
                "is_active": ms.is_active,
                "created_by": ms.created_by or "",
                "created_at": ms.created_at or "",
                "updated_by": ms.updated_by or "",
                "marks_count": counts.get(ms.mark_set_id, 0),
                "description": getattr(ms, "description", None) or "",
            }
            for ms in mark_set_models
        ],

            "master_mark_set_id": master_id,
            "mark_set_count": len(mark_set_models),
            "status": "existing" if master_id or mark_set_models else "new_or_empty",
            "role": role,              # 'master' or 'qc'
            "can_edit_master": can_edit_master,
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
      - If is_master=True, enforce single master for that document and check master_editors.
    Notes:
      - This does NOT accept marks; Editor will PUT marks later to /mark-sets/{id}/marks.
      - Normally the document should already be created via /documents/init.
        But to be robust, we also fall back to identifier-only lookup.
    """
    try:
        # 1) Try strict 3-part business key
        doc = storage.get_document_by_business_key(
            project_name=payload.project_name,
            external_id=payload.id,
            part_number=payload.part_number,
        )

        # 2) Fallback: try legacy single-identifier lookup (doc_id / external_id / part_number)
        if not doc and hasattr(storage, "get_document_by_identifier"):
            doc = storage.get_document_by_identifier(payload.id)

        if not doc:
            # Still not found → user never called /documents/init (or keys are wildly different)
            raise HTTPException(status_code=400, detail="DOCUMENT_NOT_INITIALIZED")

        # 3) If caller wants to create a MASTER markset, enforce master_editors
        if payload.is_master:
            user_email = payload.created_by or ""
            if not _user_can_edit_master(doc, user_email):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="USER_NOT_ALLOWED_TO_EDIT_MASTER_MARKSET",
                )

        # 4) Create mark set in Sheets
        mark_set_id = storage.create_mark_set(
            doc_id=doc["doc_id"],
            label=payload.label,
            created_by=payload.created_by or "",
            marks=[],
            is_master=payload.is_master,  # default False handled in adapter
            description=payload.description or None,  # 👈 NEW: wire description
        )


        # 5) If user checked "Set as Master", enforce single master
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
