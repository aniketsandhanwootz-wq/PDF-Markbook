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
        
        # Send via SMTP
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