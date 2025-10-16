'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';
const DEMO_PDF =
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
  width_pt: number;
  height_pt: number;
  rotation_deg: number;
};

export default function EditorPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const isDemo = params.get('demo') === '1';
  const [pdfUrl, setPdfUrl] = useState(
    params.get('pdf_url') || (isDemo ? DEMO_PDF : '')
  );
  const [userId] = useState(params.get('user_id') || 'anonymous');

  const [docId, setDocId] = useState('');
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [status, setStatus] = useState('');
  const [pageDims, setPageDims] = useState<PageDim[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [curr, setCurr] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // quick helper for demo link
  const useSample = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('pdf_url');
    url.searchParams.set('demo', '1');
    window.location.href = url.toString();
  };

  // bootstrap: create doc, load pdf, send page dims
  useEffect(() => {
    (async () => {
      if (!pdfUrl) return;

      try {
        setStatus('Creating document…');

        // 1) create document
        const r = await fetch(`${API_BASE}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdf_url: pdfUrl, created_by: userId }),
        });
        if (!r.ok) throw new Error(await r.text());
        const { doc_id } = await r.json();
        setDocId(doc_id);

        // 2) load pdf
        setStatus('Loading PDF…');
        const task = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: false,
          isEvalSupported: false,
        });
        const pdf = await task.promise;
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);

        // 3) collect dims (unrotated base + rotation)
        setStatus('Collecting page dimensions…');
        const dims: PageDim[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1, rotation: 0 });
          dims.push({
            idx: i - 1,
            width_pt: vp.width,
            height_pt: vp.height,
            rotation_deg: (page.rotate || 0) % 360,
          });
        }
        setPageDims(dims);

        // 4) POST bootstrap (ignore 409)
        setStatus('Bootstrapping pages…');
        const b = await fetch(
          `${API_BASE}/documents/${doc_id}/pages/bootstrap`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_count: pdf.numPages, dims }),
          }
        );
        if (!(b.ok || b.status === 409)) {
          throw new Error('Bootstrap failed: ' + (await b.text()));
        }

        setStatus('Ready');
        setCurrentPage(1);
      } catch (e: any) {
        console.error(e);
        setStatus('Error: ' + e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  // render current page
  useEffect(() => {
    (async () => {
      if (!pdfDoc || !currentPage) return;
      const page = await pdfDoc.getPage(currentPage);
      const scale = 1.6; // crisp drawing without CSS scaling
      const viewport = page.getViewport({ scale });

      const canvas = canvasRef.current!;
      const overlay = overlayRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      overlay.width = viewport.width;
      overlay.height = viewport.height;

      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;

      // clear overlay
      overlay.getContext('2d')!.clearRect(0, 0, overlay.width, overlay.height);
    })();
  }, [pdfDoc, currentPage]);

  // drawing handlers
  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    setIsDrawing(true);
    setStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setCurr({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !start) return;
    const rect = overlayRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCurr({ x, y });

    const ctx = overlayRef.current!.getContext('2d')!;
    ctx.clearRect(0, 0, overlayRef.current!.width, overlayRef.current!.height);
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 2;
    ctx.strokeRect(start.x, start.y, x - start.x, y - start.y);
  };

  const onUp = async () => {
    if (!isDrawing || !start || !curr) return;
    setIsDrawing(false);

    overlayRef.current!.getContext('2d')!.clearRect(
      0,
      0,
      overlayRef.current!.width,
      overlayRef.current!.height
    );

    const name = window.prompt('Name this mark:');
    if (!name) return;

    // convert to normalized coords in unscaled page space
    const scale = 1.6;
    const pd = pageDims[currentPage - 1];
    const x1 = Math.min(start.x, curr.x) / scale;
    const y1 = Math.min(start.y, curr.y) / scale;
    const x2 = Math.max(start.x, curr.x) / scale;
    const y2 = Math.max(start.y, curr.y) / scale;

    const nx = Math.max(0, Math.min(1, x1 / pd.width_pt));
    const ny = Math.max(0, Math.min(1, y1 / pd.height_pt));
    const nw = Math.max(0.01, Math.min(1 - nx, (x2 - x1) / pd.width_pt));
    const nh = Math.max(0.01, Math.min(1 - ny, (y2 - y1) / pd.height_pt));

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

    setStart(null);
    setCurr(null);
  };

  const saveMarks = async () => {
    if (marks.length === 0) return alert('No marks to save');
    try {
      setStatus('Saving…');

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

      setStatus('Saved');
      await navigator.clipboard.writeText(
        `${location.origin.replace(':3001', ':3002')}?pdf_url=${encodeURIComponent(
          pdfUrl
        )}&mark_set_id=${mark_set_id}`
      );
      alert(
        `Saved! mark_set_id=${mark_set_id}\n\nCopied a viewer link to clipboard.`
      );
    } catch (e: any) {
      console.error(e);
      alert('Failed to save: ' + e.message);
      setStatus('Error');
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        height: '100vh',
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      {/* Left rail */}
      <aside
        style={{
          borderRight: '1px solid #eee',
          padding: 12,
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
          >
            ← Prev
          </button>
          <div style={{ fontSize: 13 }}>
            Page {currentPage} of {totalPages}
          </div>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
          >
            Next →
          </button>
          <a
            onClick={useSample}
            style={{ marginLeft: 'auto', fontSize: 12, cursor: 'pointer' }}
          >
            use sample
          </a>
        </div>

        <div style={{ marginTop: 12 }}>
          <button
            onClick={saveMarks}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: '#0d6efd',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
            }}
          >
            Save {marks.length} Marks
          </button>
        </div>

        <div style={{ marginTop: 16, color: '#666', fontSize: 12 }}>
          <div>Status: {status || '—'}</div>
        </div>

        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: 0, fontSize: 14 }}>Marks ({marks.length})</h4>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {marks.map((m) => (
              <div
                key={m.order_index}
                style={{
                  border: '1px solid #ddd',
                  padding: 8,
                  borderRadius: 6,
                  background: '#fff',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div style={{ color: '#666', fontSize: 12 }}>
                  Page {m.page_index + 1}, Order {m.order_index}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
          <b>Instructions:</b> Click and drag to draw a rectangle. You’ll be
          prompted to name it.
        </p>
      </aside>

      {/* PDF area */}
      <main
        style={{
          overflow: 'auto',
          background: '#f7f7f7',
          padding: 16,
          height: '100%',
        }}
      >
        {!pdfUrl && (
          <div style={{ color: '#666' }}>
            Add <code>?pdf_url=YOUR_PDF_URL</code> or click{' '}
            <a onClick={useSample} style={{ cursor: 'pointer' }}>
              use sample
            </a>
            .
          </div>
        )}

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
          <canvas
            ref={overlayRef}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            style={{
              position: 'absolute',
              inset: 0,
              cursor: 'crosshair',
            }}
          />
        </div>
      </main>
    </div>
  );
}
