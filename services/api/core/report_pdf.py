# services/api/core/report_pdf.py
from __future__ import annotations
import io
from typing import Dict, List, Optional, Tuple, Any

import httpx
from PIL import Image, ImageDraw
from fpdf import FPDF

# --- lazy import helper ------------------------------------------------------
def _require_pdfium():
    """
    Import pypdfium2 lazily and raise a clear error if unavailable.
    """
    try:
        import pypdfium2 as pdfium     # <-- FIX: correct module name
        return pdfium
    except Exception as e:
        raise RuntimeError(
            "pypdfium2 is not available in this environment. "
            "Run on Render (Linux/Python 3.12) or install pypdfium2 there. "
            "Locally you can still run the app; this endpoint will just not work."
        ) from e

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
    """
    pdfium = _require_pdfium()  # <-- only import when actually used

    # 1) Fetch source PDF
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    # 2) Open with pdfium
    doc = pdfium.PdfDocument(pdf_bytes)

    # 3) Sort marks
    marks_sorted = sorted(marks, key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))))

    # 4) Build report
    report = _ReportBuilder(title=title, author=author)

    for m in marks_sorted:
        page_index = int(m["page_index"])
        nx = float(m["nx"]); ny = float(m["ny"])
        nw = float(m["nw"]); nh = float(m["nh"])
        mark_name = str(m.get("name", f"Mark@{page_index}"))
        mark_id = m.get("mark_id")

        crop_img = _render_crop(
            doc=doc,
            page_index=page_index,
            rect_norm=(nx, ny, nw, nh),
            render_zoom=render_zoom,
            padding_pct=padding_pct,
        )

        value = entries.get(mark_id, "") if mark_id else ""
        report.add_block(image=crop_img, caption_name=mark_name, caption_value=value)

    return report.build()


# ---------- Internals --------------------------------------------------------
async def _fetch_pdf_bytes(url: str, timeout: float = 30.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


def _render_crop(
    *,
    doc: Any,  # pdfium.PdfDocument
    page_index: int,
    rect_norm: Tuple[float, float, float, float],
    render_zoom: float,
    padding_pct: float,
) -> Image.Image:
    """Render page to PIL, crop normalized rect with padding, draw magenta box."""
    page = doc[page_index]
    pil_page: Image.Image = page.render(scale=render_zoom).to_pil()

    W, H = pil_page.size
    nx, ny, nw, nh = rect_norm

    rx = round(nx * W); ry = round(ny * H)
    rw = round(nw * W); rh = round(nh * H)

    pad = round(padding_pct * max(rw, rh))

    x0 = max(0, rx - pad)
    y0 = max(0, ry - pad)
    x1 = min(W, rx + rw + pad)
    y1 = min(H, ry + rh + pad)

    crop = pil_page.crop((x0, y0, x1, y1)).convert("RGB")
    draw = ImageDraw.Draw(crop)

    dx = rx - x0
    dy = ry - y0
    thick = max(2, int(round(min(crop.size) * 0.004)))
    for t in range(thick):
        draw.rectangle([dx + t, dy + t, dx + rw - 1 - t, dy + rh - 1 - t], outline=(255, 0, 180))

    return crop


class _ReportBuilder:
    """Simple A4 vertical-flow report of caption + image blocks."""
    def __init__(self, *, title: Optional[str], author: Optional[str]):
        self._pdf = FPDF(orientation="P", unit="mm", format="A4")
        self._pdf.set_auto_page_break(auto=True, margin=15)
        self._pdf.add_page()
        self._pdf.set_author(author or "")
        self._pdf.set_title(title or "Report")

        if title:
            self._pdf.set_font("Helvetica", "B", 16)
            self._pdf.cell(0, 10, txt=title, ln=1)
        self._pdf.ln(2)

        self.page_w = self._pdf.w
        self.page_h = self._pdf.h
        self.margin_l = self._pdf.l_margin
        self.margin_r = self._pdf.r_margin
        self.cursor_y = self._pdf.get_y()
        self.content_w = self.page_w - self.margin_l - self.margin_r

    def _ensure_space(self, block_h_mm: float):
        bottom_margin = self._pdf.b_margin
        if self.cursor_y + block_h_mm > (self.page_h - bottom_margin):
            self._pdf.add_page()
            self.cursor_y = self._pdf.get_y()

    def add_block(self, *, image: Image.Image, caption_name: str, caption_value: str):
        self._pdf.set_font("Helvetica", "B", 11)
        self._pdf.multi_cell(0, 6, caption_name)
        self.cursor_y = self._pdf.get_y()

        self._pdf.set_font("Helvetica", "", 10)
        self._pdf.multi_cell(0, 6, f"Value: {caption_value or '—'}")
        self._pdf.ln(1)
        self.cursor_y = self._pdf.get_y()

        img_w_px, img_h_px = image.size
        if img_w_px == 0 or img_h_px == 0:
            return

        target_w_mm = self.content_w
        aspect = img_h_px / img_w_px
        target_h_mm = target_w_mm * aspect

        space_left_mm = (self.page_h - self._pdf.b_margin) - self.cursor_y
        if target_h_mm > space_left_mm:
            target_h_mm = space_left_mm - 5
            target_w_mm = max(10, target_h_mm / aspect)
        else:
            target_w_mm = target_w_mm = self.content_w

        self._ensure_space(target_h_mm + 2)

        bio = io.BytesIO()
        image.save(bio, format="PNG")
        bio.seek(0)

        self._pdf.image(bio, x=self.margin_l, y=self.cursor_y, w=target_w_mm)
        self.cursor_y = self._pdf.get_y() + target_h_mm
        self._pdf.ln(3)

    def build(self) -> bytes:
        data = self._pdf.output(dest="S")
        return data.encode("latin-1") if isinstance(data, str) else bytes(data)
