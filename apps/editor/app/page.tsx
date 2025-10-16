'use client';

import { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const SAMPLE_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
const API_BASE = 'http://localhost:8000';

interface Mark {
  page_number: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  label?: string;
  order_index: number;
}

interface DrawnRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  rotation: 0 | 90 | 180 | 270;
}

let currentRenderTask: any = null;

export default function Editor() {
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [currentPage, setCurrentPage] = useState<PDFPageProxy | null>(null);
  const [scale, setScale] = useState<number>(1.5);
  const [marks, setMarks] = useState<DrawnRect[]>([]);
  const [drawing, setDrawing] = useState<boolean>(false);
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [savedMarkSetId, setSavedMarkSetId] = useState<string>('');
  const [status, setStatus] = useState<string>('Initializing...');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<DrawnRect[]>([]);

  useEffect(() => {
    marksRef.current = marks;
  }, [marks]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url') || SAMPLE_PDF;
    const user = params.get('user_id') || 'anonymous';

    setPdfUrl(url);
    setUserId(user);
  }, []);

  useEffect(() => {
    if (!pdfUrl) return;

    setStatus('Loading PDF...');
    pdfjsLib.getDocument(pdfUrl).promise
      .then((pdf) => {
        setPdfDoc(pdf);
        setStatus('PDF loaded - Ready to mark');
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err);
        setStatus('Error loading PDF');
      });
  }, [pdfUrl]);

  useEffect(() => {
    if (!pdfDoc || bootstrapped || !pdfUrl) return;

    const bootstrap = async () => {
      try {
        setStatus('Setting up document...');
        
        const docRes = await fetch(`${API_BASE}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf_url: pdfUrl,
            created_by: userId,
          }),
        }).catch(err => {
          console.warn('Document creation failed, continuing anyway:', err);
          return { ok: false, status: 0 };
        });

        let docId = 'temp-' + Date.now();

        if (docRes && docRes.ok) {
          const docData = await docRes.json();
          docId = docData.id;
        } else if (docRes && docRes.status === 409) {
          const docData = await docRes.json();
          docId = docData.id;
        }

        setDocumentId(docId);

        const pages = [];
        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const unrotatedViewport = page.getViewport({ scale: 1, rotation: 0 });
          
          pages.push({
            page_number: i,
            width: unrotatedViewport.width,
            height: unrotatedViewport.height,
            rotation: page.rotate || 0,
          });
        }

        await fetch(`${API_BASE}/documents/${docId}/pages/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages }),
        }).catch(() => {});

        setBootstrapped(true);
        setCurrentPageNum(1);
        setStatus('Ready - Draw rectangles to create marks');
      } catch (err) {
        console.error('Bootstrap error:', err);
        setDocumentId('temp-' + Date.now());
        setBootstrapped(true);
        setStatus('Ready (offline mode)');
      }
    };

    bootstrap();
  }, [pdfDoc, pdfUrl, userId, bootstrapped]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    const renderPage = async () => {
      if (currentRenderTask) {
        currentRenderTask.cancel();
        currentRenderTask = null;
      }

      try {
        const page = await pdfDoc.getPage(currentPageNum);
        setCurrentPage(page);

        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (!context) return;

        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;

        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        currentRenderTask = page.render({
          canvasContext: context,
          viewport: viewport,
        });

        await currentRenderTask.promise;
        currentRenderTask = null;
      } catch (err: any) {
        if (err.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
      }
    };

    renderPage();
  }, [pdfDoc, currentPageNum, scale]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setDrawing(true);
    setStartPos({ x, y });
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawing || !startPos || !overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setCurrentRect({ x: startPos.x, y: startPos.y, width: x - startPos.x, height: y - startPos.y });
  };

  const handleMouseUp = () => {
    if (!drawing || !currentRect || !canvasRef.current || !currentPage) {
      setDrawing(false);
      setCurrentRect(null);
      return;
    }

    const left = Math.min(currentRect.x, currentRect.x + currentRect.width);
    const top = Math.min(currentRect.y, currentRect.y + currentRect.height);
    const right = Math.max(currentRect.x, currentRect.x + currentRect.width);
    const bottom = Math.max(currentRect.y, currentRect.y + currentRect.height);

    const width = right - left;
    const height = bottom - top;

    if (width > 5 && height > 5) {
      const unrotatedViewport = currentPage.getViewport({ scale: 1, rotation: 0 });
      
      setMarks([
        ...marks,
        {
          page: currentPageNum,
          x: left,
          y: top,
          width,
          height,
          pageWidth: unrotatedViewport.width,
          pageHeight: unrotatedViewport.height,
          rotation: (currentPage.rotate || 0) as 0 | 90 | 180 | 270,
        },
      ]);
    }

    setDrawing(false);
    setCurrentRect(null);
    setStartPos(null);
  };

  const handleSave = async () => {
    const currentMarks = marksRef.current;
    
    if (!documentId || currentMarks.length === 0) {
      alert('No marks to save. Draw rectangles on the PDF first.');
      return;
    }

    setSaving(true);
    setStatus(`Saving ${currentMarks.length} marks...`);

    try {
      const apiMarks: Mark[] = currentMarks.map((rect, idx) => {
        const nx0 = rect.x / (scale * rect.pageWidth);
        const ny0 = rect.y / (scale * rect.pageHeight);
        const nx1 = (rect.x + rect.width) / (scale * rect.pageWidth);
        const ny1 = (rect.y + rect.height) / (scale * rect.pageHeight);

        return {
          page_number: rect.page,
          x0: Math.max(0, Math.min(1, nx0)),
          y0: Math.max(0, Math.min(1, ny0)),
          x1: Math.max(0, Math.min(1, nx1)),
          y1: Math.max(0, Math.min(1, ny1)),
          label: `Mark ${idx + 1}`,
          order_index: idx,
        };
      });

      const res = await fetch(`${API_BASE}/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_id: documentId,
          label: 'v1',
          created_by: userId,
          marks: apiMarks,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || 'Failed to save marks');
      }

      const data = await res.json();
      setSavedMarkSetId(data.mark_set_id);
      setStatus(`✓ Saved ${currentMarks.length} marks successfully!`);
      
    } catch (err: any) {
      console.error('Save error:', err);
      alert(`Failed to save marks: ${err.message}`);
      setStatus('Save error');
    } finally {
      setSaving(false);
    }
  };

  const getViewerLink = () => {
    if (!savedMarkSetId) return '';
    return `http://localhost:3002/?pdf_url=${encodeURIComponent(pdfUrl)}&mark_set_id=${savedMarkSetId}`;
  };

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f3f4f6', overflow: 'hidden' }}>
      <div style={{ width: '320px', backgroundColor: 'white', borderRight: '1px solid #d1d5db', overflowY: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px', borderBottom: '1px solid #d1d5db', backgroundColor: '#f9fafb', flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', margin: 0 }}>PDF Marker</h2>
          <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '4px 0 0 0' }}>{status}</p>
        </div>

        <div style={{ padding: '16px', flex: 1, overflow: 'auto' }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '0.875rem', fontWeight: '600', display: 'block', marginBottom: '4px' }}>
              Page {currentPageNum} {pdfDoc && `of ${pdfDoc.numPages}`}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => currentPageNum > 1 && setCurrentPageNum(currentPageNum - 1)}
                disabled={currentPageNum === 1}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: currentPageNum === 1 ? '#e5e7eb' : '#3b82f6',
                  color: currentPageNum === 1 ? '#9ca3af' : 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: currentPageNum === 1 ? 'not-allowed' : 'pointer',
                  fontWeight: '500',
                }}
              >
                ← Prev
              </button>
              <button
                onClick={() => pdfDoc && currentPageNum < pdfDoc.numPages && setCurrentPageNum(currentPageNum + 1)}
                disabled={!pdfDoc || currentPageNum === pdfDoc.numPages}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: !pdfDoc || currentPageNum === pdfDoc.numPages ? '#e5e7eb' : '#3b82f6',
                  color: !pdfDoc || currentPageNum === pdfDoc.numPages ? '#9ca3af' : 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: !pdfDoc || currentPageNum === pdfDoc.numPages ? 'not-allowed' : 'pointer',
                  fontWeight: '500',
                }}
              >
                Next →
              </button>
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '0.875rem', fontWeight: '600', display: 'block', marginBottom: '4px' }}>
              Zoom: {Math.round(scale * 100)}%
            </label>
            <input
              type="range"
              min="50"
              max="200"
              value={scale * 100}
              onChange={(e) => setScale(Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </div>

          <button
            onClick={handleSave}
            disabled={marks.length === 0 || saving}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: marks.length === 0 || saving ? '#d1d5db' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: marks.length === 0 || saving ? 'not-allowed' : 'pointer',
              fontWeight: '600',
              marginBottom: '12px',
            }}
          >
            {saving ? 'Saving...' : `Save ${marks.length} Marks`}
          </button>

          {savedMarkSetId && (
            <a
              href={getViewerLink()}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                padding: '12px',
                backgroundColor: '#3b82f6',
                color: 'white',
                textAlign: 'center',
                textDecoration: 'none',
                borderRadius: '4px',
                fontWeight: '600',
                marginBottom: '16px',
              }}
            >
              🔗 Open in Viewer
            </a>
          )}

          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '8px' }}>
              Marks ({marks.length})
            </h3>
            {marks.length === 0 && (
              <p style={{ fontSize: '0.75rem', color: '#9ca3af', fontStyle: 'italic' }}>
                Draw rectangles on the PDF to create marks
              </p>
            )}
            {marks.map((rect, idx) => (
              <div
                key={idx}
                style={{
                  padding: '10px',
                  backgroundColor: '#f9fafb',
                  borderRadius: '4px',
                  marginBottom: '8px',
                  border: '1px solid #e5e7eb',
                }}
              >
                <div style={{ fontWeight: '600', marginBottom: '6px' }}>
                  Mark {idx + 1} - Page {rect.page}
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => {
                      if (idx === 0) return;
                      const newMarks = [...marks];
                      [newMarks[idx - 1], newMarks[idx]] = [newMarks[idx], newMarks[idx - 1]];
                      setMarks(newMarks);
                    }}
                    disabled={idx === 0}
                    style={{
                      flex: 1,
                      padding: '6px',
                      backgroundColor: idx === 0 ? '#e5e7eb' : '#3b82f6',
                      color: idx === 0 ? '#9ca3af' : 'white',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: idx === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '0.75rem',
                    }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => {
                      if (idx === marks.length - 1) return;
                      const newMarks = [...marks];
                      [newMarks[idx], newMarks[idx + 1]] = [newMarks[idx + 1], newMarks[idx]];
                      setMarks(newMarks);
                    }}
                    disabled={idx === marks.length - 1}
                    style={{
                      flex: 1,
                      padding: '6px',
                      backgroundColor: idx === marks.length - 1 ? '#e5e7eb' : '#3b82f6',
                      color: idx === marks.length - 1 ? '#9ca3af' : 'white',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: idx === marks.length - 1 ? 'not-allowed' : 'pointer',
                      fontSize: '0.75rem',
                    }}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => setMarks(marks.filter((_, i) => i !== idx))}
                    style={{
                      flex: 1,
                      padding: '6px',
                      backgroundColor: '#ef4444',
                      color: 'white',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#525252', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <div style={{ position: 'relative', backgroundColor: 'white', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
          <canvas ref={canvasRef} style={{ display: 'block' }} />

          <div
            ref={overlayRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              cursor: 'crosshair',
            }}
          >
            {marks
              .filter((rect) => rect.page === currentPageNum)
              .map((rect, idx) => (
                <div
                  key={idx}
                  style={{
                    position: 'absolute',
                    left: `${rect.x}px`,
                    top: `${rect.y}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    border: '2px solid #3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    pointerEvents: 'none',
                  }}
                />
              ))}

            {currentRect && (
              <div
                style={{
                  position: 'absolute',
                  left: `${Math.min(currentRect.x, currentRect.x + currentRect.width)}px`,
                  top: `${Math.min(currentRect.y, currentRect.y + currentRect.height)}px`,
                  width: `${Math.abs(currentRect.width)}px`,
                  height: `${Math.abs(currentRect.height)}px`,
                  border: '2px dashed #ef4444',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}