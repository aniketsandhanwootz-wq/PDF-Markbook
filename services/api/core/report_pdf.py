# services/api/core/report_pdf.py

from __future__ import annotations
import io
import math
from typing import Dict, List, Optional, Tuple, Any

import httpx
import pdfium  # python-pdfium2
from PIL import Image, ImageDraw
from fpdf import FPDF


# ---------- Public API -------------------------------------------------------

async def generate_report_pdf(
    *,
    pdf_url: str,
    marks: List[Dict[str, Any]],
    entries: Dict[str, str],
    padding_pct: float = 0.25,
    render_zoom: float = 2.0,
    title: Optional[str] = "Markbook Submission",
    author: Optional[str] = "PDF Viewer",
) -> bytes:
    """
    Render crops for marks using python-pdfium2, draw a magenta box,
    and compile a multi-page PDF report (fpdf2). Returns PDF bytes.

    Args:
        pdf_url: Source PDF URL (original, not the proxy).
        marks:   List of dicts with keys: page_index, name, nx, ny, nw, nh, mark_id (optional), order_index.
        entries: Dict[mark_id -> value] or empty values for demo marks.
        padding_pct: Extra padding around each crop (fraction of the larger side of the rect).
        render_zoom: Scale factor for rasterizing page (2.0 ≈ 144 DPI; 2.5 ≈ 180 DPI).
        title, author: Metadata + header text.

    Returns:
        PDF bytes (ready to stream / download).
    """
    # 1) Fetch source PDF
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    # 2) Open with pdfium
    doc = pdfium.PdfDocument(pdf_bytes)

    # 3) Sort marks (stable by order_index then name)
    marks_sorted = sorted(
        marks,
        key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", "")))
    )

    # 4) Build report pages
    report = _ReportBuilder(title=title, author=author)

    for m in marks_sorted:
        page_index = int(m["page_index"])
        nx = float(m["nx"]); ny = float(m["ny"])
        nw = float(m["nw"]); nh = float(m["nh"])
        mark_name = str(m.get("name", f"Mark@{page_index}"))
        mark_id = m.get("mark_id", None)

        # 4a) Render the cropped region (PNG bytes) with a visual box
        crop_img = _render_crop(
            doc=doc,
            page_index=page_index,
            rect_norm=(nx, ny, nw, nh),
            render_zoom=render_zoom,
            padding_pct=padding_pct
        )

        # 4b) Compose a block in the PDF
        value = ""
        if mark_id:
            value = entries.get(mark_id, "")
        report.add_block(
            image=crop_img,
            caption_name=mark_name,
            caption_value=value
        )

    # 5) Export to bytes
    return report.build()


# ---------- Internals --------------------------------------------------------

async def _fetch_pdf_bytes(url: str, timeout: float = 30.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


def _render_crop(
    *,
    doc: pdfium.PdfDocument,
    page_index: int,
    rect_norm: Tuple[float, float, float, float],
    render_zoom: float,
    padding_pct: float
) -> Image.Image:
    """
    Render a page with pdfium to a PIL image at `render_zoom`,
    crop the normalized rectangle with padding, draw a magenta box, and return the PIL image.
    """
    page = doc[page_index]

    # Render entire page at desired zoom (scale factor, not DPI).
    # Rough DPI = 72 * render_zoom. (render_zoom=2.5 ~ 180 DPI)
    pil_page: Image.Image = page.render(scale=render_zoom).to_pil()

    W, H = pil_page.size  # pixels
    nx, ny, nw, nh = rect_norm

    # Rect in pixels
    rx = int(round(nx * W))
    ry = int(round(ny * H))
    rw = int(round(nw * W))
    rh = int(round(nh * H))

    # Padding in pixels (relative to larger dimension of rect)
    pad = int(round(padding_pct * max(rw, rh)))

    # Crop box with padding, clamped
    x0 = max(0, rx - pad)
    y0 = max(0, ry - pad)
    x1 = min(W, rx + rw + pad)
    y1 = min(H, ry + rh + pad)

    crop = pil_page.crop((x0, y0, x1, y1)).convert("RGB")

    # Draw a visual rectangle where the original mark sits inside the crop
    draw = ImageDraw.Draw(crop)
    # Offset of the mark inside the crop:
    dx = rx - x0
    dy = ry - y0
    # Outline thickness
    thick = max(2, int(round(min(crop.size) * 0.004)))  # scale with image size (≈2–4 px)
    for t in range(thick):
        draw.rectangle(
            [dx + t, dy + t, dx + rw - 1 - t, dy + rh - 1 - t],
            outline=(255, 0, 180)
        )

    return crop


class _ReportBuilder:
    """
    Simple vertical-flow report:
      - A4 portrait, margins (L=R=15mm, T=B=15mm)
      - For each mark: Caption (bold name + value) then the crop image (fit width).
      - Flows onto next page when needed.
    """

    def __init__(self, *, title: Optional[str], author: Optional[str]):
        self._pdf = FPDF(orientation="P", unit="mm", format="A4")
        self._pdf.set_auto_page_break(auto=True, margin=15)
        self._pdf.add_page()
        self._pdf.set_author(author or "")
        self._pdf.set_title(title or "Report")

        # Header
        if title:
            self._pdf.set_font("Helvetica", "B", 16)
            self._pdf.cell(0, 10, txt=title, ln=1)
        self._pdf.ln(2)

        self.page_w = self._pdf.w  # total width (mm)
        self.page_h = self._pdf.h
        self.margin_l = self._pdf.l_margin
        self.margin_r = self._pdf.r_margin
        self.cursor_y = self._pdf.get_y()

        # Content width (mm)
        self.content_w = self.page_w - self.margin_l - self.margin_r

    def _ensure_space(self, block_h_mm: float):
        """Add page if the next block won't fit."""
        bottom_margin = self._pdf.b_margin
        if self.cursor_y + block_h_mm > (self.page_h - bottom_margin):
            self._pdf.add_page()
            self.cursor_y = self._pdf.get_y()

    def add_block(self, *, image: Image.Image, caption_name: str, caption_value: str):
        # 1) Caption
        self._pdf.set_font("Helvetica", "B", 11)
        name_text = f"{caption_name}"
        self._pdf.multi_cell(0, 6, name_text)
        self.cursor_y = self._pdf.get_y()

        self._pdf.set_font("Helvetica", "", 10)
        val_text = caption_value if caption_value else "—"
        self._pdf.multi_cell(0, 6, f"Value: {val_text}")
        self._pdf.ln(1)
        self.cursor_y = self._pdf.get_y()

        # 2) Image (fit to content width, keep aspect ratio)
        img_w_px, img_h_px = image.size
        if img_w_px == 0 or img_h_px == 0:
            return  # skip invalid

        # target width in mm
        target_w_mm = self.content_w
        # convert needed height (mm) preserving aspect
        # fpdf uses 96 DPI by default when calculating images; to be safe, use ratio.
        aspect = img_h_px / img_w_px
        target_h_mm = target_w_mm * aspect

        # Make sure it fits; if too tall, reduce width to fit remaining page height
        space_left_mm = (self.page_h - self._pdf.b_margin) - self.cursor_y
        if target_h_mm > space_left_mm:
            # shrink to fit
            target_h_mm = space_left_mm - 5
            target_w_mm = max(10, target_h_mm / aspect)

        # If still not enough space, new page
        self._ensure_space(target_h_mm + 2)

        # Save PIL image to in-memory PNG and embed
        bio = io.BytesIO()
        image.save(bio, format="PNG")
        bio.seek(0)

        x_mm = self.margin_l
        y_mm = self.cursor_y
        self._pdf.image(bio, x=x_mm, y=y_mm, w=target_w_mm)
        self.cursor_y = y_mm + target_h_mm

        # tiny gap before next block
        self._pdf.ln(3)
        self.cursor_y = self._pdf.get_y()

    def build(self) -> bytes:
        # fpdf2 returns str when dest='S' → encode to latin-1 (PDF is binary-safe there)
        data = self._pdf.output(dest="S")
        if isinstance(data, str):
            return data.encode("latin-1")
        return bytes(data)
