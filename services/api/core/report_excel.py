# services/api/core/report_excel.py
from __future__ import annotations
import io
from typing import Dict, List, Any, Optional
from datetime import datetime

from openpyxl import load_workbook, Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes

async def generate_report_excel(
    *,
    pdf_url: str,
    marks: List[Dict[str, Any]],
    entries: Dict[str, str],
    user_email: Optional[str],
    mark_set_id: str,
    padding_pct: float = 0.25,
    render_zoom: float = 2.0,
    template_path: str = "services/api/templates/report_template.xlsx",
) -> bytes:
    """
    Generate an Excel (.xlsx) report using openpyxl.
    - If 'template_path' exists, uses it.
    - Otherwise builds a simple sheet with headers.
    - Each row corresponds to a mark, including a cropped image and the observed value.
    """

    # ---------- Load PDF ----------
    pdfium = _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)
    doc = pdfium.PdfDocument(pdf_bytes)

    # ---------- Load template or fallback ----------
    wb: Workbook
    ws = None
    try:
        wb = load_workbook(template_path)
        ws = wb.active
    except Exception:
        # Fallback: create a workbook with a styled header row
        wb = Workbook()
        ws = wb.active
        ws.title = "Inspection Report"

        # Title
        ws["B2"] = "Wootz.Work"
        ws["B2"].font = Font(size=16, bold=True)
        # Meta
        ws["B4"] = "Mark Set ID:"
        ws["C4"] = mark_set_id
        ws["E4"] = "Created By:"
        ws["F4"] = user_email or "viewer_user"

        ws["B5"] = "Created At:"
        ws["C5"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
        ws["E5"] = "Report:"
        ws["F5"] = f"inspection_{mark_set_id}.xlsx"

        # Table headers (row 7)
        headers = [
            "Label",            # B
            "Required Value",   # C  (image)
            "Tolerance Min",    # D
            "Tolerance Max",    # E
            "Observed Value",   # F
            "Status",           # G
            "Comment",          # H
        ]
        start_row = 7
        for col_idx, name in enumerate(headers, start=2):  # starting column B == 2
            cell = ws.cell(row=start_row, column=col_idx, value=name)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill(start_color="4F81BD", end_color="4F81BD", fill_type="solid")
            cell.alignment = Alignment(horizontal="center", vertical="center")

        # Borders + column widths
        for col in range(2, 9):  # B..H
            ws.column_dimensions[get_column_letter(col)].width = 20

    # ---------- Fill header if template expected specific cells ----------
    # (These are harmless if the template doesn't have them.)
    try:
        ws["B4"].value = mark_set_id
        ws["E4"].value = user_email or "viewer_user"
        ws["C5"].value = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    except Exception:
        pass

    # ---------- Sort marks and write rows ----------
    marks_sorted = sorted(
        marks,
        key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", "")))
    )

    start_row = 8  # first data row (below header at row 7)
    current_row = start_row

    thin = Side(border_style="thin", color="999999")

    for idx, m in enumerate(marks_sorted, start=1):
        page_index = int(m["page_index"])
        mark_id = m["mark_id"]
        nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
        label = (m.get("label") or f"Mark {idx}").strip()
        observed = (entries.get(mark_id, "") or "").strip()

        # write label & observed
        ws[f"B{current_row}"].value = label
        ws[f"F{current_row}"].value = observed
        ws[f"G{current_row}"].value = ("OK" if observed else "—")

        # draw borders in B..H
        for col in range(2, 9):  # B..H
            c = ws.cell(row=current_row, column=col)
            c.border = Border(top=thin, bottom=thin, left=thin, right=thin)

        # crop image to column C
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
            bio.seek(0)

            xl_img = XLImage(bio)
            xl_img.width = 180  # adjust for your column width
            xl_img.height = 120
            ws.add_image(xl_img, f"C{current_row}")
        except Exception:
            # If crop fails, leave the cell as-is
            pass

        current_row += 1

    # footer
    footer_row = current_row + 1
    ws[f"B{footer_row}"] = f"Generated at {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')} via PDF Markbook"
    ws[f"B{footer_row}"].font = Font(italic=True, size=10)

    # save to bytes
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out.read()
