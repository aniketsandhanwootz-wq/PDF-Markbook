# services/api/core/report_excel.py
from __future__ import annotations
import io
import os
from typing import Dict, List, Any, Optional
from datetime import datetime
from tempfile import NamedTemporaryFile

import xlsxwriter

from core.report_pdf import _require_pdfium, _render_crop, _fetch_pdf_bytes


def _bytes_to_tempfile(data: bytes, suffix: str = ".png") -> str:
    """Write bytes to temp file for xlsxwriter.embed_image()"""
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
    logo_url: str = "https://res.cloudinary.com/dbwg6zz3l/image/upload/v1753101276/Black_Blue_ctiycp.png",
) -> bytes:
    """
    Build Excel with embedded images using xlsxwriter.
    Images are TRUE cell content (not floating shapes).
    """
    
    # Fetch PDF
    _require_pdfium()
    pdf_bytes = await _fetch_pdf_bytes(pdf_url)
    
    # Prepare workbook
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {'in_memory': True})
    ws = wb.add_worksheet("Inspection Report")
    
    _tempfiles: List[str] = []
    
    try:
        # Formats
        fmt_header = wb.add_format({
            'bold': True, 'align': 'center', 'valign': 'vcenter',
            'border': 1, 'bg_color': '#a7d4f0', 'text_wrap': True
        })
        fmt_subheader = wb.add_format({
            'align': 'center', 'valign': 'vcenter',
            'border': 1, 'bg_color': '#dff3ea'
        })
        fmt_cell = wb.add_format({'border': 1, 'valign': 'vcenter', 'text_wrap': True})
        fmt_center = wb.add_format({'border': 1, 'align': 'center', 'valign': 'vcenter'})
        
        # Column widths
        ws.set_column('A:A', 12)   # Label
        ws.set_column('B:B', 25)   # Image
        ws.set_column('C:D', 10)   # Tolerance
        ws.set_column('E:E', 18)   # Observed
        ws.set_column('F:G', 14)   # Status/Comment
        
        # Row 1: Logo
        ws.set_row(0, 100)
        if logo_url:
            try:
                logo_bytes = await _fetch_pdf_bytes(logo_url)
                logo_path = _bytes_to_tempfile(logo_bytes, suffix=".png")
                _tempfiles.append(logo_path)
                ws.embed_image('C1', logo_path)
            except Exception as e:
                print(f"Logo fetch failed: {e}")
        
        # Row 2: Mark Set ID
        ws.set_row(1, 20)
        ws.merge_range(1, 1, 1, 5, mark_set_id, fmt_subheader)
        
        # Row 3: Part Number & Metadata
        ws.set_row(2, 20)
        ws.merge_range(2, 0, 2, 2, part_number or "", fmt_cell)
        ws.merge_range(2, 4, 2, 5, 
                      f"{user_email or 'viewer_user'} | {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
                      fmt_cell)
        
        # Row 4: Optional label row
        ws.set_row(3, 18)
        ws.write(3, 0, "PN-001", fmt_cell)
        ws.merge_range(3, 1, 3, 6, "", fmt_cell)
        
        # Row 5: Spacer
        ws.set_row(4, 6)
        
        # Row 6: Table Header
        ws.set_row(5, 28)
        ws.write(5, 0, "Label", fmt_header)
        ws.write(5, 1, "Required Value", fmt_header)
        ws.merge_range(5, 2, 5, 3, "Tolerance\nMin / Max", fmt_header)
        ws.write(5, 4, "Observed\nValue", fmt_header)
        ws.write(5, 5, "Status", fmt_header)
        ws.write(5, 6, "Comment", fmt_header)
        
        # Data rows start at index 7
        start_row = 7
        marks_sorted = sorted(marks, key=lambda m: (int(m.get("order_index", 0)), str(m.get("name", ""))))
        
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdf_bytes)
        
        for idx, m in enumerate(marks_sorted, start=1):
            r = start_row + (idx - 1)
            ws.set_row(r, 100)
            
            page_index = int(m["page_index"])
            mark_id = m.get("mark_id", "")
            nx, ny, nw, nh = float(m["nx"]), float(m["ny"]), float(m["nw"]), float(m["nh"])
            label = (m.get("label") or f"Mark {idx}").strip()
            observed = (entries.get(mark_id, "") or "").strip()
            
            # Write text cells
            ws.write(r, 0, label, fmt_center)
            ws.write_blank(r, 2, None, fmt_cell)
            ws.write_blank(r, 3, None, fmt_cell)
            ws.write(r, 4, observed, fmt_cell)
            ws.write_blank(r, 5, None, fmt_cell)
            ws.write_blank(r, 6, None, fmt_cell)
            
            # Render and embed image
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
                
                ws.embed_image(r, 1, img_path)
            except Exception as e:
                print(f"Image render failed for mark {idx}: {e}")
                ws.write_blank(r, 1, None, fmt_cell)
        
        # Close workbook
        wb.close()
        out.seek(0)
        return out.read()
        
    finally:
        # Cleanup temp files
        for p in _tempfiles:
            try:
                os.unlink(p)
            except:
                pass