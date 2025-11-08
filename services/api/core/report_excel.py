# services/api/core/report_excel.py
from __future__ import annotations

import io
from pathlib import Path
from typing import Dict, List, Any, Optional
from datetime import datetime

from openpyxl import load_workbook, Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.cell.cell import MergedCell  # <-- ADD

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes

# Resolve template relative to this file:
_DEFAULT_TEMPLATE = (
    Path(__file__).resolve().parent.parent / "templates" / "report_template.xlsm"
)

def _set_value_safe(ws, coord: str, value) -> None:
    """
    Set value into a cell even if it's inside a merged range.
    If coord refers to a MergedCell, write to the merged range's top-left cell.
    """
    cell = ws[coord]
    if isinstance(cell, MergedCell):
        for mr in ws.merged_cells.ranges:
            if cell.coordinate in mr:  # coord lies inside this merged range
                tl = ws.cell(row=mr.min_row, column=mr.min_col)
                tl.value = value
                return
        # Fallback (shouldn't happen): just skip if not found
        return
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
    render_zoom: float = 2.0,
    template_path: Optional[str] = None,
) -> bytes:
    # ---------- PDF ----------
    pdfium = _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)
    doc = pdfium.PdfDocument(pdf_bytes)

    # ---------- Workbook (.xlsm with macros) ----------
    tpl_path = Path(template_path) if template_path else _DEFAULT_TEMPLATE
    if not tpl_path.exists():
        raise FileNotFoundError(
            f"Excel template not found at: {tpl_path}\nCWD: {Path.cwd()}"
        )

    wb: Workbook = load_workbook(str(tpl_path), keep_vba=True)
    ws = wb["Report_Template"] if "Report_Template" in wb.sheetnames else wb.active

    # ---------- Header values (use safe setter for merged cells) ----------
    _set_value_safe(ws, "C3", mark_set_id)                                # ID value
    _set_value_safe(ws, "C4", part_number or "")                          # Part Number
    _set_value_safe(ws, "C5", mark_set_label or "")                       # MarkSet Name
    _set_value_safe(ws, "F4", user_email or "viewer_user")                # Created By
    _set_value_safe(ws, "F5", datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))  # Created At

    # ---------- Rows (start at row 8) ----------
    marks_sorted = sorted(
        marks, key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", "")))
    )
    current_row = 8

    # Ensure column C wide enough
    try:
        if ws.column_dimensions["C"].width is None or ws.column_dimensions["C"].width < 23:
            ws.column_dimensions["C"].width = 23  # ~170 px
    except Exception:
        pass

    for idx, m in enumerate(marks_sorted, start=1):
        page_index = int(m["page_index"])
        mark_id = m["mark_id"]
        nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
        label = (m.get("label") or f"Mark {idx}").strip()
        observed = (entries.get(mark_id, "") or "").strip()

        # Write label & observed (Status intentionally empty)
        _set_value_safe(ws, f"B{current_row}", label)
        _set_value_safe(ws, f"F{current_row}", observed)

        # Row height for the image
        try:
            if ws.row_dimensions[current_row].height is None or ws.row_dimensions[current_row].height < 100:
                ws.row_dimensions[current_row].height = 100
        except Exception:
            pass

        # Render crop -> place into C{row}
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

            img = XLImage(bio)
            img.width = 165   # ~fits col C width 23
            img.height = 95   # ~fits row height 100
            img.anchor = f"C{current_row}"
            try:
                img._name = f"inCell_C{current_row}"
            except Exception:
                pass

            ws.add_image(img)
        except Exception:
            # If crop fails, leave the cell blank
            pass

        current_row += 1

    # ---------- Save .xlsm (keep macros) ----------
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out.read()
