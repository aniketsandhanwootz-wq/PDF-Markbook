'use client';

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Worker from CDN (works well in Glide webview + local)
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';

// Fallback sample so the editor works even without URL params
const SAMPLE_PDF =
  'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

type Mark = {
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
};

type PageDim = {
  idx: number;
  width_pt: number; // unrotated page width (pt)
  height_pt: number; // unrotated page height (pt)
  rotation_deg: number; // page rotation (0/90/180/270)
};

// ---- rotation helpers -------------------------------------------------------

function mapRectRotatedToUnrotated(
  W: number,
  H: number,
  rectR: { rx: number; ry: number; rw: number; rh: number },
  r: number
) {
  const rot = ((r || 0) % 360 + 360) % 360;
  const { rx, ry, rw, rh } = rectR;

  if (rot === 0) return { x: rx, y: ry, w: rw, h: rh };
  if (rot === 90) return { x: W - (ry + rh), y: rx, w: rh, h: rw };
  if (rot === 180) return { x: W - (rx + rw), y: H - (ry + rh), w: rw, h: rh };
  // 270
  return { x: ry, y: H - (rx + rw), w: rh, h: rw };
}

// -----------------------------------------------------------------------------

export default function EditorPage() {
  const [pdfUrl, setPdfUrl] = useState('');
  const [userId, setUserId] = useState('anonymous');

  const [docId, setDocId] = useState('');
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  const [pageDims, setPageDims] = useState<PageDim[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [status, setStatus] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef(1);
  const rotationRef = useRef(0);

  // Parse URL; keep working with a sample if missing
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const url = qs.get('pdf_url') || SAMPLE_PDF;
    const user = qs.get('user_id') || 'anonymous';
    setPdfUrl(url);
    setUserId(user);
  }, []);

  // Init document + PDF + bootstrap
  useEffect(() => {
    if (!pdfUrl) return;

    (async () => {
      try {
        setStatus('Creating document…');

        const createRes = await fetch(`${API_BASE}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdf_url: pdfUrl, created_by: userId }),
        });
        if (!createRes.ok) throw new Error('Failed to create document');
        const { doc_id } = await createRes.json();
        setDocId(doc_id);

        setStatus('Loading PDF…');

        const task = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: false,
          isEvalSupported: false,
        });
        const pdf = await task.promise;
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);

        setStatus('Collecting page dimensions…');

        const dims: PageDim[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1, rotation: 0 }); // unrotated base
          dims.push({
            idx: i - 1,
            width_pt: vp.width,
            height_pt: vp.height,
            rotation_deg: (page.rotate || 0) % 360,
          });
        }
        setPageDims(dims);
        console.log('Bootstrap dims', dims);

        setStatus('Bootstrapping pages…');

        // POST bootstrap (ignore 409 if already bootstrapped)
        const b = await fetch(`${API_BASE}/documents/${doc_id}/pages/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page_count: pdf.numPages, dims }),
        });
        if (b.status === 409) {
          console.info('Pages already bootstrapped, continuing.');
        } else if (!b.ok) {
          const t = await b.text();
          throw new Error('Bootstrap failed: ' + t);
        }

        setStatus('Ready to mark regions');
        setCurrentPage(1);
      } catch (e: any) {
        console.error(e);
        setStatus(`Error: ${e?.message || e}`);
      }
    })();
  }, [pdfUrl, userId]);

  // Render current page (Hi-DPI, rotation aware)
  useEffect(() => {
    if (!pdfDoc || !currentPage) return;

    (async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const rotation = (page.rotate || 0) % 360;
        rotationRef.current = rotation;

        // Friendly editing scale
        const scale = 1.5;
        scaleRef.current = scale;

        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current!;
        const overlay = overlayRef.current!;

        // Hi-DPI canvas
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);

        // overlay in CSS px
        overlay.width = Math.floor(viewport.width);
        overlay.height = Math.floor(viewport.height);
        overlay.style.width = `${viewport.width}px`;
        overlay.style.height = `${viewport.height}px`;

        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewport.width, viewport.height);

        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (e) {
        console.error('Render error:', e);
      }
    })();
  }, [pdfDoc, currentPage]);

  // Drawing handlers
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [curPt, setCurPt] = useState<{ x: number; y: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    setIsDrawing(true);
    setStartPt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setCurPt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPt) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCurPt({ x, y });

    const ov = overlayRef.current!;
    const octx = ov.getContext('2d')!;
    octx.clearRect(0, 0, ov.width, ov.height);
    octx.strokeStyle = '#ff0000';
    octx.lineWidth = 2;
    const x1 = Math.min(startPt.x, x);
    const y1 = Math.min(startPt.y, y);
    const w = Math.abs(x - startPt.x);
    const h = Math.abs(y - startPt.y);
    octx.strokeRect(x1, y1, w, h);
  };

  const onMouseUp = () => {
    if (!isDrawing || !startPt || !curPt) return;

    setIsDrawing(false);

    const ov = overlayRef.current!;
    const octx = ov.getContext('2d')!;
    octx.clearRect(0, 0, ov.width, ov.height);

    const name = prompt('Enter mark name:');
    if (!name) {
      setStartPt(null);
      setCurPt(null);
      return;
    }

    const x1v = Math.min(startPt.x, curPt.x);
    const y1v = Math.min(startPt.y, curPt.y);
    const x2v = Math.max(startPt.x, curPt.x);
    const y2v = Math.max(startPt.y, curPt.y);

    const scale = scaleRef.current;
    const rotation = rotationRef.current;
    const p = pageDims[currentPage - 1];
    if (!p) return;

    // Viewport px -> rotated page space (divide by scale)
    const rx = x1v / scale;
    const ry = y1v / scale;
    const rw = (x2v - x1v) / scale;
    const rh = (y2v - y1v) / scale;

    // Rotated -> UNROTATED page space
    const unrot = mapRectRotatedToUnrotated(p.width_pt, p.height_pt, { rx, ry, rw, rh }, rotation);

    // Normalize and clamp
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    let nx = clamp01(unrot.x / p.width_pt);
    let ny = clamp01(unrot.y / p.height_pt);
    let nw = clamp01(unrot.w / p.width_pt);
    let nh = clamp01(unrot.h / p.height_pt);

    const MIN = 0.01;
    if (nw < MIN) nw = MIN;
    if (nh < MIN) nh = MIN;
    if (nx + nw > 1) nx = Math.max(0, 1 - nw);
    if (ny + nh > 1) ny = Math.max(0, 1 - nh);

    setMarks((prev) => [
      ...prev,
      {
        page_index: currentPage - 1,
        order_index: prev.length,
        name,
        nx,
        ny,
        nw,
        nh,
      },
    ]);

    setStartPt(null);
    setCurPt(null);
  };

  // Save mark set
  const saveMarkSet = async () => {
    if (!marks.length) {
      alert('No marks to save');
      return;
    }
    try {
      setStatus('Saving mark set…');
      const res = await fetch(`${API_BASE}/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_id: docId,
          label: 'v1',
          created_by: userId,
          marks,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { mark_set_id } = await res.json();
      setStatus(`Saved! mark_set_id: ${mark_set_id}`);
      await navigator.clipboard.writeText(mark_set_id);
      alert(`Mark set saved!\n\nID: ${mark_set_id}\n\n(Copied to clipboard)`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Save error: ${e?.message || e}`);
    }
  };

  // Reorder/delete
  const deleteMark = (i: number) => {
    const next = marks.filter((_, idx) => idx !== i).map((m, j) => ({ ...m, order_index: j }));
    setMarks(next);
  };
  const moveUp = (i: number) => {
    if (i === 0) return;
    const next = [...marks];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    next.forEach((m, j) => (m.order_index = j));
    setMarks(next);
  };
  const moveDown = (i: number) => {
    if (i === marks.length - 1) return;
    const next = [...marks];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    next.forEach((m, j) => (m.order_index = j));
    setMarks(next);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* Main canvas area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '1rem', background: '#f5f5f5' }}>
        <div style={{ marginBottom: '1rem', display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            style={{ padding: '6px 12px' }}
          >
            Previous
          </button>
        <span>Page {currentPage} / {totalPages}</span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            style={{ padding: '6px 12px' }}
          >
            Next
          </button>

          {/* Quick dev helpers */}
          <a
            href={`/?pdf_url=${encodeURIComponent(SAMPLE_PDF)}&user_id=dev`}
            style={{ marginLeft: 12, fontSize: 13 }}
            title="Reload with sample PDF"
          >
            use sample
          </a>

          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#666' }}>{status}</span>
        </div>

        <div style={{ position: 'relative', display: 'inline-block' }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', border: '1px solid #ddd', background: '#fff' }}
          />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
          />
        </div>

        <div style={{ marginTop: '1rem', color: '#666', fontSize: 13 }}>
          <strong>Instructions:</strong> Click and drag to draw a rectangle. You’ll be prompted to name it.
        </div>
      </div>

      {/* Sidebar */}
      <aside
        style={{
          width: 300,
          borderLeft: '1px solid #e5e5e5',
          background: '#fff',
          padding: '1rem',
          overflow: 'auto',
        }}
      >
        <h3>Marks ({marks.length})</h3>

        {!marks.length && <p style={{ color: '#999' }}>No marks yet</p>}

        {marks.map((m, i) => (
          <div
            key={`${m.name}-${i}`}
            style={{
              border: '1px solid #e5e5e5',
              borderRadius: 8,
              padding: 10,
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>{m.name}</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              Page {m.page_index + 1}, Order {m.order_index}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button onClick={() => moveUp(i)} disabled={i === 0}>↑</button>
              <button onClick={() => moveDown(i)} disabled={i === marks.length - 1}>↓</button>
              <button onClick={() => deleteMark(i)} style={{ marginLeft: 'auto' }}>Delete</button>
            </div>
          </div>
        ))}

        {!!marks.length && (
          <button
            onClick={saveMarkSet}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px 12px',
              background: '#0b66ff',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Save Mark Set
          </button>
        )}
      </aside>
    </div>
  );
}
