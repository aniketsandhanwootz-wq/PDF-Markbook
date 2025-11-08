# services/api/core/report_excel.py
from __future__ import annotations
import io
import os
from typing import Dict, List, Any, Optional
from datetime import datetime
from tempfile import NamedTemporaryFile

import xlsxwriter  # NEW: we now build .xlsx with XlsxWriter

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes


# Helper: write bytes to a temp file and return its path (so embed_image() can read it)
def _bytes_to_tempfile(data: bytes, suffix: str = ".png") -> str:
    f = NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        f.write(data)
        f.flush()
        return f.name
    finally:
        f.close()


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
    # optional: pass a different logo URL if needed
    logo_url: str = "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
    # kept for API compatibility; ignored in this implementation
    template_path: Optional[str] = None,
) -> bytes:
    """
    Build a new .xlsx from scratch using XlsxWriter and embed_image() so pictures
    are TRUE cell content. No VBA/template needed.
    """

    # ---- Fetch PDF and prepare renderer ----
    _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)

    # ---- Prepare output stream ----
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {'in_memory': True})
    ws = wb.add_worksheet("Report")

    # Keep track of temp files to cleanup after workbook.close()
    _tempfiles: List[str] = []

    try:
        # ---------- Formats ----------
        fmt_title = wb.add_format({'bold': True, 'align': 'center', 'valign': 'vcenter'})
        fmt_header = wb.add_format({
            'bold': True, 'align': 'center', 'valign': 'vcenter',
            'border': 1, 'bg_color': '#a7d4f0'
        })
        fmt_subheader = wb.add_format({
            'align': 'center', 'valign': 'vcenter',
            'border': 1, 'bg_color': '#dff3ea'
        })
        fmt_cell = wb.add_format({'border': 1, 'valign': 'vcenter'})
        fmt_center = wb.add_format({'border': 1, 'align': 'center', 'valign': 'vcenter'})

        # ---------- Layout: column widths ----------
        # A: Label, B: Required Value (image), C: Tol Min, D: Tol Max, E: Observed, F: Status, G: Comment
        ws.set_column('A:A', 12)   # Label
        ws.set_column('B:B', 23)   # Image column (~170 px)
        ws.set_column('C:D', 10)   # Tolerance
        ws.set_column('E:E', 18)   # Observed
        ws.set_column('F:G', 14)   # Status/Comment

        # ---------- Header area (rows 1..6) ----------
        # Row indices in XlsxWriter are 0-based. We'll use human rows in comments.

        # Row 1 (index 0): Logo centered across B..F, as TRUE cell content.
        # Make row tall so the logo fits nicely (~100 px).
        ws.set_row(0, 100)

        # Download logo
        if logo_url:
            try:
                logo_bytes = await _fetch_pdf_bytes(logo_url)
                logo_path = _bytes_to_tempfile(logo_bytes, suffix=".png")
                _tempfiles.append(logo_path)
                # Put the logo in cell C1 for nicer centering visually; adjust if you want B1
                ws.embed_image('C1', logo_path)
            except Exception:
                # non-fatal if logo fetch fails
                pass

        # Row 2 (index 1): ID across B..F
        ws.set_row(1, 20)
        ws.merge_range(1, 1, 1, 5, mark_set_id, fmt_subheader)  # B2..F2

        # Row 3 (index 2): top strip with part number (A3..C3) and user/time (E3..F3)
        ws.set_row(2, 20)
        ws.merge_range(2, 0, 2, 2, part_number or "", fmt_cell)  # A3..C3
        ws.merge_range(2, 4, 2, 5, (user_email or "viewer_user") + " | " +
                       datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"), fmt_cell)

        # Row 4 (index 3): labels like your screenshot (PN-001 etc.). Optional.
        ws.set_row(3, 18)
        ws.write(3, 0, "PN-001", fmt_cell)
        ws.merge_range(3, 1, 3, 6, "", fmt_cell)

        # Row 6 (index 5): table header (Label/Required/Tolerance/Observed/Status/Comment)
        # Add a thin blank row 5 (index 4) to mimic your spacing
        ws.set_row(4, 6)

        ws.set_row(5, 28)
        ws.write(5, 0, "Label", fmt_header)
        ws.write(5, 1, "Required Value", fmt_header)
        ws.merge_range(5, 2, 5, 3, "Tolerance\nMin / Max", fmt_header)
        ws.write(5, 4, "Observed\nValue", fmt_header)
        ws.write(5, 5, "Status", fmt_header)
        ws.write(5, 6, "Comment", fmt_header)

        # ---------- Data rows start at row 8 visually → excel index 7 ----------
        start_row = 7

        # Sort marks deterministically
        marks_sorted = sorted(
            marks, key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", "")))
        )

        # For each mark, render crop and embed as cell content in column B
        for idx, m in enumerate(marks_sorted, start=1):
            r = start_row + (idx - 1)  # current worksheet row index
            ws.set_row(r, 100)  # tall row to show the image

            page_index = int(m["page_index"])
            mark_id = m["mark_id"]
            nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
            label = (m.get("label") or f"Mark {idx}").strip()
            observed = (entries.get(mark_id, "") or "").strip()

            # Write Label (A), Tol Min/Max (C/D blanks for now), Observed (E), Status/Comment blank
            ws.write(r, 0, label, fmt_center)
            ws.write_blank(r, 2, None, fmt_cell)
            ws.write_blank(r, 3, None, fmt_cell)
            ws.write(r, 4, observed, fmt_cell)
            ws.write_blank(r, 5, None, fmt_cell)
            ws.write_blank(r, 6, None, fmt_cell)

            # Render crop as PNG bytes
            try:
                # Build a tiny PdfDocument for crop function
                # (the helper expects a PdfDocument object + page index)
                import pypdfium2 as pdfium
                doc = pdfium.PdfDocument(pdf_bytes)
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

                # TRUE cell content:
                ws.embed_image(r, 1, img_path)  # column B (index 1)
            except Exception:
                # If crop fails, leave B blank but keep borders consistent
                ws.write_blank(r, 1, None, fmt_cell)

        # Draw outer borders over the data area so blank cells also look tabular
        last_row = start_row + len(marks_sorted) - 1
        if last_row >= start_row:
            ws.conditional_format(start_row, 0, last_row, 6,
                                  {'type': 'no_errors', 'format': fmt_cell})

        # Close workbook to finalize bytes
        wb.close()
        out.seek(0)
        return out.read()

    finally:
        # Cleanup any temp files we created for embed_image()
        for p in _tempfiles:
            try:
                os.unlink(p)
            except Exception:
                pass
