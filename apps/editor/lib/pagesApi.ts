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
