# services/api/routers/reports_bundle.py

#---------------------------------------------------------------
#
#  Warning: This endpoint is DEPRECATED and will be removed in future. 
#  Don't use it for new integrations.
#  Existing frontend depends on it; we're only modifying it to:
#  - use master markset for total count
#  - use QC markset for user inputs
#  - generate Excel only and email it.
#
#--------------------------------------------------------------

from __future__ import annotations

from io import BytesIO
from typing import Any, Dict, List, Optional
import logging
import inspect

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from pydantic import BaseModel, EmailStr
from openpyxl import Workbook
import asyncio
from core.email_sender import send_email_with_attachments
from settings import get_settings
from core.report_excel import generate_report_excel

# Set up logger
logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/reports/bundle", tags=["reports-bundle"])


# ========== Request / Response Models ==========

class ReportBundleRequest(BaseModel):
    """
    Request body for generating & emailing a report bundle.

    Semantics:
    - doc_id:       the document being inspected
    - mark_set_id:  the *QC* mark_set_id (where user inputs & groups live)
    - email_to:     recipient email
    - submitted_by: (optional) who filled the QC; used to filter inputs
    - report_name:  (optional) human-friendly title shown in email/Excel
    - report_id:    (optional) unique ID for this submission, used to isolate inputs
    - poc_cc:       (optional) comma-separated list of POC emails to CC for this run
    """
    doc_id: str
    mark_set_id: str
    email_to: EmailStr
    submitted_by: Optional[str] = None
    report_name: Optional[str] = None
    report_id: Optional[str] = None
    poc_cc: Optional[str] = None



class ReportBundleQueuedResponse(BaseModel):
    status: str
    message: str


# ========== Helpers to resolve master vs QC mark sets ==========

def _normalize_bool_str(v: Any) -> str:
    """
    Normalize a Sheets boolean-ish cell to "TRUE" / "FALSE".
    """
    try:
        s = (str(v or "")).strip().upper()
        if s in ("TRUE", "1", "YES", "Y"):
            return "TRUE"
        if s in ("FALSE", "0", "NO", "N"):
            return "FALSE"
        return "FALSE"
    except Exception as e:
        logger.warning(f"Error normalizing bool value '{v}': {e}")
        return "FALSE"


def _find_master_and_qc_mark_sets(
    storage: Any,
    doc_id: str,
    qc_mark_set_id: str,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Given a doc_id and a QC mark_set_id:
    - Find the QC mark_set row.
    - Find the master mark_set row for the same document (is_master == TRUE).
    """
    try:
        mark_sets = storage.list_mark_sets_by_document(doc_id)
    except AttributeError as e:
        logger.error(f"Storage missing list_mark_sets_by_document: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage adapter configuration error",
        )
    except Exception as e:
        logger.error(f"Failed to list mark sets for doc {doc_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve mark sets: {str(e)}",
        )

    qc_ms: Optional[Dict[str, Any]] = None
    master_ms: Optional[Dict[str, Any]] = None

    try:
        for ms in mark_sets:
            if ms.get("mark_set_id") == qc_mark_set_id:
                qc_ms = ms
            if _normalize_bool_str(ms.get("is_master")) == "TRUE":
                master_ms = ms
    except Exception as e:
        logger.error(f"Error processing mark sets: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error processing mark sets: {str(e)}",
        )

    if qc_ms is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"QC_MARK_SET_NOT_FOUND: {qc_mark_set_id}",
        )

    if master_ms is None:
        # Fallback: if no master explicitly set, treat the QC as master
        logger.warning(f"No master mark set found for doc {doc_id}, using QC as fallback")
        master_ms = qc_ms

    return master_ms, qc_ms


def _count_master_marks(storage: Any, doc_id: str, master_mark_set_id: str) -> int:
    """
    Use the Sheets adapter's count_marks_by_mark_set(doc_id) which only counts rows
    in the `marks` sheet (master marks only).
    """
    try:
        counts = storage.count_marks_by_mark_set(doc_id)
        return int(counts.get(master_mark_set_id, 0))
    except AttributeError as e:
        logger.error(f"Storage missing count_marks_by_mark_set: {e}")
        return 0
    except (ValueError, TypeError) as e:
        logger.warning(f"Error converting mark count to int: {e}")
        return 0
    except Exception as e:
        logger.error(f"Error counting marks for {master_mark_set_id}: {e}")
        return 0


# ========== Excel Generation (master marks + QC results) ==========

def _build_excel_bytes_for_qc(
    storage: Any,
    doc_id: str,
    master_mark_set_id: str,
    qc_mark_set_id: str,
    submitted_by: Optional[str],
    report_title: str,
) -> bytes:
    """
    Build a single-sheet Excel report that joins:
    - master marks  (from `marks` for master_mark_set_id)
    - QC user inputs (from mark_user_input for qc_mark_set_id)
    - groups (from groups for qc_mark_set_id)

    Returns raw XLSX bytes.
    """
    try:
        doc = storage.get_document(doc_id) or {}
    except Exception as e:
        logger.error(f"Failed to get document {doc_id}: {e}")
        doc = {}

    # --- Fetch data from Sheets ---

    # Master marks (one row per mark, ordered)
    try:
        master_marks = storage.list_marks(master_mark_set_id)
    except Exception as e:
        logger.error(f"Failed to list marks for {master_mark_set_id}: {e}")
        master_marks = []

    # User inputs for this QC run
    try:
        user_inputs = storage.get_user_inputs(
            mark_set_id=qc_mark_set_id, 
            submitted_by=submitted_by
        )
    except Exception as e:
        logger.error(f"Failed to get user inputs for {qc_mark_set_id}: {e}")
        user_inputs = []

    # Groups for this QC mark set
    try:
        groups = storage.list_groups_for_mark_set(qc_mark_set_id)
    except Exception as e:
        logger.error(f"Failed to list groups for {qc_mark_set_id}: {e}")
        groups = []

    # Build maps for quick joins
    mark_id_to_value: Dict[str, str] = {}
    for ui in user_inputs:
        try:
            mid = ui.get("mark_id")
            if not mid:
                continue
            mark_id_to_value[mid] = ui.get("user_value", "")
        except Exception as e:
            logger.warning(f"Error processing user input: {e}")
            continue

    # mark_id -> list of group names
    mark_id_to_groups: Dict[str, List[str]] = {}
    for g in groups:
        try:
            name = g.get("name", "")
            mark_ids = g.get("mark_ids", []) or []
            for mid in mark_ids:
                if not mid:
                    continue
                mark_id_to_groups.setdefault(mid, []).append(name)
        except Exception as e:
            logger.warning(f"Error processing group: {e}")
            continue

    # --- Build workbook ---

    try:
        wb = Workbook()
        ws = wb.active
        ws.title = "Inspection"

        # Header row
        ws.append(
            [
                "#",
                "Mark Label",
                "Instrument",
                "Required",
                "Page Index",
                "User Value",
                "Groups",
            ]
        )

        # Data rows from master marks
        for idx, m in enumerate(master_marks, start=1):
            try:
                mark_id = m.get("mark_id", "")
                label = m.get("label", "")
                instrument = m.get("instrument", "")
                is_required = "YES" if m.get("is_required") else "NO"
                page_index = m.get("page_index", 0)

                user_val = mark_id_to_value.get(mark_id, "")
                group_list = mark_id_to_groups.get(mark_id, [])
                groups_str = ", ".join(group_list)

                ws.append(
                    [
                        idx,
                        label,
                        instrument,
                        is_required,
                        page_index,
                        user_val,
                        groups_str,
                    ]
                )
            except Exception as e:
                logger.warning(f"Error adding mark row {idx}: {e}")
                continue

        # Save to bytes
        bio = BytesIO()
        wb.save(bio)
        return bio.getvalue()

    except Exception as e:
        logger.error(f"Failed to build Excel workbook: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate Excel report: {str(e)}",
        )


# ========== Email Helper ==========

async def _send_excel_email(
    to_email: str,
    report_name: str,
    doc: Dict[str, Any],
    master_ms: Dict[str, Any],
    qc_ms: Dict[str, Any],
    total_marks: int,
    completed_marks: int,
    excel_bytes: bytes,
    poc_cc_raw: Optional[str] = None,   # NEW: dynamic POC CC string
) -> None:
    """
    Send an email with a *single* Excel attachment,
    describing completed vs total marks using master marks count.
    Uses core.email_sender.send_email_with_attachments (async).
    """
    from settings import get_settings
    from core.email_sender import send_email_with_attachments

    try:
        settings = get_settings()

        doc_label = (
            doc.get("part_number")
            or doc.get("external_id")
            or doc.get("doc_id")
            or "Document"
        )
        qc_label = qc_ms.get("name", "QC Run")
        # --- Build CC list ---
        # 1) Fixed CC emails from settings (comma-separated, env: SMTP_ALWAYS_CC)
        fixed_cc_raw = getattr(settings, "smtp_always_cc", None) or ""
        fixed_cc = [
            addr.strip()
            for addr in fixed_cc_raw.split(",")
            if addr and addr.strip()
        ]

        # 2) Dynamic POC list from Viewer / Glide (comma-separated)
        poc_cc_list: List[str] = []
        if poc_cc_raw:
            poc_cc_list = [
                addr.strip()
                for addr in poc_cc_raw.split(",")
                if addr and addr.strip()
            ]

        # 3) Merge + de-duplicate, never CC the main TO twice
        all_cc: List[str] = []
        seen = {to_email.lower()}
        for addr in fixed_cc + poc_cc_list:
            low = addr.lower()
            if low in seen:
                continue
            seen.add(low)
            all_cc.append(addr)

        # Subject: include report_name if provided
        if report_name:
            subject = f"{report_name} – Dimensional Inspection Report for {doc_label}"
        else:
            subject = f"Dimensional Inspection Report for {doc_label}"

        report_line = f"<li>Report title: {report_name}</li>" if report_name else ""

        body_html = (
            f"<p>Hello,</p>"
            f"<p>Your Dimensional Inspection report for Part <b>{doc_label}</b> is ready.</p>"
            f"<ul>"
            f"{report_line}"
            f"<li>Inspection Map: {qc_label}</li>"
            f"<li>Completed marks: {completed_marks} of {total_marks}</li>"
            f"</ul>"
            f"<p>Please find the attached Dimensional Inspection report as Excel file.</p>"
            f"<p>Regards,<br/>Wootz.Inspect</p>"
        )

        filename = f"{report_name or 'inspection-report'}.xlsx"

        # NOTE: email_sender expects "data" key here
        attachments = [
            {
                "filename": filename,
                "data": excel_bytes,
            }
        ]

        # Pull SMTP config from settings.py
        smtp_host = settings.smtp_host
        smtp_port = settings.smtp_port
        smtp_user = settings.smtp_user
        smtp_password = settings.smtp_password
        from_email = settings.smtp_from_email or smtp_user
        from_name = settings.smtp_from_name or "Wootz Markbook System"

        ok = await send_email_with_attachments(
            to_email=to_email,
            subject=subject,
            body_html=body_html,
            attachments=attachments,
            smtp_host=smtp_host,
            smtp_port=smtp_port,
            smtp_user=smtp_user,
            smtp_password=smtp_password,
            from_email=from_email,
            from_name=from_name,
            cc_emails=all_cc or None,   # NEW
        )

        if ok:
            logger.info(f"Successfully sent email to {to_email}")
        else:
            logger.error(f"Email send returned False for {to_email}")

    except Exception as e:
        logger.exception(f"Failed to send email to {to_email}: {e}")
        # Don't raise – this is called from background job

# ========== Background Task ==========
# ========== Background Task ==========

async def _generate_and_send_excel_bundle(
    app,
    req: ReportBundleRequest,
) -> None:
    """
    Thin wrapper that enforces concurrency limits via app.state.report_semaphore,
    then delegates to _do_generate_and_send_excel_bundle.
    """
    sem = getattr(getattr(app, "state", None), "report_semaphore", None)
    if sem is None:
        # No semaphore configured → run directly (e.g. tests)
        await _do_generate_and_send_excel_bundle(app, req)
        return

    async with sem:
        await _do_generate_and_send_excel_bundle(app, req)


async def _do_generate_and_send_excel_bundle(
    app,
    req: ReportBundleRequest,
) -> None:
    """
    Background job:
    - Resolve master vs QC mark sets.
    - Compute subset of master marks that belong to this QC markset
      (via groups + user inputs).
    - Enforce max_marks_per_report cap.
    - Generate Excel only for that subset.
    - Send email with ONLY Excel attached.
    """

    try:
        storage_backend = getattr(app.state, "storage_backend", None)
        if storage_backend != "sheets":
            logger.info("Skipping bundle generation - not using sheets backend")
            return

        storage = getattr(app.state, "storage_adapter", None)
        if storage is None:
            logger.error("Storage adapter not available")
            return

        try:
            doc = storage.get_document(req.doc_id)
        except Exception as e:
            logger.error(f"Failed to get document {req.doc_id}: {e}")
            return

        if not doc:
            logger.error(f"Document not found: {req.doc_id}")
            return

        # 1) Resolve master + QC mark sets
        try:
            master_ms, qc_ms = _find_master_and_qc_mark_sets(
                storage=storage,
                doc_id=req.doc_id,
                qc_mark_set_id=req.mark_set_id,
            )
        except HTTPException as e:
            logger.error(f"Failed to find mark sets: {e.detail}")
            return
        except Exception as e:
            logger.exception(f"Unexpected error finding mark sets: {e}")
            return

        master_mark_set_id = master_ms["mark_set_id"]
        qc_mark_set_id = qc_ms["mark_set_id"]

        # 2) Get user inputs (for this QC run)
        try:
            user_inputs = storage.get_user_inputs(
                mark_set_id=qc_mark_set_id,
                submitted_by=req.submitted_by,
                report_id=req.report_id,
            )
        except Exception as e:
            logger.error(f"Failed to get user inputs for {qc_mark_set_id}: {e}")
            user_inputs = []

        # 3) Get groups for this QC mark set
        try:
            groups = storage.list_groups_for_mark_set(qc_mark_set_id)
        except Exception as e:
            logger.error(f"Failed to list groups for {qc_mark_set_id}: {e}")
            groups = []

        # 4) Build allowed_mark_ids from:
        #    - marks that appear in any group for this QC markset
        #    - marks that have a user input in this QC run
        allowed_mark_ids: set[str] = set()

        for ui in user_inputs:
            mid = ui.get("mark_id")
            if mid:
                allowed_mark_ids.add(mid)

        for g in groups:
            try:
                for mid in (g.get("mark_ids") or []):
                    if mid:
                        allowed_mark_ids.add(mid)
            except Exception as e:
                logger.warning(f"Error processing group for allowed_mark_ids: {e}")
                continue

        # 5) Fetch master marks and filter down to the ones that belong to this QC markset
        try:
            master_marks = storage.list_marks(master_mark_set_id)
        except Exception as e:
            logger.error(f"Failed to list marks for {master_mark_set_id}: {e}")
            return

        if allowed_mark_ids:
            filtered_marks = [m for m in master_marks if m.get("mark_id") in allowed_mark_ids]
        else:
            # If we somehow have no allowed IDs, treat as "no relevant marks"
            filtered_marks = []

        # 6) Enforce global cap on number of marks per report
        max_marks = getattr(settings, "max_marks_per_report", 300)
        if len(filtered_marks) > max_marks:
            logger.warning(
                f"Trimming marks for bundle report: {len(filtered_marks)} → {max_marks} "
                f"(max_marks_per_report)"
            )
            filtered_marks = filtered_marks[:max_marks]

        filtered_ids = {m.get("mark_id") for m in filtered_marks if m.get("mark_id")}

        # total_marks should reflect the marks actually going into this report
        total_marks = len(filtered_ids)

        # 7) Compute completed marks only within filtered_ids
        #    Treat "NA" (any case) as NOT completed.
        completed_marks = len(
            {
                ui.get("mark_id")
                for ui in user_inputs
                if ui.get("mark_id") in filtered_ids
                and (
                    (ui.get("user_value") or "").strip() != ""
                    and (ui.get("user_value") or "").strip().upper() != "NA"
                )
            }
        )


        # 8) Build mark_id -> user_value + mark_id -> status maps ONLY for filtered marks
        mark_id_to_value: Dict[str, str] = {}
        mark_id_to_status: Dict[str, str] = {}

        for ui in user_inputs:
            try:
                mid = ui.get("mark_id")
                if not mid or mid not in filtered_ids:
                    continue

                # Observed value (what user typed)
                mark_id_to_value[mid] = ui.get("user_value", "")

                # Try to pick up status from mark_user_input row
                raw_status = (
                    ui.get("status")
                    or ui.get("qc_status")
                    or ui.get("result")
                    or ""
                )
                if raw_status:
                    mark_id_to_status[mid] = raw_status
            except Exception as e:
                logger.warning(f"Error processing user input for Excel: {e}")
                continue


        pdf_url = doc.get("pdf_url")
        if not pdf_url:
            logger.error(f"Missing pdf_url for doc {req.doc_id}, cannot build Excel")
            return

        report_name = req.report_name or f"{doc.get('part_number') or 'inspection'}-QC"

        # 9) Build Excel bytes using ONLY the filtered marks
        try:
            excel_bytes = await generate_report_excel(
                pdf_url=pdf_url,
                marks=filtered_marks,
                entries=mark_id_to_value,
                user_email=req.submitted_by or req.email_to,
                mark_set_id=qc_mark_set_id,
                mark_set_label=qc_ms.get("name", "") or qc_ms.get("label", ""),
                part_number=doc.get("part_number", "") or "",
                external_id=doc.get("external_id", "") or "",
                report_title=req.report_name or "",
                padding_pct=0.25,
                logo_url="https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
                statuses=mark_id_to_status,  # 🔹 NEW: pass per-mark statuses into Excel
            )

        except Exception as e:
            logger.exception(f"Failed to build Excel: {e}")
            return

        # 9b) Create a report history record (inspection_reports) using the SAME report_id
        try:
            if hasattr(storage, "create_report_record"):
                storage.create_report_record(
                    mark_set_id=qc_mark_set_id,
                    # If you later upload the Excel anywhere, store that URL here
                    inspection_doc_url="",
                    created_by=req.submitted_by or req.email_to,
                    # 🔑 keep this in sync with mark_user_input.report_id
                    report_id=req.report_id,
                    # store the human-friendly title used in email/Excel
                    report_title=report_name,
                    submitted_by=req.submitted_by or req.email_to,
                )
        except Exception as e:
            logger.warning(f"Failed to create report record: {e}")


        # 10) Send email with ONLY Excel attached (async)
        await _send_excel_email(
            to_email=req.email_to,
            report_name=report_name,
            doc=doc,
            master_ms=master_ms,
            qc_ms=qc_ms,
            total_marks=total_marks,
            completed_marks=completed_marks,
            excel_bytes=excel_bytes,
            poc_cc_raw=req.poc_cc,   # NEW
        )


    except Exception as e:
        logger.exception(f"Unexpected error in background task: {e}")

# ========== Public Endpoint ==========

@router.post(
    "/generate",
    response_model=ReportBundleQueuedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def queue_report_bundle(
    req: ReportBundleRequest,
    background_tasks: BackgroundTasks,
    request: Request,
) -> ReportBundleQueuedResponse:
    """
    Queue a background Excel-only QC report generation + email.

    - Uses the master mark set (is_master=TRUE) for total_marks and row definitions.
    - Uses the given mark_set_id as the QC run for user inputs & groups.
    - Produces ONE Excel file and sends via email.
    """

    try:
        app = request.app
        storage_backend = getattr(app.state, "storage_backend", None)

        if storage_backend != "sheets":
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="reports/bundle is only supported with the Google Sheets backend",
            )

        storage = getattr(app.state, "storage_adapter", None)
        if storage is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Sheets adapter not initialized",
            )

        # quick validation in foreground
        try:
            doc = storage.get_document(req.doc_id)
        except Exception as e:
            logger.error(f"Failed to get document {req.doc_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to retrieve document: {str(e)}",
            )

        if not doc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"DOCUMENT_NOT_FOUND: {req.doc_id}",
            )

        # Validate that QC + master mark sets exist; errors here are surfaced to frontend
        try:
            _find_master_and_qc_mark_sets(
                storage=storage, 
                doc_id=req.doc_id, 
                qc_mark_set_id=req.mark_set_id
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Unexpected error validating mark sets: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error validating mark sets: {str(e)}",
            )

        # Background task (Excel-only, no PDF)
        background_tasks.add_task(_generate_and_send_excel_bundle, app, req)


        return ReportBundleQueuedResponse(
            status="queued",
            message="Report bundle generation has been queued (Excel-only).",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Unexpected error in queue_report_bundle: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal server error: {str(e)}",
        )