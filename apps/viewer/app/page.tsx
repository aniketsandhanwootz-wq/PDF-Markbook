'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';

type Mark = {
  mark_id: string;
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  padding_pct: number;
  anchor: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Map a rect from UNROTATED page space to ROTATED page space */
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
  // 270
  return { rx: H - (y + h), ry: x, rw: h, rh: w, RW: H, RH: W };
}

/** Compute scale and target scroll for a mark (150% of fit-to-region) */
function computeAutoZoom(
  containerW: number,
  containerH: number,
  rotatedRect: { rw: number; rh: number },
  paddingPx: number,
  fitBoost: number // e.g., 1.5
) {
  const needW = rotatedRect.rw + 2 * paddingPx;
  const needH = rotatedRect.rh + 2 * paddingPx;
  const fitScale = Math.min(containerW / needW, containerH / needH);
  // 150% of fit, clamped
  return clamp(fitScale * fitBoost, 0.25, 8);
}

export default function ViewerPage() {
  // URL params
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');

  // Data & state
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState('Loading…');

  // Refs
  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentScaleRef = useRef(1); // for gesture zoom
  const renderTokenRef = useRef(0);

  // Params
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const u = p.get('pdf_url');
    const m = p.get('mark_set_id');
    if (u && m) {
      setPdfUrl(u);
      setMarkSetId(m);
    } else {
      setStatus('Add ?pdf_url=…&mark_set_id=… to the URL');
    }
  }, []);

  // Fetch marks & PDF
  useEffect(() => {
    if (!pdfUrl || !markSetId) return;
    (async () => {
      try {
        setStatus('Loading marks…');
        const r = await fetch(`${API_BASE}/mark-sets/${markSetId}/marks`);
        if (!r.ok) throw new Error('marks fetch failed');
        const arr: Mark[] = await r.json();
        if (!arr.length) throw new Error('no marks');
        setMarks(arr);

        setStatus('Loading PDF…');
        const task = pdfjsLib.getDocument({ url: pdfUrl, withCredentials: false, isEvalSupported: false });
        const pdf = await task.promise;
        setPdfDoc(pdf);

        setStatus('Ready');
        setIdx(0);
      } catch (e: any) {
        console.error(e);
        setStatus(`Error: ${e?.message || e}`);
      }
    })();
  }, [pdfUrl, markSetId]);

  /** Core renderer: render page at scale and center the rect inside the scrollable pane */
  const renderAndCenter = async (pageIndex: number, targetScale?: number) => {
    if (!pdfDoc || !marks.length) return;
    const mark = marks[pageIndex];
    if (!mark) return;

    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas) return;

    const thisToken = ++renderTokenRef.current;

    const page = await pdfDoc.getPage(mark.page_index + 1);

    // Unrotated base dims (rotation: 0) to interpret normalized coords
    const vp0 = page.getViewport({ scale: 1, rotation: 0 });
    const W = vp0.width;
    const H = vp0.height;

    const rotation = (page.rotate || 0) % 360;
    const { rx, ry, rw, rh, RW, RH } = mapRectToRotation(
      W,
      H,
      { x: mark.nx * W, y: mark.ny * H, w: mark.nw * W, h: mark.nh * H },
      rotation
    );

    const pad = (mark.padding_pct ?? 0.1) * Math.max(rw, rh);
    const containerW = pane.clientWidth;
    const containerH = pane.clientHeight;

    // If not specified (normal flow), compute 150% of fit
    const scale = targetScale ?? computeAutoZoom(containerW, containerH, { rw, rh }, pad, 1.5);

    // Build viewport in the page’s rotation at desired scale
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

    // Abort older renders
    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    if (renderTokenRef.current !== thisToken) return; // superseded

    // Optional: draw a thin highlight (debug)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,0,0,0.85)';
    ctx.lineWidth = Math.max(1, 2 / (window.devicePixelRatio || 1));
    // rect in viewport pixels
    ctx.strokeRect((rx * scale), (ry * scale), (rw * scale), (rh * scale));
    ctx.restore();

    // Center scroll on rect’s center
    const centerX = rx * scale + rw * scale / 2;
    const centerY = ry * scale + rh * scale / 2;

    const targetLeft = clamp(centerX - containerW / 2, 0, Math.max(0, viewport.width - containerW));
    const targetTop = clamp(centerY - containerH / 2, 0, Math.max(0, viewport.height - containerH));

    pane.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });

    currentScaleRef.current = scale;

    // Preload next page to keep Next snappy
    if (pageIndex + 1 < marks.length) {
      pdfDoc.getPage(marks[pageIndex + 1].page_index + 1).catch(() => {});
    }
  };

  // Initial & whenever idx changes
  useEffect(() => {
    if (!pdfDoc || !marks.length) return;
    renderAndCenter(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, marks, idx]);

  // Recompute on resize (debounced)
  useEffect(() => {
    let t: any;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => renderAndCenter(idx), 150);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, marks, idx]);

  // Natural zoom gestures inside the pane
  useEffect(() => {
    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas) return;

    const onWheel = (e: WheelEvent) => {
      // Only zoom when user holds Ctrl/Cmd (trackpad pinch) — do not hijack normal scroll
      if (!(e.ctrlKey || e.metaKey)) return;

      e.preventDefault();

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = clamp(currentScaleRef.current * factor, 0.25, 8);

      // Keep cursor as zoom focal point
      const rect = canvas.getBoundingClientRect();
      const cursorXInCanvas = (e.clientX - rect.left) + pane.scrollLeft;
      const cursorYInCanvas = (e.clientY - rect.top) + pane.scrollTop;

      renderAndCenter(idx, newScale).then(() => {
        const sRatio = newScale / currentScaleRef.current;
        pane.scrollTo({
          left: cursorXInCanvas * sRatio - (e.clientX - rect.left),
          top: cursorYInCanvas * sRatio - (e.clientY - rect.top),
        });
        currentScaleRef.current = newScale;
      });
    };

    pane.addEventListener('wheel', onWheel, { passive: false });
    return () => pane.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, pdfDoc, marks]);

  if (!pdfUrl || !markSetId) {
    return (
      <div style={{ padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
        <h2>PDF Markbook Viewer</h2>
        <p>Add <code>?pdf_url=…&mark_set_id=…</code> to the URL.</p>
      </div>
    );
  }

  if (!marks.length) {
    return (
      <div style={{ padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
        <h3>{status}</h3>
      </div>
    );
  }

  const current = marks[idx];

  return (
    <div style={{ display: 'grid', gridTemplateRows: '56px 1fr', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
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
          {current?.name} ({idx + 1} / {marks.length})
        </div>

        <div style={{ marginLeft: 'auto', color: '#777', fontSize: 13 }}>{status}</div>
      </div>

      {/* Main: left scrollable PDF pane + right marks list */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', height: '100%' }}>
        <div
          ref={paneRef}
          id="pdfPane"
          style={{
            position: 'relative',
            overflow: 'auto',
            background: '#f6f7f9',
            height: '100%',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
            <canvas ref={canvasRef} style={{ display: 'block', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.08)' }} />
          </div>
        </div>

        {/* Marks list */}
        <aside style={{ borderLeft: '1px solid #e5e5e5', overflow: 'auto', background: '#fff' }}>
          <div style={{ padding: 12, position: 'sticky', top: 0, background: '#fff', zIndex: 1, borderBottom: '1px solid #eee' }}>
            <strong>All Marks</strong>
          </div>
          <div style={{ padding: 12 }}>
            {marks.map((m, i) => (
              <button
                key={m.mark_id}
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
          </div>
        </aside>
      </div>
    </div>
  );
}
