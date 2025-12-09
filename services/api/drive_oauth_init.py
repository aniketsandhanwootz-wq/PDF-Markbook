#This is one time file to handle OAuth flow and generate token file for Google Drive API access.
from __future__ import annotations

from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

# We only need file-level access for Drive uploads
SCOPES = ["https://www.googleapis.com/auth/drive.file"]

BASE_DIR = Path(__file__).resolve().parent  # services/api
CREDENTIALS_DIR = BASE_DIR / "creds"
CLIENT_SECRET_FILE = CREDENTIALS_DIR / "drive_oauth_client.json"
TOKEN_FILE = CREDENTIALS_DIR / "drive_token.json"


def main():
    if not CLIENT_SECRET_FILE.exists():
        raise SystemExit(
            f"Missing {CLIENT_SECRET_FILE}. "
            "Put your downloaded OAuth client JSON there as drive_oauth_client.json"
        )

    creds = None
    if TOKEN_FILE.exists():
        # If token already exists, try to reuse it
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # Refresh expired token
            creds.refresh(Request())
        else:
            # First-time auth: open browser & ask you to log in
            flow = InstalledAppFlow.from_client_secrets_file(
                str(CLIENT_SECRET_FILE), SCOPES
            )
            # This starts a local web server and opens browser
            creds = flow.run_local_server(port=0)

        # Save the credentials for next time
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(TOKEN_FILE, "w") as token:
            token.write(creds.to_json())

    print(f"✅ Drive OAuth token saved to {TOKEN_FILE}")


if __name__ == "__main__":
    main()
