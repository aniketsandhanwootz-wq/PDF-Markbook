'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Use CDN worker for simplicity in local dev & Glide webview
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

type Mark = {
  mark_id: string;
  page_index: number; // 0-based
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  padding_pct?: number;
  anchor?: string;
};

const API_BASE = 'http://localhost:8000';

// Fallback sample (keeps viewer working for quick demo)
const SAMPLE_PDF =
  'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- rotation math -----------------------------------------------------------
function mapRectToRotation(
  W: number,
  H: number,
  rect: { x: number; y: number; w: number; h: number },
  r: number
) {
  const { x, y, w, h } = rect;
  const rot = ((r || 0) % 360 + 360) % 360;
  if (rot === 0) return { rx: x, ry: y, rw: w, rh: h, RW: W, RH: H };
  if (rot === 90) return { rx: y, ry: W - (x + w), rw: h, rh: w, RW: H, RH: W };
  if (rot === 180) return { rx: W - (x + w), ry: H - (y + h), rw: w, rh: h, RW: W, RH: H };
  return { rx: H - (y + h), ry: x, rw: h, rh: w, RW: H, RH: W }; // 270
}

function computeAutoScale(
  containerW: number,
  containerH: number,
  rw: number,
  rh: number,
  paddingPx: number,
  boost = 1.5
) {
  const needW = rw + 2 * paddingPx;
  const needH = rh + 2 * paddingPx;
  const fit = Math.min(containerW / needW, containerH / needH);
  return clamp(fit * boost, 0.25, 8);
}
// -----------------------------------------------------------------------------

export default function ViewerPage() {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState('Loading marks…');

  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTokenRef = useRef(0);
  const scaleRef = useRef(1);

  const isMobile = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  }, []);

  // Read params (supports Glide webview)
  useEffect(() => {
    const ps = new URLSearchParams(window.location.search);
    const u = ps.get('pdf_url') || SAMPLE_PDF; // keep working if missing
    const m = ps.get('mark_set_id') || '';
    const demo = ps.get('demo') === '1';

    setPdfUrl(u);
    setMarkSetId(m);

    // In demo mode, synthesize two marks across different pages (pg 1 & pg 6)
    if (demo) {
      setMarks([
        {
          mark_id: 'demo-1',
          page_index: 0,
          order_index: 0,
          name: 'Title area',
          nx: 0.18,
          ny: 0.09,
          nw: 0.64,
          nh: 0.12,
          padding_pct: 0.12,
        },
        {
          mark_id: 'demo-2',
          page_index: 5,
          order_index: 1,
          name: 'Figure block',
          nx: 0.08,
          ny: 0.28,
          nw: 0.58,
          nh: 0.36,
          padding_pct: 0.10,
        },
      ]);
    }
  }, []);

  // Load marks from API if not demo
  useEffect(() => {
    const ready = pdfUrl && markSetId && marks.length === 0;
    if (!ready) return;

    (async () => {
      try {
        setStatus('Loading marks…');
        const r = await fetch(`${API_BASE}/mark-sets/${markSetId}/marks`);
        if (!r.ok) throw new Error(`marks fetch failed (${r.status})`);
        const arr: Mark[] = await r.json();
        if (!arr.length) throw new Error('no marks in mark set');
        setMarks(arr);
        setStatus('Marks ready');
      } catch (e: any) {
        console.error(e);
        setStatus(`Error: ${e?.message || e}`);
      }
    })();
  }, [pdfUrl, markSetId, marks.length]);

  // Load PDF once we know URL
  useEffect(() => {
    if (!pdfUrl) return;
    (async () => {
      try {
        setStatus('Loading PDF…');
        const task = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: false,
          isEvalSupported: false,
        });
        const pdf = await task.promise;
        setPdfDoc(pdf);
        setStatus('Ready');
      } catch (e: any) {
        console.error(e);
        setStatus(`Error loading PDF: ${e?.message || e}`);
      }
    })();
  }, [pdfUrl]);

  /** Core renderer: render page at scale and center the rect inside the scrollable pane */
  const renderAndCenter = async (markIndex: number, explicitScale?: number) => {
    if (!pdfDoc || !marks.length) return;

    const mark = marks[markIndex];
    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas || !mark) return;

    const token = ++renderTokenRef.current;
    const page = await pdfDoc.getPage(mark.page_index + 1);

    // Unrotated base dims
    const vp0 = page.getViewport({ scale: 1, rotation: 0 });
    const W = vp0.width;
    const H = vp0.height;

    const rotation = (page.rotate || 0) % 360;

    // mark -> absolute unrotated -> rotated rect
    const abs = { x: mark.nx * W, y: mark.ny * H, w: mark.nw * W, h: mark.nh * H };
    const { rx, ry, rw, rh } = mapRectToRotation(W, H, abs, rotation);

    const containerW = pane.clientWidth;
    const containerH = pane.clientHeight;
    const pad = (mark.padding_pct ?? 0.1) * Math.max(rw, rh);

    // scale = 150% of fit unless explicitScale supplied
    const scale = explicitScale ?? computeAutoScale(containerW, containerH, rw, rh, pad, 1.5);
    scaleRef.current = scale;

    // viewport at rotation
    const viewport = page.getViewport({ scale, rotation });

    // HiDPI canvas
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    if (renderTokenRef.current !== token) return; // superseded

    // Center scroll on rect
    const centerX = rx * scale + (rw * scale) / 2;
    const centerY = ry * scale + (rh * scale) / 2;

    const maxLeft = Math.max(0, viewport.width - containerW);
    const maxTop = Math.max(0, viewport.height - containerH);

    const targetLeft = clamp(centerX - containerW / 2, 0, maxLeft);
    const targetTop = clamp(centerY - containerH / 2, 0, maxTop);

    pane.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });

    // Preload next page to keep Next snappy
    if (markIndex + 1 < marks.length) {
      pdfDoc.getPage(marks[markIndex + 1].page_index + 1).catch(() => {});
    }
  };

  // Initial render and when index changes
  useEffect(() => {
    if (!pdfDoc || !marks.length) return;
    renderAndCenter(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, marks, idx]);

  // Recompute on resize
  useEffect(() => {
    let t: any;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => renderAndCenter(idx), 120);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, pdfDoc, marks]);

  // Natural pinch / Ctrl+wheel zoom inside the pane only
  useEffect(() => {
    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas) return;

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // don’t hijack normal scrolling
      e.preventDefault();

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = clamp(scaleRef.current * factor, 0.25, 8);

      // Keep pointer as focus
      const rect = canvas.getBoundingClientRect();
      const cursorXInCanvas = (e.clientX - rect.left) + pane.scrollLeft;
      const cursorYInCanvas = (e.clientY - rect.top) + pane.scrollTop;

      renderAndCenter(idx, newScale).then(() => {
        const ratio = newScale / (scaleRef.current || 1);
        pane.scrollTo({
          left: cursorXInCanvas * ratio - (e.clientX - rect.left),
          top: cursorYInCanvas * ratio - (e.clientY - rect.top),
        });
      });
    };

    pane.addEventListener('wheel', onWheel, { passive: false });
    return () => pane.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, pdfDoc, marks]);

  const current = marks[idx];

  return (
    <div style={{ display: 'grid', gridTemplateRows: '56px 1fr', height: '100vh' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 12px',
          borderBottom: '1px solid #e5e5e5',
          background: '#fff',
        }}
      >
        <button onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} style={{ padding: '6px 10px' }}>
          ← Previous
        </button>
        <button
          onClick={() => setIdx(Math.min(marks.length - 1, idx + 1))}
          disabled={idx === marks.length - 1}
          style={{ padding: '6px 10px' }}
        >
          Next →
        </button>

        <div style={{ fontWeight: 600 }}>
          {current
            ? `${current.name} (${idx + 1} / ${marks.length})`
            : status}
        </div>

        <div style={{ marginLeft: 'auto', color: '#777', fontSize: 13 }}>{status}</div>
      </div>

      {/* Main: left scrollable PDF pane + right marks list (bottom sheet on mobile) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 320px',
          gridTemplateRows: isMobile ? '1fr 240px' : '1fr',
          height: '100%',
        }}
      >
        {/* Scrollable PDF pane */}
        <div
          ref={paneRef}
          id="pdfPane"
          style={{
            overflow: 'auto', // the only scrollable area
            background: '#f6f7f9',
            height: '100%',
          }}
        >
          {/* Let canvas size dictate scroll extents; center visually with margin */}
          <div style={{ padding: 16 }}>
            <canvas
              ref={canvasRef}
              style={{
                display: 'block',
                background: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                margin: '0 auto',
              }}
            />
          </div>
        </div>

        {/* Marks list: Sidebar on desktop, bottom sheet on mobile */}
        <aside
          style={{
            borderLeft: isMobile ? 'none' : '1px solid #e5e5e5',
            borderTop: isMobile ? '1px solid #e5e5e5' : 'none',
            overflow: 'auto',
            background: '#fff',
          }}
        >
          <div style={{ padding: 12, position: 'sticky', top: 0, background: '#fff', zIndex: 1, borderBottom: '1px solid #eee' }}>
            <strong>All Marks</strong>
          </div>
          <div style={{ padding: 12 }}>
            {marks.map((m, i) => (
              <button
                key={`${m.mark_id}-${i}`}
                onClick={() => setIdx(i)}
                style={{
                  textAlign: 'left',
                  width: '100%',
                  padding: '10px 12px',
                  marginBottom: 8,
                  borderRadius: 8,
                  border: i === idx ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                  background: i === idx ? '#eff6ff' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: '#666' }}>Page {m.page_index + 1}</div>
              </button>
            ))}
            {!marks.length && (
              <div style={{ color: '#777', fontSize: 14 }}>
                {status} &nbsp; Tip: open <code>?demo=1</code> to test quickly.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
