'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';
const DEMO_PDF =
  'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

type Mark = {
  mark_id?: string;
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  zoom_hint?: number | null;
  padding_pct?: number;
  anchor?: string;
};

export default function ViewerPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const isDemo = params.get('demo') === '1';
  const [pdfUrl] = useState(params.get('pdf_url') || (isDemo ? DEMO_PDF : ''));
  const [markSetId] = useState<string | null>(
    params.get('mark_set_id') || null
  );

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);

  const [marks, setMarks] = useState<Mark[]>([]);
  const [idx, setIdx] = useState(0); // current mark index
  const [scale, setScale] = useState(1.0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [status, setStatus] = useState('Loading marks…');

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // demo marks if ?demo=1
  useEffect(() => {
    (async () => {
      try {
        // load the pdf
        const task = pdfjsLib.getDocument({
          url: pdfUrl || DEMO_PDF,
          isEvalSupported: false,
          withCredentials: false,
        });
        const pdf = await task.promise;
        setPdfDoc(pdf);
        setPageCount(pdf.numPages);

        // fetch marks
        if (markSetId) {
          const r = await fetch(`${API_BASE}/mark-sets/${markSetId}/marks`);
          if (!r.ok) throw new Error(await r.text());
          const list = await r.json();
          setMarks(list);
          setStatus('Ready');
          setIdx(0);
        } else {
          // demo: two marks (page 1 header; page 6 figure)
          setMarks([
            {
              page_index: 0,
              order_index: 0,
              name: 'Demo Mark on Page 1',
              nx: 0.12,
              ny: 0.09,
              nw: 0.76,
              nh: 0.18,
              padding_pct: 0.1,
            },
            {
              page_index: 5,
              order_index: 1,
              name: 'Demo Mark on Page 6',
              nx: 0.08,
              ny: 0.42,
              nw: 0.52,
              nh: 0.33,
              padding_pct: 0.08,
            },
          ]);
          setStatus('Ready (demo)');
          setIdx(0);
        }
      } catch (e: any) {
        console.error(e);
        setStatus('Error: ' + e.message);
      }
    })();
  }, [pdfUrl, markSetId]);

  // render current mark’s page at given scale, then center on bbox
  const renderPageAndCenter = useCallback(
    async (mk: Mark, targetScale?: number) => {
      if (!pdfDoc || !mk) return;

      const page = await pdfDoc.getPage(mk.page_index + 1);
      const newScale = targetScale ?? scale;
      const viewport = page.getViewport({ scale: newScale });

      const canvas = canvasRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;

      // center scroll on bbox with padding
      const pad = mk.padding_pct ?? 0.1;
      const x = mk.nx * viewport.width;
      const y = mk.ny * viewport.height;
      const w = mk.nw * viewport.width;
      const h = mk.nh * viewport.height;

      const cx = x + w / 2;
      const cy = y + h / 2;

      const sc = scrollRef.current!;
      // scroll so that (cx,cy) sits at the center of the visible area
      const targetLeft = Math.max(0, cx - sc.clientWidth / 2);
      const targetTop = Math.max(0, cy - sc.clientHeight / 2);

      sc.scrollTo({
        left: targetLeft,
        top: targetTop,
        behavior: 'instant' as ScrollBehavior, // snappy
      });

      // draw a subtle overlay to indicate region
      const overlay = canvas.getContext('2d')!;
      overlay.save();
      overlay.strokeStyle = 'rgba(255,59,48,0.9)';
      overlay.fillStyle = 'rgba(255,59,48,0.15)';
      overlay.lineWidth = 3;
      overlay.beginPath();
      overlay.rect(x - w * pad, y - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad));
      overlay.fill();
      overlay.stroke();
      overlay.restore();
    },
    [pdfDoc, scale]
  );

  // jump to current mark at 150%
  useEffect(() => {
    if (!marks.length || !pdfDoc) return;
    const mk = marks[idx];
    const zoom = Math.max(1.5, mk.zoom_hint || 1.5);
    setScale(zoom); // keep state in sync
    renderPageAndCenter(mk, zoom);
  }, [idx, marks, pdfDoc, renderPageAndCenter]);

  // zoom controls only affect canvas (not the whole UI)
  const zoomBy = (delta: number) => {
    const s = Math.max(0.5, Math.min(6, +(scale + delta).toFixed(2)));
    setScale(s);
    if (marks[idx]) renderPageAndCenter(marks[idx], s);
  };

  // wheel + ctrl/⌘ = zoom
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? -0.1 : 0.1);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: panelOpen ? '320px 1fr' : '1fr',
        height: '100vh',
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      {/* Left panel */}
      {panelOpen && (
        <aside
          style={{
            borderRight: '1px solid #eee',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: '1px solid #f0f0f0',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <button onClick={() => setPanelOpen(false)}>Hide List</button>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: '#666' }}>
              {status}
            </div>
          </div>

          <div style={{ padding: 12, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={idx <= 0}
              >
                ← Previous
              </button>
              <button
                onClick={() => setIdx((i) => Math.min(marks.length - 1, i + 1))}
                disabled={idx >= marks.length - 1}
              >
                Next →
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => zoomBy(-0.1)}>-</button>
              <div
                style={{
                  flex: 1,
                  textAlign: 'center',
                  lineHeight: '28px',
                  border: '1px solid #eee',
                  borderRadius: 6,
                  background: '#fafafa',
                  fontSize: 12,
                }}
              >
                {Math.round(scale * 100)}%
              </div>
              <button onClick={() => zoomBy(0.1)}>+</button>
            </div>

            <div style={{ fontWeight: 600, fontSize: 14 }}>All Marks</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {marks.map((m, i) => (
                <div
                  key={i}
                  onClick={() => setIdx(i)}
                  style={{
                    border: '1px solid ' + (i === idx ? '#0d6efd' : '#eee'),
                    padding: 10,
                    borderRadius: 8,
                    background: i === idx ? '#eff6ff' : '#fff',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    Page {m.page_index + 1}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}

      {/* PDF canvas area */}
      <main
        ref={scrollRef}
        onWheel={onWheel}
        style={{
          position: 'relative',
          overflow: 'auto',
          background: '#f7f7f7',
          padding: 16,
          height: '100%',
          touchAction: 'pan-x pan-y', // allow scrolling; avoid browser-pinch zoom on mobile
        }}
      >
        {!panelOpen && (
          <div style={{ position: 'sticky', top: 12, zIndex: 10 }}>
            <button onClick={() => setPanelOpen(true)}>Show List</button>
          </div>
        )}

        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <button
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={idx <= 0}
          >
            ← Previous
          </button>
          <button
            onClick={() => setIdx((i) => Math.min(marks.length - 1, i + 1))}
            disabled={idx >= marks.length - 1}
          >
            Next →
          </button>
        </div>

        <div style={{ position: 'relative', display: 'inline-block' }}>
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              background: 'white',
              border: '1px solid #ddd',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}
          />
        </div>
      </main>
    </div>
  );
}
