# services/api/core/email_sender.py
from __future__ import annotations
import aiosmtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from typing import List, Dict, Optional
import logging

logger = logging.getLogger(__name__)

async def send_email_with_attachments(
    *,
    to_email: str,
    subject: str,
    body_html: str,
    attachments: List[Dict[str, bytes]],  # [{"filename": "x.pdf", "data": b"..."}]
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    from_email: str,
    from_name: str,
    cc_emails: Optional[List[str]] = None,   # optional CC list
    bcc_emails: Optional[List[str]] = None,  # ✅ NEW optional BCC list
) -> bool:

    """
    Send email with multiple attachments via Gmail SMTP.
    Returns True on success, False on failure.
    """
    try:
        # Create message
        msg = MIMEMultipart()
        msg['From'] = f"{from_name} <{from_email}>"
        msg['To'] = to_email
        msg['Subject'] = subject
        # Optional CC header (shown to recipients)
        clean_cc: List[str] = []
        if cc_emails:
            clean_cc = sorted(
                {
                    addr.strip()
                    for addr in cc_emails
                    if addr and addr.strip() and addr.strip().lower() != to_email.lower()
                }
            )
            if clean_cc:
                msg["Cc"] = ", ".join(clean_cc)

        # Optional BCC (NOT shown in headers)
        clean_bcc: List[str] = []
        if bcc_emails:
            # dedupe vs TO and CC
            seen = {to_email.lower(), *(a.lower() for a in clean_cc)}
            tmp = []
            for addr in bcc_emails:
                if not addr or not addr.strip():
                    continue
                a = addr.strip()
                if a.lower() in seen:
                    continue
                seen.add(a.lower())
                tmp.append(a)
            clean_bcc = sorted(set(tmp))

       
        # Attach HTML body
        msg.attach(MIMEText(body_html, 'html'))
        
        # Attach files
        for att in attachments:
            filename = att.get("filename", "attachment")
            data = att.get("data", b"")
            
            if filename.endswith('.pdf'):
                mime_type = 'application/pdf'
            elif filename.endswith('.xlsx'):
                mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            else:
                mime_type = 'application/octet-stream'
            
            part = MIMEApplication(data, _subtype=mime_type.split('/')[-1])
            part.add_header('Content-Disposition', f'attachment; filename="{filename}"')
            msg.attach(part)
        
        # Send via SMTP (ensure BCC recipients actually receive mail)
        recipients = [to_email] + clean_cc + clean_bcc

        try:
            await aiosmtplib.send(
                msg,
                hostname=smtp_host,
                port=smtp_port,
                username=smtp_user,
                password=smtp_password,
                start_tls=True,
                recipients=recipients,   # ✅ critical for BCC
            )
        except TypeError:
            # fallback for older aiosmtplib versions (BCC may not work here)
            await aiosmtplib.send(
                msg,
                hostname=smtp_host,
                port=smtp_port,
                username=smtp_user,
                password=smtp_password,
                start_tls=True,
            )

        
        logger.info(f"✓ Email sent to {to_email} with {len(attachments)} attachments")
        return True
        
    except Exception as e:
        logger.error(f"✗ Email send failed to {to_email}: {e}")
        return False