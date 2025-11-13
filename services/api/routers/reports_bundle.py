# services/api/routers/reports_bundle.py


#---------------------------------------------------------------
#
#  Warning: This endpoint is DEPRECATED and will be removed in future. Don't use it for new integrations.
#  But don't delete it yet, as the existing frontend depends on it. Before making any changes here, consult Aniket.
#  This endpoint used to bundles PDF + Excel generation and emails the results instead of returning files directly.
#  But due to less availability of time for rewiring the frontend, we are keeping it as-is for now and just modifying the script to send email only.
#
#--------------------------------------------------------------
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Dict, Optional
import json
from datetime import datetime
import logging
from urllib.parse import unquote

from core.report_pdf import generate_report_pdf
from core.report_excel import generate_report_excel
from core.email_sender import send_email_with_attachments
from settings import get_settings

logger = logging.getLogger(__name__)

def get_storage():
    from main import get_storage_adapter
    return get_storage_adapter(get_settings())

router = APIRouter(prefix="/reports", tags=["reports-bundle"])

class BundleGenerateBody(BaseModel):
    mark_set_id: str = Field(..., min_length=8)
    entries: Dict[str, str] = Field(default_factory=dict)
    pdf_url: Optional[str] = None
    # Accept both `user_email` (JSON) and `user_mail` (alias commonly used in query strings)
    user_email: Optional[str] = Field(default=None, alias="user_mail")
    padding_pct: float = 0.25
    office_variant: str = "o365"  # kept for compatibility

    model_config = {
        "populate_by_name": True,
        "extra": "allow",
    }

def validate_email(email: str) -> Optional[str]:
    if not email or not isinstance(email, str):
        return None
    email = email.strip()
    if '@' not in email:
        logger.warning(f"Invalid email format (missing @): {email}")
        return None
    local, _, domain = email.partition('@')
    if not local or not domain or '.' not in domain:
        logger.warning(f"Invalid email format (local/domain): {email}")
        return None
    invalid_patterns = ['viewer_user', 'test@test', 'example', 'placeholder']
    if any(p in email.lower() for p in invalid_patterns):
        logger.warning(f"Placeholder email detected: {email}")
        return None
    return email.lower()

@router.post("/generate-bundle")
async def generate_bundle(
    body: BundleGenerateBody,
    background_tasks: BackgroundTasks,
    storage=Depends(get_storage)
):
    """
    EMAIL-ONLY MODE:
    - Persist entries to storage (best-effort).
    - Generate PDF and Excel in-memory.
    - Queue an email with both files attached (if SMTP & email are valid).
    - RETURN JSON (no file/zip download).

    This endpoint name is kept for compatibility with the existing frontend.
    """
    settings = get_settings()

    raw_email = body.user_email
    if raw_email:
        raw_email = unquote(raw_email)

    valid_email = validate_email(raw_email) if raw_email else None
    if raw_email and not valid_email:
        logger.warning(f"Invalid email provided, will skip email: {raw_email}")

    # Resolve mark set and document
    ms_all = storage._get_all_dicts("mark_sets")
    ms = next((x for x in ms_all if x.get("mark_set_id") == body.mark_set_id), None)
    if not ms:
        raise HTTPException(status_code=404, detail="MARK_SET_NOT_FOUND")

    doc = storage.get_document(ms["doc_id"])
    if not doc:
        raise HTTPException(status_code=400, detail="DOCUMENT_NOT_FOUND")

    pdf_url = body.pdf_url or doc.get("pdf_url")
    if not pdf_url:
        raise HTTPException(status_code=400, detail="Missing pdf_url")

    marks = storage.list_marks(body.mark_set_id)
    entries = body.entries or {}
    part_number = doc.get("part_number", "Unknown")

    # Persist entries (best-effort)
    if entries and hasattr(storage, "create_user_inputs_batch"):
        try:
            storage.create_user_inputs_batch(
                mark_set_id=body.mark_set_id,
                entries=entries,
                submitted_by=valid_email or "viewer_user"
            )
            logger.info(f"✓ Saved {len(entries)} entries to Sheets/DB")
        except Exception as e:
            logger.error(f"Failed to save entries to Sheets/DB: {e}")

    # Generate PDF
    try:
        pdf_bytes = await generate_report_pdf(
            pdf_url=pdf_url,
            marks=marks,
            entries=entries,
            padding_pct=body.padding_pct,
            render_zoom=2.0,
            title=f"Inspection Report - {part_number}",
            author=valid_email or "Viewer",
        )
        logger.info(f"✓ PDF generated: {len(pdf_bytes)} bytes")
    except Exception as e:
        logger.error(f"PDF generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {str(e)}")

    # Generate Excel
    try:
        excel_bytes = await generate_report_excel(
            pdf_url=pdf_url,
            marks=marks,
            entries=entries,
            user_email=valid_email,
            mark_set_id=body.mark_set_id,
            mark_set_label=ms.get("label", ""),
            part_number=part_number,
            padding_pct=body.padding_pct,
        )
        logger.info(f"✓ Excel generated: {len(excel_bytes)} bytes")
    except Exception as e:
        logger.error(f"Excel generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Excel generation failed: {str(e)}")

    # Build metadata for email body
    filled = len([v for v in entries.values() if (v or '').strip()])
    metadata = {
        "submission_id": body.mark_set_id,
        "part_number": part_number,
        "submitted_by": valid_email or "viewer_user",
        "submitted_at_utc": datetime.utcnow().isoformat() + "Z",
        "total_marks": len(marks),
        "filled_marks": filled
    }

    # Queue email
    email_status = "skipped"
    if valid_email and settings.smtp_user and settings.smtp_password:
        background_tasks.add_task(
            send_report_email,
            to_email=valid_email,
            part_number=part_number,
            mark_set_id=body.mark_set_id,
            pdf_bytes=pdf_bytes,
            excel_bytes=excel_bytes,
            metadata=metadata,
            settings=settings
        )
        email_status = "queued"
        logger.info(f"✓ Email queued for {valid_email}")
    elif not valid_email:
        logger.info("Email skipped: no valid email provided")
    elif not settings.smtp_user or not settings.smtp_password:
        logger.warning("Email skipped: SMTP not configured")
        email_status = "not_configured"

    # RETURN JSON (no file download)
    payload = {
        "status": "ok",
        "email_status": email_status,
        "submission": {
            "mark_set_id": body.mark_set_id,
            "part_number": part_number,
            "submitted_by": metadata["submitted_by"],
            "submitted_at_utc": metadata["submitted_at_utc"],
            "total_marks": metadata["total_marks"],
            "filled_marks": metadata["filled_marks"],
        },
        "artifacts": {
            "pdf_size": len(pdf_bytes),
            "excel_size": len(excel_bytes)
        }
    }
    return JSONResponse(payload, status_code=200)

async def send_report_email(
    to_email: str,
    part_number: str,
    mark_set_id: str,
    pdf_bytes: bytes,
    excel_bytes: bytes,
    metadata: dict,
    settings
):
    """Background task to send email with PDF + Excel attachments."""
    try:
        subject = f"Inspection Submission – {part_number} – {mark_set_id}"
        body_html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #1976d2; border-bottom: 3px solid #1976d2; padding-bottom: 10px;">
                    Inspection Submission Report
                </h2>
                <p style="font-size: 16px; color: #666;">
                    A new inspection submission has been completed. Details below:
                </p>
                <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
                    <tr style="background: #f5f5f5;">
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Part Number</td>
                        <td style="padding: 12px; border: 1px solid #ddd;">{part_number}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Mark Set ID</td>
                        <td style="padding: 12px; border: 1px solid #ddd; font-family: monospace;">{mark_set_id}</td>
                    </tr>
                    <tr style="background: #f5f5f5;">
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Submitted By</td>
                        <td style="padding: 12px; border: 1px solid #ddd;">{metadata['submitted_by']}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Submitted At (UTC)</td>
                        <td style="padding: 12px; border: 1px solid #ddd;">{metadata['submitted_at_utc']}</td>
                    </tr>
                    <tr style="background: #f5f5f5;">
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Total Marks</td>
                        <td style="padding: 12px; border: 1px solid #ddd;">{metadata['total_marks']}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Filled Marks</td>
                        <td style="padding: 12px; border: 1px solid #ddd;">
                            <strong>{metadata['filled_marks']}</strong> of {metadata['total_marks']}
                            <span style="color: #4caf50; margin-left: 8px;">
                                ({round(metadata['filled_marks'] / metadata['total_marks'] * 100) if metadata['total_marks'] > 0 else 0}% complete)
                            </span>
                        </td>
                    </tr>
                </table>
                <div style="background: #e3f2fd; border-left: 4px solid #1976d2; padding: 15px; margin: 20px 0;">
                    <p style="margin: 0; font-size: 14px;">
                        📎 <strong>Attachments:</strong> This email contains 2 files:
                    </p>
                    <ul style="margin: 10px 0 0 20px; font-size: 14px;">
                        <li><code>submission_{mark_set_id}.pdf</code> - Visual inspection report</li>
                        <li><code>submission_{mark_set_id}.xlsx</code> - Detailed data spreadsheet</li>
                    </ul>
                </div>
                <p style="margin-top: 20px; color: #666; font-size: 14px;">
                    Please review the attached reports. If you have any questions or notice any discrepancies, 
                    please contact the tech team.
                </p>
                <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                <p style="color: #999; font-size: 12px; text-align: center;">
                    This is an automated message from <strong>Wootz Markbook System</strong><br>
                    For support: <a href="mailto:aniket.sandhan@wootz.work" style="color: #1976d2;">aniket.sandhan@wootz.work</a>
                </p>
            </div>
        </body>
        </html>
        """

        attachments = [
            {"filename": f"submission_{mark_set_id}.pdf", "data": pdf_bytes},
            {"filename": f"submission_{mark_set_id}.xlsx", "data": excel_bytes},
        ]

        success = await send_email_with_attachments(
            to_email=to_email,
            subject=subject,
            body_html=body_html,
            attachments=attachments,
            smtp_host=settings.smtp_host,
            smtp_port=settings.smtp_port,
            smtp_user=settings.smtp_user,
            smtp_password=settings.smtp_password,
            from_email=settings.smtp_from_email,
            from_name=settings.smtp_from_name,
        )

        if success:
            logger.info(f"✓ Email sent successfully to {to_email}")
        else:
            logger.error(f"✗ Email delivery failed to {to_email}")

    except Exception as e:
        logger.error(f"✗ Email send error for {to_email}: {e}", exc_info=True)
