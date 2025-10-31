# services/api/core/report_pdf.py
from __future__ import annotations
import io
from typing import Dict, List, Optional
import httpx
import fitz  # PyMuPDF

# A4 portrait (points)
A4_W, A4_H = 595.0, 842.0

async def _fetch_pdf_bytes(url: str, timeout: float = 30.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content

def _expand(rect: fitz.Rect, pad_x: float, pad_y: float, clip: fitz.Rect) -> fitz.Rect:
    out = fitz.Rect(rect.x0 - pad_x, rect.y0 - pad_y, rect.x1 + pad_x, rect.y1 + pad_y)
    out.intersect(clip)  # clamp to page
    return out

def _pink() -> fitz.utils.Shape:
    # placeholder; we’ll just return color tuple where needed
    return (1.0, 0.0, 0.6)  # RGB 0..1

async def generate_report_pdf(
    *,
    pdf_url: str,
    marks: List[Dict],
    entries: Dict[str, str],
    padding_pct: float = 0.25,
    render_zoom: float = 2.0,
    title: Optional[str] = None,
    author: Optional[str] = None,
) -> bytes:
    """
    Build a report PDF:
    - For each mark: render a cropped image with a pink box exactly on the marked rect,
      then place it on an A4 page with the mark name + submitted value.
    - `marks` must contain normalized coords: nx, ny, nw, nh and page_index (0-based).
    """
    # Load source PDF (bytes -> in-memory doc)
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)
    src = fitz.open(stream=pdf_bytes, filetype="pdf")

    # Output doc (A4 portrait)
    out = fitz.open()
    if title:
        out.set_metadata({"title": title})
    if author:
        meta = out.metadata or {}
        meta["author"] = author
        out.set_metadata(meta)

    pink = _pink()
    font_size_name = 12
    font_size_value = 13

    for m in sorted(marks, key=lambda x: x.get("order_index", 0)):
        p_idx = int(m["page_index"])
        page = src.load_page(p_idx)
        w1, h1 = page.rect.width, page.rect.height  # points at zoom=1

        # Normalized -> absolute (points at zoom=1)
        nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
        rect_abs = fitz.Rect(nx * w1, ny * h1, (nx + nw) * w1, (ny + nh) * h1)

        # Padding
        pad_x, pad_y = rect_abs.width * padding_pct, rect_abs.height * padding_pct
        crop_rect = _expand(rect_abs, pad_x, pad_y, page.rect)

        # Draw pink box on the *source* page (not saved anywhere) before rendering
        shape = page.new_shape()
        shape.draw_rect(rect_abs)
        shape.finish(width=max(2, 1.5 * render_zoom), color=pink)  # stroke only
        shape.commit(overlay=True)

        # Render clipped region to pixmap
        mat = fitz.Matrix(render_zoom, render_zoom)
        pm = page.get_pixmap(matrix=mat, clip=crop_rect, alpha=False)

        # New report page
        rp = out.new_page(width=A4_W, height=A4_H)

        # Place the raster on report page, fit within margins
        margin = 36  # 0.5 inch
        box_w = A4_W - margin * 2
        box_h = A4_H - margin * 2 - 90  # reserve space for headers
        # Compute image box preserving aspect ratio
        img_ratio = pm.width / pm.height
        avail_ratio = box_w / box_h
        if img_ratio >= avail_ratio:
            draw_w = box_w
            draw_h = box_w / img_ratio
        else:
            draw_h = box_h
            draw_w = box_h * img_ratio

        draw_x = margin + (box_w - draw_w) / 2
        draw_y = margin + 70  # leave header space above

        # Insert raster
        rp.insert_image(
            fitz.Rect(draw_x, draw_y, draw_x + draw_w, draw_y + draw_h),
            stream=pm.tobytes("png"),
            keep_proportion=True,
        )

        # Header texts (mark name + value)
        mark_name = str(m.get("name", "Mark"))
        mark_id = str(m.get("mark_id", ""))
        value = entries.get(mark_id, "")

        # Title line
        rp.insert_text(
            fitz.Point(margin, margin + 18),
            f"{mark_name}",
            fontsize=font_size_name,
            fontname="helv",
            color=(0, 0, 0),
        )
        # Value (slightly larger)
        rp.insert_text(
            fitz.Point(margin, margin + 40),
            f"Input: {value}",
            fontsize=font_size_value,
            fontname="helv",
            color=(0, 0, 0),
        )

    # Serialize
    out_bytes = out.tobytes(deflate=True)
    out.close()
    src.close()
    return out_bytes
