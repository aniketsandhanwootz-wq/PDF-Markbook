# services/api/core/report_excel.py
from __future__ import annotations

import io
from pathlib import Path
from typing import Dict, List, Any, Optional
from datetime import datetime

import httpx  # <-- add
from openpyxl import load_workbook, Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.cell.cell import MergedCell

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes

_DEFAULT_TEMPLATE = (
    Path(__file__).resolve().parent.parent / "templates" / "report_template.xlsm"
)

def _set_value_safe(ws, coord: str, value) -> None:
    cell = ws[coord]
    if isinstance(cell, MergedCell):
        for mr in ws.merged_cells.ranges:
            if cell.coordinate in mr:
                ws.cell(row=mr.min_row, column=mr.min_col).value = value
                return
        return
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

    # ---------- Workbook ----------
    tpl_path = Path(template_path) if template_path else _DEFAULT_TEMPLATE
    if not tpl_path.exists():
        raise FileNotFoundError(f"Excel template not found at: {tpl_path}\nCWD: {Path.cwd()}")

    wb: Workbook = load_workbook(str(tpl_path), keep_vba=True)
    ws = wb["Report_Template"] if "Report_Template" in wb.sheetnames else wb.active

    # ---------- Header values ----------
    _set_value_safe(ws, "C3", mark_set_id)
    _set_value_safe(ws, "C4", part_number or "")
    _set_value_safe(ws, "C5", mark_set_label or "")
    _set_value_safe(ws, "F4", user_email or "viewer_user")
    _set_value_safe(ws, "F5", datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))

    # ---------- Logo (Wootz) ----------
    try:
        logo_url = "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(logo_url)
            resp.raise_for_status()
            bio_logo = io.BytesIO(resp.content)
            logo = XLImage(bio_logo)
            # Reasonable size for header band; adjust if needed
            logo.width = 200
            logo.height = 40
            # Anchor roughly near the header title row; macro won’t touch it
            logo.anchor = "C1"
            ws.add_image(logo)
    except Exception:
        # If logo fetch fails, we just skip it silently
        pass

    # ---------- Rows ----------
    marks_sorted = sorted(marks, key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))))
    current_row = 8

    try:
        if ws.column_dimensions["C"].width is None or ws.column_dimensions["C"].width < 23:
            ws.column_dimensions["C"].width = 23
    except Exception:
        pass

    for idx, m in enumerate(marks_sorted, start=1):
        page_index = int(m["page_index"])
        mark_id = m["mark_id"]
        nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
        label = (m.get("label") or f"Mark {idx}").strip()
        observed = (entries.get(mark_id, "") or "").strip()

        _set_value_safe(ws, f"B{current_row}", label)
        _set_value_safe(ws, f"F{current_row}", observed)

        try:
            if ws.row_dimensions[current_row].height is None or ws.row_dimensions[current_row].height < 100:
                ws.row_dimensions[current_row].height = 100
        except Exception:
            pass

        # Render crop and place at C{row}; macro will snap/centre/Move&Size
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
            img.width = 165
            img.height = 95
            img.anchor = f"C{current_row}"
            try:
                img._name = f"inCell_C{current_row}"
            except Exception:
                pass

            ws.add_image(img)
        except Exception:
            pass

        current_row += 1

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out.read()
