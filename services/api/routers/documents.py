# services/api/routers/documents.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Annotated, Optional, Dict, Any, List
from pydantic import BaseModel, Field
import logging  # 👈 add this

logger = logging.getLogger(__name__)  # 👈 add this
# clean_pdf_url removed from backend; viewer now sends clean URL directly.
def clean_pdf_url(url: str) -> str:
    return url   # passthrough
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
    dwg_num: Optional[str] = Field(
        default=None,
        description="Drawing number for this PDF (assembly or part)",
    )



class MarkSetCreateForDoc(BaseModel):
    # 3-part business key + drawing number
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1)
    part_number: str = Field(min_length=1)
    dwg_num: Optional[str] = Field(
        default=None,
        description="Drawing number for this PDF (assembly or part)",
    )

    # markset metadata
    label: str = Field(min_length=1, description="Markset label to show in UI")
    created_by: Optional[str] = None
    is_master: bool = False
    description: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Short description shown in UI",
    )



class DocumentInitPayload(BaseModel):
    project_name: str = Field(min_length=1)
    id: str = Field(min_length=1, description="Business id (ProjectName + PartName)")
    part_number: str = Field(min_length=1)
    dwg_num: Optional[str] = Field(
        default=None,
        description="Drawing number for this PDF (assembly or part)",
    )
    drawing_type: Optional[str] = Field(
        default=None,
        description="Type of drawing (Part/Fabrication/Assembly/Sub Assembly/Boughtout)",
    )
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
    dwg_num: Optional[str],
    pdf_url: Optional[str],
    created_by: Optional[str],
) -> str:
    """
    Find a document by the business key; if not found, create it.
    Business key = (project_name, external_id, part_number, dwg_num).

    dwg_num can be None/empty to keep behaviour backwards compatible.
    """
    doc = storage.get_document_by_business_key(
        project_name=project_name,
        external_id=external_id,
        part_number=part_number,
        dwg_num=dwg_num or "",
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
        master_editors=DEFAULT_MASTER_EDITORS,
        dwg_num=dwg_num or "",
    )

# ====== Endpoints ======

@router.get("/by-identifier", status_code=status.HTTP_200_OK)
async def get_by_identifier(
    storage: Storage,
    project_name: str = Query(..., min_length=1),
    id: str = Query(..., min_length=1, description="Business id (ProjectName + PartName)"),
    part_number: str = Query(..., min_length=1),
    dwg_num: Optional[str] = Query(
        None,
        description="Drawing number for this PDF (assembly or part)",
    ),
    user_mail: Optional[str] = Query(None, description="Caller email (used for role=master/qc)"),
):
    """
    Resolve document(s) by (project_name, id, part_number).

    Behaviour:
    - If dwg_num is provided  -> return a SINGLE document (legacy behaviour).
    - If dwg_num is NOT given -> return ALL matching documents for that triple,
      plus all their mark sets, each annotated with doc_id/dwg_num/pdf_url.
    """
    try:
        # ---------- CASE 1: dwg_num explicitly provided -> single-doc behaviour ----------
        if dwg_num and dwg_num.strip():
            doc_raw = storage.get_document_by_business_key(
                project_name=project_name,
                external_id=id,
                part_number=part_number,
                dwg_num=dwg_num,
            )
            if not doc_raw:
                raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

            doc: Document = document_from_sheets(doc_raw)

            mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
            mark_set_models: List[MarkSet] = [
                markset_from_sheets(ms) for ms in mark_sets_raw
            ]

            master_id = _master_mark_set_id(mark_set_models)
            counts = (
                storage.count_marks_by_mark_set(doc.doc_id)
                if hasattr(storage, "count_marks_by_mark_set")
                else {}
            )

            role = _infer_role(doc_raw, user_mail)
            can_edit_master = _user_can_edit_master(doc_raw, user_mail)

            return {
                "document": {
                    "doc_id": doc.doc_id,
                    "project_name": doc.project_name or "",
                    "id": doc.external_id or "",
                    "part_number": doc.part_number or "",
                    "dwg_num": getattr(doc, "dwg_num", None) or (doc_raw.get("dwg_num") or ""),
                    "drawing_type": getattr(doc, "drawing_type", None)
                        or (doc_raw.get("drawing_type") or "-"),
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
                        # extra metadata so viewer can always know where this markset lives
                        "doc_id": doc.doc_id,
                        "dwg_num": getattr(doc, "dwg_num", None) or (doc_raw.get("dwg_num") or ""),
                        "pdf_url": doc.pdf_url,
                    }
                    for ms in mark_set_models
                ],
                "master_mark_set_id": master_id,
                "mark_set_count": len(mark_set_models),
                "role": role,            # 'master' or 'qc'
                "can_edit_master": can_edit_master,
            }

        # ---------- CASE 2: no dwg_num -> ALL documents for this triple ----------
        # Prefer the new multi-doc helper if available
        docs_raw: List[dict[str, Any]] = []
        if hasattr(storage, "list_documents_by_business_key"):
            docs_raw = storage.list_documents_by_business_key(
                project_name=project_name,
                external_id=id,
                part_number=part_number,
            )
        else:
            # Fallback: legacy single-doc behaviour
            single = storage.get_document_by_business_key(
                project_name=project_name,
                external_id=id,
                part_number=part_number,
                dwg_num="",
            )
            if single:
                docs_raw = [single]

        if not docs_raw:
            raise HTTPException(status_code=404, detail="DOCUMENT_NOT_FOUND")

        # Convert all documents to domain models
        doc_models: List[Document] = [document_from_sheets(d) for d in docs_raw]

        documents_out: List[Dict[str, Any]] = []
        all_markset_models: List[MarkSet] = []
        all_marksets_out: List[Dict[str, Any]] = []

        for doc_raw, doc in zip(docs_raw, doc_models):
            # top-level per-document metadata
            documents_out.append(
                {
                    "doc_id": doc.doc_id,
                    "project_name": doc.project_name or "",
                    "id": doc.external_id or "",
                    "part_number": doc.part_number or "",
                    "dwg_num": getattr(doc, "dwg_num", None) or (doc_raw.get("dwg_num") or ""),
                    "drawing_type": getattr(doc, "drawing_type", None)
                        or (doc_raw.get("drawing_type") or "-"),
                    "pdf_url": doc.pdf_url,
                    "page_count": doc.page_count,
                    "master_editors": (doc_raw.get("master_editors") or "").strip(),
                }
            )


            # mark-sets for this document
            mark_sets_raw = storage.list_mark_sets_by_document(doc.doc_id)
            mark_set_models = [markset_from_sheets(ms) for ms in mark_sets_raw]
            all_markset_models.extend(mark_set_models)

            counts = (
                storage.count_marks_by_mark_set(doc.doc_id)
                if hasattr(storage, "count_marks_by_mark_set")
                else {}
            )

            for ms in mark_set_models:
                all_marksets_out.append(
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
                        # 🔑 key for viewer grouping & correct PDF selection
                        "doc_id": doc.doc_id,
                        "dwg_num": getattr(doc, "dwg_num", None) or (doc_raw.get("dwg_num") or ""),
                        "pdf_url": doc.pdf_url,
                    }
                )

        # Derive one master_mark_set_id (for backwards compatibility)
        master_id = _master_mark_set_id(all_markset_models)

        # Role / permissions based on first doc (they share master_editors)
        first_doc_raw = docs_raw[0]
        role = _infer_role(first_doc_raw, user_mail)
        can_edit_master = _user_can_edit_master(first_doc_raw, user_mail)

        # For backward compatibility keep a single "document" field as well
        primary_doc_out = documents_out[0]

        return {
            "document": primary_doc_out,    # legacy
            "documents": documents_out,     # NEW: full list for this triple
            "mark_sets": all_marksets_out,  # NEW: all mark_sets with dwg_num/pdf_url/doc_id
            "master_mark_set_id": master_id,
            "mark_set_count": len(all_marksets_out),
            "role": role,
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
        # 🔍 Log exactly what we received
        logger.info(
            "[documents.init] incoming payload: project_name=%s id=%s part_number=%s dwg_num=%s drawing_type=%s pdf_url=%s assembly_drawing=%s user_mail=%s",
            payload.project_name,
            payload.id,
            payload.part_number,
            payload.dwg_num,
            payload.drawing_type or "",
            payload.pdf_url or "",
            payload.assembly_drawing or "",
            payload.user_mail or "",
        )


        # 🔎 Normalise drawing type from payload
        incoming_type_raw = (payload.drawing_type or "").strip()

        # 🚫 Strong guard: we *require* dwg_num now so we don't collapse multiple PDFs.
        if not (payload.dwg_num and payload.dwg_num.strip()):
            logger.warning(
                "[documents.init] dwg_num missing for (%s, %s, %s) – refusing to create legacy document.",
                payload.project_name,
                payload.id,
                payload.part_number,
            )
            raise HTTPException(
                status_code=400,
                detail="DWG_NUM_REQUIRED_FOR_DOCUMENT_INIT",
            )

        # 1) Try to find existing (Sheets → Domain)
        doc_raw = storage.get_document_by_business_key(
            project_name=payload.project_name,
            external_id=payload.id,
            part_number=payload.part_number,
            dwg_num=payload.dwg_num or "",
        )

        logger.info(
            "[documents.init] lookup for (%s, %s, %s, dwg=%s) -> %s",
            payload.project_name,
            payload.id,
            payload.part_number,
            payload.dwg_num or "",
            (doc_raw or {}).get("doc_id", "NONE"),
        )

        if not doc_raw:
            # 2) Resolve/clean the PDF URL to store
            # PDF URL now comes already cleaned from frontend.
            pdf_url = payload.pdf_url or payload.assembly_drawing

            if not pdf_url:
                raise HTTPException(
                    status_code=400,
                    detail="Provide pdf_url or assembly_drawing",
                )

            cleaned = pdf_url.strip()

            if not cleaned.lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=400,
                    detail="Resolved URL is not a PDF",
                )

            # 3) Create new document in Sheets
            #    If no type is provided, store '-' as placeholder
            normalized_type = incoming_type_raw or "-"
            doc_id = storage.create_document(
                pdf_url=cleaned,
                created_by=payload.user_mail or "",
                part_number=payload.part_number,
                project_name=payload.project_name,
                external_id=payload.id,
                master_editors=DEFAULT_MASTER_EDITORS,  # seed master editors
                dwg_num=payload.dwg_num or "",
                drawing_type=normalized_type,
            )
            doc_raw = storage.get_document(doc_id)
        else:
            # 3.b) Document already exists -> optionally update drawing_type
            existing_type_raw = (doc_raw.get("drawing_type") or "").strip()

            # Decide if we need to change type:
            #  • If client sent a non-empty type and it's different, use that.
            #  • If doc has no type and client didn't send anything, set '-'.
            normalized_for_update: Optional[str] = None

            if incoming_type_raw:
                if incoming_type_raw != existing_type_raw:
                    normalized_for_update = incoming_type_raw
            else:
                if not existing_type_raw:
                    normalized_for_update = "-"

            if normalized_for_update is not None and normalized_for_update != existing_type_raw:
                try:
                    if hasattr(storage, "update_document"):
                        storage.update_document(
                            doc_id=doc_raw["doc_id"],
                            drawing_type=normalized_for_update,
                        )
                        doc_raw["drawing_type"] = normalized_for_update
                        logger.info(
                            "[documents.init] updated drawing_type for doc_id=%s from '%s' to '%s'",
                            doc_raw["doc_id"],
                            existing_type_raw,
                            normalized_for_update,
                        )
                    else:
                        logger.warning(
                            "[documents.init] storage adapter has no update_document; cannot persist drawing_type change"
                        )
                except Exception as e:
                    logger.warning(
                        "[documents.init] failed to update drawing_type for doc_id=%s: %s",
                        doc_raw.get("doc_id", "UNKNOWN"),
                        e,
                    )

 
        # --- If document already existed, update drawing_type when needed ---
        if doc_raw:
            existing_type = (doc_raw.get("drawing_type") or "").strip()

            if incoming_type_raw:
                # explicit new type from editor – override if different
                if incoming_type_raw != existing_type:
                    storage.update_document(
                        doc_raw["doc_id"],
                        {"drawing_type": incoming_type_raw},
                    )
                    doc_raw = storage.get_document(doc_raw["doc_id"])
            else:
                # no type passed: ensure at least "-" is set once
                if not existing_type:
                    storage.update_document(
                        doc_raw["doc_id"],
                        {"drawing_type": "-"},
                    )
                    doc_raw = storage.get_document(doc_raw["doc_id"])

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
            "dwg_num": getattr(doc, "dwg_num", None) or (doc_raw.get("dwg_num") or ""),
            "drawing_type": getattr(doc, "drawing_type", None)
                or (doc_raw.get("drawing_type") or "-"),
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
            dwg_num=payload.dwg_num or "",
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
