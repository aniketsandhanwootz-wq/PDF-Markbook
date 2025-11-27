# services/api/core/report_excel.py
from __future__ import annotations
import io
import os
from typing import Dict, List, Any, Optional
from datetime import datetime
from tempfile import NamedTemporaryFile

from openpyxl import load_workbook
from openpyxl.drawing.image import Image as OpenpyxlImage
from openpyxl.cell.cell import MergedCell
from openpyxl.worksheet.worksheet import Worksheet

from core.report_pdf import _require_pdfium, _fetch_pdf_bytes

from collections import defaultdict
import gc
from PIL import Image  # for type hints / safety
from settings import get_settings


def _bytes_to_tempfile(data: bytes, suffix: str = ".png") -> str:
    f = NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        f.write(data)
        f.flush()
        return f.name
    finally:
        f.close()


def _write_merged(ws: Worksheet, coord: str, value) -> None:
    """
    Write `value` to `coord`. If `coord` lies inside a merged range,
    write to that range's top-left cell (required by openpyxl).
    """
    cell = ws[coord]
    if isinstance(cell, MergedCell):
        # Find the merged range that contains this coordinate
        for rng in ws.merged_cells.ranges:
            if coord in rng:
                top_left = ws.cell(row=rng.min_row, column=rng.min_col)
                top_left.value = value
                return
        # If we somehow didn't find the range, fail loudly (shouldn't happen)
        raise RuntimeError(f"Cell {coord} is merged but its range wasn't found.")
    else:
        cell.value = value

def _crop_from_page_image(
    *,
    pil_page,
    rect_norm,
    padding_pct: float,
):
    """
    Crop a normalized rectangle (nx, ny, nw, nh) from a pre-rendered
    PIL page image, with padding. This is essentially the same math
    as _render_crop but WITHOUT re-rendering or drawing boxes.
    """
    from PIL import Image as PilImage  # local import to avoid global dependency

    W, H = pil_page.size
    nx, ny, nw, nh = rect_norm

    rx = round(nx * W)
    ry = round(ny * H)
    rw = round(nw * W)
    rh = round(nh * H)

    pad = round(padding_pct * max(rw, rh))

    x0 = max(0, rx - pad)
    y0 = max(0, ry - pad)
    x1 = min(W, rx + rw + pad)
    y1 = min(H, ry + rh + pad)

    crop = pil_page.crop((x0, y0, x1, y1))
    return crop.convert("RGB")

async def generate_report_excel(
    *,
    pdf_url: str,
    marks: List[Dict[str, Any]],
    entries: Dict[str, str],
    user_email: Optional[str],
    mark_set_id: str,
    mark_set_label: str = "",
    part_number: str = "",
    external_id: str = "",
    padding_pct: float = 0.25,
    render_zoom: float = 2.2,
    logo_url: str = "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
) -> bytes:
    """
    Build Excel from template with:
      - Header: Part Number, ID (external_id), MarkSet Name, Created By/At
      - One row per mark:
          A: Label
          B: Thumbnail image of mark region
          C/D: Tolerance Min/Max (left empty)
          E: Observed Value (user input)
          F/G: Status, Comment (left empty)

    Optimised for:
      - Per-page PDF rendering (render each page once, crop many marks)
      - Using temp files for images so openpyxl never sees raw PIL Images
      - Basic mark cap from settings.max_marks_per_report (default 300)
    """
    # ---------- PDF + template ----------
    _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    template_path = os.path.join(
        os.path.dirname(__file__),
        "../templates/report_template.xlsx",
    )
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    wb = load_workbook(template_path)
    ws = wb.active

    _tempfiles: List[str] = []

    # ---------- Settings: cap marks ----------
    try:
        settings = get_settings()
        max_marks = getattr(settings, "max_marks_per_report", 300)
    except Exception:
        max_marks = 300

    # Sort and apply cap here (extra safety – caller should already filter)
    marks_sorted = sorted(
        marks,
        key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))),
    )
    if len(marks_sorted) > max_marks:
        marks_sorted = marks_sorted[:max_marks]

    # ---------- Group marks by page ----------
    marks_by_page: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for m in marks_sorted:
        try:
            page_idx = int(m.get("page_index", 0))
        except Exception:
            page_idx = 0
        marks_by_page[page_idx].append(m)

    import pypdfium2 as pdfium  # type: ignore
    doc = pdfium.PdfDocument(pdf_bytes)

    def crop_from_page(page_img: Image.Image, rect_norm, padding: float) -> Image.Image:
        """
        Local helper: crop from a pre-rendered page image using the same
        normalized-rect + padding logic as _render_crop, but WITHOUT re-rendering.
        """
        W, H = page_img.size
        nx, ny, nw, nh = rect_norm

        rx = round(nx * W)
        ry = round(ny * H)
        rw = round(nw * W)
        rh = round(nh * H)

        pad_px = round(padding * max(rw, rh))
        x0 = max(0, rx - pad_px)
        y0 = max(0, ry - pad_px)
        x1 = min(W, rx + rw + pad_px)
        y1 = min(H, ry + rh + pad_px)

        return page_img.crop((x0, y0, x1, y1)).convert("RGB")

    try:
        # =====================================================
        # HEADER
        # =====================================================
        _write_merged(ws, "B4", part_number or "")
        _write_merged(ws, "F4", (external_id or mark_set_id or ""))
        _write_merged(ws, "B5", mark_set_label or "")
        _write_merged(ws, "F5", user_email or "viewer_user")
        _write_merged(
            ws,
            "F6",
            datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        )

        # ---------- LOGO ----------
        if logo_url:
            try:
                logo_bytes = await _fetch_pdf_bytes(logo_url)
                logo_path = _bytes_to_tempfile(logo_bytes, suffix=".png")
                _tempfiles.append(logo_path)

                logo_img = OpenpyxlImage(logo_path)  # pass PATH, not PIL
                logo_img.width = 150
                logo_img.height = 60
                ws.add_image(logo_img, "C1")
                # no need to keep logo_img reference
                del logo_img
            except Exception as e:
                print(f"Logo failed: {e}")

        # =====================================================
        # TABLE ROWS
        # =====================================================
        start_row = 8
        current_row = start_row

        # Process pages in ascending order
        for page_index in sorted(marks_by_page.keys()):
            marks_on_page = marks_by_page[page_index]
            if not marks_on_page:
                continue

            # Render this page ONCE at the requested zoom
            try:
                page = doc[page_index]
                page_img = page.render(scale=render_zoom).to_pil()
            except Exception as e:
                print(f"Failed to render page {page_index}: {e}")
                page_img = None

            # Process all marks on this page (sorted)
            marks_on_page_sorted = sorted(
                marks_on_page,
                key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))),
            )

            for m in marks_on_page_sorted:
                r = current_row
                current_row += 1

                mark_id = m.get("mark_id", "")
                nx = float(m["nx"])
                ny = float(m["ny"])
                nw = float(m["nw"])
                nh = float(m["nh"])
                label = (m.get("label") or f"Mark {r - start_row + 1}").strip()
                observed = (entries.get(mark_id, "") or "").strip()

                # Text cells
                ws.cell(row=r, column=1).value = label   # A: Label
                ws.cell(row=r, column=5).value = observed  # E: Observed
                ws.row_dimensions[r].height = 75         # row height for thumbnail

                # Image thumbnail into column B
                if page_img is None:
                    continue  # can't render thumbnail without page

                try:
                    crop_img = crop_from_page(
                        page_img,
                        (nx, ny, nw, nh),
                        padding_pct,
                    )

                    # Write to temp file so openpyxl sees a filename (has fp)
                    bio = io.BytesIO()
                    crop_img.save(bio, format="PNG")
                    crop_png = bio.getvalue()
                    thumb_path = _bytes_to_tempfile(crop_png, suffix=".png")
                    _tempfiles.append(thumb_path)

                    thumb_img = OpenpyxlImage(thumb_path)  # IMPORTANT: pass path
                    img_w_px, img_h_px = crop_img.size

                    # Fit within approx 175x100 px box
                    cell_w_px = 175
                    cell_h_px = 100
                    scale = min(cell_w_px / img_w_px, cell_h_px / img_h_px) * 0.9
                    thumb_img.width = int(img_w_px * scale)
                    thumb_img.height = int(img_h_px * scale)

                    ws.add_image(thumb_img, f"B{r}")

                    # Drop references ASAP for GC
                    del crop_img
                    del thumb_img
                    del bio

                except Exception as e:
                    print(f"Image failed for mark on page {page_index}, row {r}: {e}")
                    continue

            # Drop big page image
            if page_img is not None:
                del page_img
                gc.collect()

        # =====================================================
        # SAVE TO BYTES
        # =====================================================
        out = io.BytesIO()
        wb.save(out)
        out.seek(0)

        # Encourage cleanup of any lingering image state
        gc.collect()
        return out.read()

    finally:
        # Cleanup temp files
        for p in _tempfiles:
            try:
                os.unlink(p)
            except Exception:
                pass
