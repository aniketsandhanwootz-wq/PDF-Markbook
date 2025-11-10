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

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes


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


async def generate_report_excel(
    *,
    pdf_url: str,
    marks: List[Dict[str, Any]],
    entries: Dict[str, str],
    user_email: Optional[str],
    mark_set_id: str,
    mark_set_label: str = "",
    part_number: str = "",
    padding_pct: float = 0.25,
    render_zoom: float = 2.2,
    logo_url: str = "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
) -> bytes:
    """Build Excel from template with floating images."""
    _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    template_path = os.path.join(os.path.dirname(__file__), "../templates/report_template.xlsm")
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    wb = load_workbook(template_path, keep_vba=True)
    ws = wb.active

    _tempfiles: List[str] = []

    try:
        # ==== Header (safe for merged cells) ====
        _write_merged(ws, "B2", mark_set_id)
        _write_merged(ws, "A4", part_number or "")
        _write_merged(
            ws,
            "E4",
            f"{user_email or 'viewer_user'} | {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
        )

        # ==== Logo ====
        if logo_url:
            try:
                logo_bytes = await _fetch_pdf_bytes(logo_url)
                logo_path = _bytes_to_tempfile(logo_bytes, suffix=".png")
                _tempfiles.append(logo_path)
                img = OpenpyxlImage(logo_path)
                img.width = 150
                img.height = 60
                ws.add_image(img, "C1")
            except Exception as e:
                print(f"Logo failed: {e}")

        # ==== Rows ====
        start_row = 8
        marks_sorted = sorted(
            marks,
            key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))),
        )

        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdf_bytes)

        for idx, m in enumerate(marks_sorted, start=1):
            r = start_row + (idx - 1)

            page_index = int(m["page_index"])
            mark_id = m.get("mark_id", "")
            nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
            label = (m.get("label") or f"Mark {idx}").strip()
            observed = (entries.get(mark_id, "") or "").strip()

            # Text cells
            ws.cell(row=r, column=1).value = label   # Column A
            ws.cell(row=r, column=5).value = observed  # Column E

            # Row height (~100 px)
            ws.row_dimensions[r].height = 75

            # Image thumbnail into column B
            try:
                crop_img = _render_crop(
                    doc=doc,
                    page_index=page_index,
                    rect_norm=(nx, ny, nw, nh),
                    render_zoom=render_zoom,
                    padding_pct=padding_pct,
                )

                bio = io.BytesIO()
                crop_img.save(bio, format="PNG")
                crop_png = bio.getvalue()

                img_path = _bytes_to_tempfile(crop_png, suffix=".png")
                _tempfiles.append(img_path)

                img = OpenpyxlImage(img_path)
                img_w_px, img_h_px = crop_img.size

                # Fit into B cell (approx 175x100 px)
                cell_w_px = 175
                cell_h_px = 100
                scale = min(cell_w_px / img_w_px, cell_h_px / img_h_px) * 0.9
                img.width = int(img_w_px * scale)
                img.height = int(img_h_px * scale)

                ws.add_image(img, f"B{r}")
            except Exception as e:
                print(f"Image failed for mark {idx}: {e}")

        # ==== Save ====
        out = io.BytesIO()
        wb.save(out)
        out.seek(0)
        return out.read()

    finally:
        # Cleanup temp files
        for p in _tempfiles:
            try:
                os.unlink(p)
            except:
                pass
