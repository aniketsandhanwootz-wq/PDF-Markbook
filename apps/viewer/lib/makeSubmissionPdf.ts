// apps/viewer/lib/makeSubmissionPdf.ts
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type Mark = {
  mark_id?: string;
  page_index: number;   // 0-based
  order_index: number;
  name: string;
  nx: number; ny: number; nw: number; nh: number; // normalized 0..1
  zoom_hint?: number | null;
  padding_pct?: number; // optional
  anchor?: string;
};

type Entries = Record<string, string>;

type MakePdfOpts = {
  title?: string;         // top-of-PDF doc title
  author?: string;        // metadata
  padding?: number;       // extra padding around mark (as % of mark size), default 0.1 = 10%
  renderScale?: number;   // render resolution multiplier, default 2
  pageMarginsPt?: number; // A4 margins in points, default 36pt (0.5in)
};

const A4_WIDTH_PT = 595.28;  // 210mm @ 72dpi
const A4_HEIGHT_PT = 841.89; // 297mm @ 72dpi

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve) => canvas.toBlob(b => resolve(b!), 'image/png'));
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Render a single page to an offscreen canvas at given scale and crop a rect (in CSS px).
 */
async function renderAndCrop(
  pdf: PDFDocumentProxy,
  pageIndex0: number,
  targetRectPx: { x: number; y: number; w: number; h: number },
  renderScale = 2
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageIndex0 + 1);
  const vp = page.getViewport({ scale: renderScale });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false })!;
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  // Crop into a second canvas to keep output dimensions small
  const crop = document.createElement('canvas');
  const sx = Math.max(0, Math.floor(targetRectPx.x * renderScale));
  const sy = Math.max(0, Math.floor(targetRectPx.y * renderScale));
  const sw = Math.min(canvas.width - sx, Math.ceil(targetRectPx.w * renderScale));
  const sh = Math.min(canvas.height - sy, Math.ceil(targetRectPx.h * renderScale));

  crop.width = Math.max(1, sw);
  crop.height = Math.max(1, sh);
  const cctx = crop.getContext('2d')!;
  cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return crop;
}

/**
 * Build a submission PDF: one page per mark — image (mark+nearby area) + user text.
 */
export async function makeSubmissionPdf(
  pdf: PDFDocumentProxy,
  marks: Mark[],
  entries: Entries,
  opts: MakePdfOpts = {}
): Promise<Uint8Array> {
  const {
    title = 'Markbook Submission',
    author = 'PDF Viewer',
    padding = 0.10,
    renderScale = 2,
    pageMarginsPt = 36
  } = opts;

  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor(author);

  const font = await doc.embedFont(StandardFonts.Helvetica);
const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Build pages
  for (const mark of marks) {
    // Get page at scale=1 to compute absolute px
    const page = await pdf.getPage(mark.page_index + 1);
    const vp1 = page.getViewport({ scale: 1 });

    // Mark rect at 1x
    const base = {
      x: mark.nx * vp1.width,
      y: mark.ny * vp1.height,
      w: mark.nw * vp1.width,
      h: mark.nh * vp1.height
    };

    // Apply padding around the mark rect (as a fraction of rect size)
    const padFrac = (typeof mark.padding_pct === 'number' ? mark.padding_pct : padding);
    const padX = base.w * padFrac;
    const padY = base.h * padFrac;

    // IMPORTANT: PDF coords origin is top-left for our canvas math (pdf.js gives y from top)
    const cropRectPx = {
      x: Math.max(0, base.x - padX),
      y: Math.max(0, base.y - padY),
      w: Math.min(vp1.width - (base.x - padX), base.w + padX * 2),
      h: Math.min(vp1.height - (base.y - padY), base.h + padY * 2),
    };
    const rectInCropPx = {
  x: base.x - cropRectPx.x,
  y: base.y - cropRectPx.y,   // top-origin here
  w: base.w,
  h: base.h,
};
// Our PNG was rendered/cropped at `renderScale`, so scale the rect too.
const rectInCropPxRS = {
  x: rectInCropPx.x * renderScale,
  y: rectInCropPx.y * renderScale,
  w: rectInCropPx.w * renderScale,
  h: rectInCropPx.h * renderScale,
};


    // Render and crop this area
    const cropCanvas = await renderAndCrop(pdf, mark.page_index, cropRectPx, renderScale);
    const pngBytes = await canvasToPngBytes(cropCanvas);
    const png = await doc.embedPng(pngBytes);

    // Create output page
    const pageOut = doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);

    // Layout constants
    const innerW = A4_WIDTH_PT - pageMarginsPt * 2;
    const innerH = A4_HEIGHT_PT - pageMarginsPt * 2;

    let cursorY = A4_HEIGHT_PT - pageMarginsPt; // start from top margin downward (PDF points origin bottom-left)
    const line = (txt: string, size = 12, color = rgb(0, 0, 0), bold = false) => {
  const f = bold ? fontBold : font;
  const fontSize = size;
  const height = fontSize * 1.35;
  cursorY -= height;
  pageOut.drawText(txt, {
    x: pageMarginsPt,
    y: cursorY,
    size: fontSize,
    font: f,            // <-- use bold when requested
    color,
  });
  return height;
};


    // Header
   line(`Mark: ${mark.name || '(unnamed)'}`, 14, rgb(0,0,0), /*bold=*/true);
    line(`Source Page: ${mark.page_index + 1}`, 10, rgb(0.2, 0.2, 0.2));
    cursorY -= 6;

    // Image block — fit width, keep aspect, reserve ~60% inner height if needed
    const maxImgW = innerW;
    const maxImgH = innerH * 0.6;
    const imgW = png.width;
    const imgH = png.height;
    const scale = Math.min(maxImgW / imgW, maxImgH / imgH, 1);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    // Draw image (pdf bottom-left origin)
    pageOut.drawImage(png, {
      x: pageMarginsPt,
      y: cursorY - drawH,
      width: drawW,
      height: drawH,
    });
    // Draw mark boundary (no fill) on top of the image
// Use the render-scaled rectangle so it aligns with the render-scaled PNG.
const rectXOnPage = pageMarginsPt + rectInCropPxRS.x * scale;
const rectYOnPage =
  (cursorY - drawH) + (imgH - (rectInCropPxRS.y + rectInCropPxRS.h)) * scale;
const rectWOnPage = rectInCropPxRS.w * scale;
const rectHOnPage = rectInCropPxRS.h * scale;

pageOut.drawRectangle({
  x: rectXOnPage,
  y: rectYOnPage,
  width: rectWOnPage,
  height: rectHOnPage,
  borderColor: rgb(1, 0, 0.6), // pink outline
  borderWidth: 2,
  color: undefined,            // no fill
});


    cursorY -= (drawH + 10);

    // User answer
    const answer = mark.mark_id ? (entries[mark.mark_id] ?? '') : '';
    const label = 'User Input:';
    line(label, 12);
    // Simple wrap
    const text = (answer || '(no answer provided)').trim();
    const wrapWidth = innerW;
    const words = text.split(/\s+/);
    let current = '';
    const fontSize = 12;

    const widthOf = (s: string) => font.widthOfTextAtSize(s, fontSize);

    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (widthOf(test) > wrapWidth) {
        line(current, fontSize);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) line(current, fontSize);

    // A little footer space
    cursorY -= 6;
  }

  const bytes = await doc.save();
  return bytes; // Uint8Array
}

/**
 * Trigger browser download.
 */
export function downloadBytes(pdfBytes: Uint8Array, filename: string) {
  // Make a clean ArrayBuffer slice and assert the concrete type
  const ab = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength
  ) as ArrayBuffer;                    // 👈 important cast

  const blob = new Blob([ab as ArrayBuffer], { type: 'application/pdf' }); // 👈 stays ArrayBuffer
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;

  document.body.appendChild(a); // iOS/Safari reliability
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 0); // let Safari start reading first
}
