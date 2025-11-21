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
    """
    _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    # Use XLSX template (no macros)
    template_path = os.path.join(
        os.path.dirname(__file__),
        "../templates/report_template.xlsx",
    )
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    # No keep_vba – we are on .xlsx
    wb = load_workbook(template_path)
    ws = wb.active

    _tempfiles: List[str] = []

    try:
        # ========= HEADER (coordinates assume your new template layout) =========
        # Row 4: Part Number | ID
        # Row 5: MarkSet Name | Created By
        # Row 6: Created At
        # (All of these can be merged ranges; _write_merged handles that.)

        # Part Number value (next to "Part Number:")
        _write_merged(ws, "B4", part_number or "")

        # ID: external_id preferred, fallback to mark_set_id
        _write_merged(ws, "F4", (external_id or mark_set_id or ""))

        # MarkSet Name
        _write_merged(ws, "B5", mark_set_label or "")

        # Created By
        _write_merged(ws, "F5", user_email or "viewer_user")

        # Created At
        _write_merged(
            ws,
            "F6",
            datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        )

        # ========= LOGO (top, same as before) =========
        if logo_url:
            try:
                logo_bytes = await _fetch_pdf_bytes(logo_url)
                logo_path = _bytes_to_tempfile(logo_bytes, suffix=".png")
                _tempfiles.append(logo_path)
                img = OpenpyxlImage(logo_path)
                img.width = 150
                img.height = 60
                # Anchor near the center top; adjust if needed
                ws.add_image(img, "C1")
            except Exception as e:
                print(f"Logo failed: {e}")

        # ========= ROWS (table) =========
        # Table header is in row 7 in your screenshot:
        # 7: Label | Required Value | Tolerance (Min/Max) | Observed | Status | Comment
        # Data starts at row 8.
        start_row = 8

        # Sort marks by order_index then name
        marks_sorted = sorted(
            marks,
            key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))),
        )

        import pypdfium2 as pdfium  # type: ignore
        doc = pdfium.PdfDocument(pdf_bytes)

        for idx, m in enumerate(marks_sorted, start=1):
            r = start_row + (idx - 1)

            page_index = int(m["page_index"])
            mark_id = m.get("mark_id", "")
            nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
            label = (m.get("label") or f"Mark {idx}").strip()
            observed = (entries.get(mark_id, "") or "").strip()

            # --- Text cells ---
            # A: Label
            ws.cell(row=r, column=1).value = label

            # C/D: Tolerance Min/Max → left empty for user to fill later

            # E: Observed Value
            ws.cell(row=r, column=5).value = observed

            # F/G: Status, Comment → keep empty

            # Row height ~100 px to match thumbnail
            ws.row_dimensions[r].height = 75

            # --- Image thumbnail into column B ("Required Value") ---
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

                # Fit into B cell (approx 175x100 px); tweak if you adjust column width
                cell_w_px = 175
                cell_h_px = 100
                scale = min(cell_w_px / img_w_px, cell_h_px / img_h_px) * 0.9
                img.width = int(img_w_px * scale)
                img.height = int(img_h_px * scale)

                ws.add_image(img, f"B{r}")
            except Exception as e:
                print(f"Image failed for mark {idx}: {e}")

        # ========= SAVE =========
        out = io.BytesIO()
        wb.save(out)
        out.seek(0)
        return out.read()

    finally:
        # Cleanup temp files
        for p in _tempfiles:
            try:
                os.unlink(p)
            except Exception:
                pass
