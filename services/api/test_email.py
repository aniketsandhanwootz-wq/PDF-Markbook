import asyncio
from core.email_sender import send_email_with_attachments
from settings import get_settings

async def test():
    settings = get_settings()
    
    success = await send_email_with_attachments(
        to_email="vinaywootz@wootz.work",  # Change this
        subject="Test Email from Markbook",
        body_html="<h1>Test</h1><p>This is a test email.</p>",
        attachments=[
            {"filename": "test.txt", "data": b"Hello World"}
        ],
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_user=settings.smtp_user,
        smtp_password=settings.smtp_password,
        from_email=settings.smtp_from_email,
        from_name=settings.smtp_from_name,
    )
    
    print(f"Email sent: {success}")

if __name__ == "__main__":
    asyncio.run(test())