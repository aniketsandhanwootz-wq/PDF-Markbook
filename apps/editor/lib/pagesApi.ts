// apps/editor/lib/pagesApi.ts
import type { PDFDocumentProxy } from "pdfjs-dist";

export type BootstrapDimsPayload = {
  page_index: number;
  width_pt: number;
  height_pt: number;
  rotation_deg: number;
};

/**
 * Call backend /pages/bootstrap with geometry for all pages.
 *
 * @param apiBaseUrl e.g. process.env.NEXT_PUBLIC_API_BASE_URL
 * @param docId      doc_id from /documents/init
 * @param pdf        PDFDocumentProxy from pdfjs-dist
 */
export async function bootstrapPagesForDoc(
  apiBaseUrl: string,
  docId: string,
  pdf: PDFDocumentProxy
): Promise<void> {
  const pageCount = pdf.numPages;
  const dims: BootstrapDimsPayload[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

    // page.view is [xMin, yMin, xMax, yMax] in PDF points (1/72")
    const [xMin, yMin, xMax, yMax] = page.view as [
      number,
      number,
      number,
      number
    ];

    const widthPt = xMax - xMin;
    const heightPt = yMax - yMin;
    const rotation = (page.rotate || 0) as number;

    dims.push({
      page_index: i - 1, // 0-based index, matches backend schema
      width_pt: widthPt,
      height_pt: heightPt,
      rotation_deg: rotation,
    });
  }

  const res = await fetch(`${apiBaseUrl}/pages/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      doc_id: docId,
      page_count: pageCount,
      dims,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("bootstrapPagesForDoc failed:", res.status, text);
    throw new Error(`bootstrapPagesForDoc failed: HTTP ${res.status}`);
  }
}


// ---------- OCR: required value for a mark ----------

export type RequiredValueOCRRequestPayload = {
  mark_set_id: string;
  page_index: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
};

export type RequiredValueOCRResponse = {
  required_value_ocr: string | null;
  required_value_conf: number;
};

/**
 * Call backend /ocr/required-value to OCR the required value
 * for a given mark bounding box.
 */
export async function runRequiredValueOCR(
  apiBaseUrl: string,
  payload: RequiredValueOCRRequestPayload
): Promise<RequiredValueOCRResponse> {
  const res = await fetch(`${apiBaseUrl}/ocr/required-value`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`runRequiredValueOCR failed: HTTP ${res.status} ${text}`);
  }

  return (await res.json()) as RequiredValueOCRResponse;
}
