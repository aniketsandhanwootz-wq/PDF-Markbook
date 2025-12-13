# services/api/core/vision_ocr.py
from __future__ import annotations

import io
import logging
import re
from typing import Optional, Tuple

import requests
from pdf2image import convert_from_bytes
from PIL import Image, ImageOps
from google.cloud import vision
from google.oauth2 import service_account

from settings import get_settings

logger = logging.getLogger(__name__)

# You can tweak this later; UI will use it for orange border, etc.
LOW_CONFIDENCE_THRESHOLD = 95.0


def _fetch_pdf_bytes(pdf_url: str) -> bytes:
    """
    Download the PDF from a public URL (GCS / Cloudinary-cleaned URL).

    Raises on HTTP error.
    """
    logger.info(f"[vision_ocr] Fetching PDF for OCR: {pdf_url}")
    resp = requests.get(pdf_url, timeout=20)
    resp.raise_for_status()
    return resp.content


def _render_page_to_image(pdf_bytes: bytes, page_index: int) -> Image.Image:
    """
    Render a single PDF page to a PIL Image using pdf2image.

    page_index is 0-based; pdf2image expects 1-based page numbers.
    """
    page_num = page_index + 1
    images = convert_from_bytes(
        pdf_bytes,
        first_page=page_num,
        last_page=page_num,
        fmt="png",
        dpi=300,
    )
    if not images:
        raise RuntimeError(f"No image rendered for page_index={page_index}")
    return images[0]


def _crop_normalized_region(
    img: Image.Image,
    nx: float,
    ny: float,
    nw: float,
    nh: float,
) -> Image.Image:
    """
    Crop a normalized [0..1] rectangle (nx,ny,nw,nh) from a PIL image.

    Coordinates are top-left origin, same as editor.
    """
    width, height = img.size

    left = max(0, int(nx * width))
    top = max(0, int(ny * height))
    right = min(width, int((nx + nw) * width))
    bottom = min(height, int((ny + nh) * height))

    if right <= left or bottom <= top:
        raise ValueError("Invalid crop region computed from normalized bbox")

    return img.crop((left, top, right, bottom))


def _preprocess_for_digits(img: Image.Image) -> bytes:
    """
    Preprocess the cropped region to help Vision read small numeric text.

    Steps:
    - Convert to grayscale
    - Auto-contrast
    - Optional upscaling
    - Simple binarization
    - Return PNG bytes
    """
    gray = img.convert("L")
    # Boost contrast a bit
    gray = ImageOps.autocontrast(gray, cutoff=2)

    # Upscale small patches to at least ~64px on the smallest side (max 4x)
    w, h = gray.size
    min_side = min(w, h)
    if min_side > 0:
        scale = max(1.0, min(4.0, 64.0 / float(min_side)))
    else:
        scale = 1.0

    if scale > 1.0:
        new_size = (int(w * scale), int(h * scale))
        gray = gray.resize(new_size, Image.LANCZOS)

    # Simple threshold to get black text on white background
    # (Vision is tolerant, this is mostly to clean noise)
    def _threshold(p: int) -> int:
        return 255 if p > 180 else 0

    bw = gray.point(_threshold)

    buf = io.BytesIO()
    bw.save(buf, format="PNG")
    return buf.getvalue()


def _build_vision_client() -> vision.ImageAnnotatorClient:
    """
    Build a Google Cloud Vision client using the same service account JSON
    as Sheets (Settings.resolved_google_sa_json()).
    """
    settings = get_settings()
    sa_path = settings.resolved_google_sa_json()
    creds = service_account.Credentials.from_service_account_file(sa_path)
    return vision.ImageAnnotatorClient(credentials=creds)


def _extract_numeric_from_text(text: str) -> Optional[str]:
    """
    Extract the most plausible numeric 'required value' from OCR text.

    Currently:
    - Finds all floats/integers like 12, 12.5, -0.02
    - Returns the FIRST match (you can later improve this heuristic)
    """
    if not text:
        return None

    # Matches integers and decimals, optional sign
    pattern = r"[-+]?\d+(?:\.\d+)?"
    matches = re.findall(pattern, text)
    if not matches:
        return None

    # For now, pick the first; later we can pick by context if needed
    return matches[0]


def _estimate_confidence(response: vision.AnnotateImageResponse) -> float:
    """
    Estimate a 0-100 confidence score from Vision's document_text_detection.

    Strategy:
    - Collect all word.confidence values
    - Return average * 100
    - If none present, fall back to 50.0
    """
    try:
        fta = response.full_text_annotation
        if not fta or not fta.pages:
            return 0.0

        scores = []
        for page in fta.pages:
            for block in page.blocks:
                for para in block.paragraphs:
                    for word in para.words:
                        if word.confidence:
                            scores.append(word.confidence)

        if not scores:
            return 50.0

        avg = sum(scores) / len(scores)
        return float(avg * 100.0)
    except Exception:
        return 0.0


def extract_required_value_from_pdf_region(
    *,
    pdf_url: str,
    page_index: int,
    nx: float,
    ny: float,
    nw: float,
    nh: float,
) -> Tuple[Optional[str], float]:
    """
    High-level helper:

    1. Download PDF from pdf_url
    2. Render page_index to image
    3. Crop normalized region
    4. Preprocess for digits
    5. Call Google Cloud Vision
    6. Return (required_value_ocr, confidence_0_100)

    On any error, returns (None, 0.0) and logs the issue.
    """
    try:
        pdf_bytes = _fetch_pdf_bytes(pdf_url)
        page_img = _render_page_to_image(pdf_bytes, page_index)
        crop = _crop_normalized_region(page_img, nx, ny, nw, nh)
        img_bytes = _preprocess_for_digits(crop)

        client = _build_vision_client()
        image = vision.Image(content=img_bytes)
        response = client.document_text_detection(image=image)

        if response.error and response.error.message:
            logger.error(f"[vision_ocr] Vision error: {response.error.message}")
            return None, 0.0

        text = ""
        if response.full_text_annotation and response.full_text_annotation.text:
            text = response.full_text_annotation.text.strip()
        elif response.text_annotations:
            text = response.text_annotations[0].description.strip()

        logger.info(f"[vision_ocr] Raw OCR text: {repr(text)[:200]}")

        # NO FILTERING: return full OCR text (only normalize whitespace)
        cleaned_text = re.sub(r"\s+", " ", text).strip() if text else None
        conf = _estimate_confidence(response)

        return cleaned_text, conf

    except Exception as e:
        logger.exception(f"[vision_ocr] Failed to extract required value: {e}")
        return None, 0.0
