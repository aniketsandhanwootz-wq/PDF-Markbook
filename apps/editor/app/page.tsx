'use client';

import { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const SAMPLE_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

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
}

let currentRenderTask: any = null;

export default function Editor() {
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [currentPage, setCurrentPage] = useState<PDFPageProxy | null>(null);
  const [scale, setScale] = useState<number>(1.5);
  const [rects, setRects] = useState<DrawnRect[]>([]);
  const [drawing, setDrawing] = useState<boolean>(false);
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [toast, setToast] = useState<string>('');
  const [savedMarkSetId, setSavedMarkSetId] = useState<string>('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef<number>(0);

  // Parse URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url') || SAMPLE_PDF;
    const user = params.get('user_id') || 'test-user';

    setPdfUrl(url);
    setUserId(user);
  }, []);

  // Load PDF
  useEffect(() => {
    if (!pdfUrl) return;

    pdfjsLib.getDocument(pdfUrl).promise
      .then((pdf) => {
        setPdfDoc(pdf);
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err);
      });
  }, [pdfUrl]);

  // Bootstrap document when PDF loads
  useEffect(() => {
    if (!pdfDoc || bootstrapped || !pdfUrl) return;

    const bootstrap = async () => {
      try {
        // Create document
        const docRes = await fetch('http://localhost:8000/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdf_url: pdfUrl,
            user_id: userId,
          }),
        });

        let docData;
        if (docRes.status === 409) {
          // Document exists
          docData = await docRes.json();
        } else if (docRes.ok) {
          docData = await docRes.json();
        } else {
          throw new Error('Failed to create document');
        }

        setDocumentId(docData.id);

        // Bootstrap pages
        const pages = [];
        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 1, rotation: 0 });
          pages.push({
            page_number: i,
            width: viewport.width,
            height: viewport.height,
            rotation: page.rotate || 0,
          });
        }

        await fetch(`http://localhost:8000/documents/${docData.id}/pages/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages }),
        }).catch(() => {}); // Ignore 409

        setBootstrapped(true);
        setCurrentPageNum(1);
      } catch (err) {
        console.error('Bootstrap error:', err);
      }
    };

    bootstrap();
  }, [pdfDoc, pdfUrl, userId, bootstrapped]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    const renderPage = async () => {
      if (currentRenderTask) {
        currentRenderTask.cancel();
        currentRenderTask = null;
      }

      const thisToken = ++renderTokenRef.current;

      try {
        const page = await pdfDoc.getPage(currentPageNum);
        setCurrentPage(page);

        if (thisToken !== renderTokenRef.current) return;

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

    const width = x - startPos.x;
    const height = y - startPos.y;

    setCurrentRect({ x: startPos.x, y: startPos.y, width, height });
  };

  const handleMouseUp = () => {
    if (!drawing || !currentRect || !canvasRef.current || !currentPage) {
      setDrawing(false);
      setCurrentRect(null);
      return;
    }

    const canvasWidth = canvasRef.current.offsetWidth;
    const canvasHeight = canvasRef.current.offsetHeight;

    // Normalize rect
    const left = Math.min(currentRect.x, currentRect.x + currentRect.width);
    const top = Math.min(currentRect.y, currentRect.y + currentRect.height);
    const right = Math.max(currentRect.x, currentRect.x + currentRect.width);
    const bottom = Math.max(currentRect.y, currentRect.y + currentRect.height);

    const width = right - left;
    const height = bottom - top;

    if (width > 5 && height > 5) {
      // Save rect
      const unrotatedViewport = currentPage.getViewport({ scale: 1, rotation: 0 });
      setRects([
        ...rects,
        {
          page: currentPageNum,
          x: left,
          y: top,
          width,
          height,
          pageWidth: unrotatedViewport.width,
          pageHeight: unrotatedViewport.height,
        },
      ]);
    }

    setDrawing(false);
    setCurrentRect(null);
    setStartPos(null);
  };

  const handlePrevPage = () => {
    if (currentPageNum > 1) {
      setCurrentPageNum(currentPageNum - 1);
    }
  };

  const handleNextPage = () => {
    if (pdfDoc && currentPageNum < pdfDoc.numPages) {
      setCurrentPageNum(currentPageNum + 1);
    }
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newRects = [...rects];
    [newRects[index - 1], newRects[index]] = [newRects[index], newRects[index - 1]];
    setRects(newRects);
  };

  const handleMoveDown = (index: number) => {
    if (index === rects.length - 1) return;
    const newRects = [...rects];
    [newRects[index], newRects[index + 1]] = [newRects[index + 1], newRects[index]];
    setRects(newRects);
  };

  const handleDelete = (index: number) => {
    setRects(rects.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!documentId || rects.length === 0) {
      alert('No marks to save');
      return;
    }

    setSaving(true);

    try {
      const marks: Mark[] = rects.map((rect, idx) => ({
        page_number: rect.page,
        x0: rect.x / (rect.pageWidth * scale),
        y0: rect.y / (rect.pageHeight * scale),
        x1: (rect.x + rect.width) / (rect.pageWidth * scale),
        y1: (rect.y + rect.height) / (rect.pageHeight * scale),
        label: `Mark ${idx + 1}`,
        order_index: idx,
      }));

      const res = await fetch('http://localhost:8000/mark-sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_id: documentId,
          user_id: userId,
          marks,
        }),
      });

      if (!res.ok) throw new Error('Failed to save marks');

      const data = await res.json();
      setSavedMarkSetId(data.mark_set_id);
      
      setToast(`Saved ${rects.length} marks! Click to open in Viewer.`);
      setTimeout(() => setToast(''), 5000);
    } catch (err) {
      console.error('Save error:', err);
      alert('Failed to save marks');
    } finally {
      setSaving(false);
    }
  };

  const openViewer = () => {
    if (!savedMarkSetId) return;
    const viewerUrl = `http://localhost:3002/?pdf_url=${encodeURIComponent(pdfUrl)}&mark_set_id=${savedMarkSetId}`;
    window.open(viewerUrl, '_blank');
  };

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f3f4f6', overflow: 'hidden' }}>
      {/* Left Panel - Controls */}
      <div style={{ width: '320px', backgroundColor: 'white', borderRight: '1px solid #d1d5db', overflowY: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '16px', borderBottom: '1px solid #d1d5db', backgroundColor: '#f9fafb' }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', margin: 0 }}>PDF Marker</h2>
          <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: '4px 0 0 0' }}>Draw rectangles to mark areas</p>
        </div>

        <div style={{ padding: '16px' }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '0.875rem', fontWeight: '600', display: 'block', marginBottom: '4px' }}>
              Page {currentPageNum} {pdfDoc && `of ${pdfDoc.numPages}`}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handlePrevPage}
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
                onClick={handleNextPage}
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
            disabled={rects.length === 0 || saving}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: rects.length === 0 || saving ? '#d1d5db' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: rects.length === 0 || saving ? 'not-allowed' : 'pointer',
              fontWeight: '600',
              fontSize: '0.875rem',
              marginBottom: '16px',
            }}
          >
            {saving ? 'Saving...' : `Save ${rects.length} Marks`}
          </button>

          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '8px' }}>
              Marks ({rects.length})
            </h3>
            {rects.map((rect, idx) => (
              <div
                key={idx}
                style={{
                  padding: '8px',
                  backgroundColor: '#f9fafb',
                  borderRadius: '4px',
                  marginBottom: '8px',
                  fontSize: '0.75rem',
                }}
              >
                <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                  Mark {idx + 1} - Page {rect.page}
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => handleMoveUp(idx)}
                    disabled={idx === 0}
                    style={{
                      padding: '4px 8px',
                      backgroundColor: idx === 0 ? '#e5e7eb' : '#3b82f6',
                      color: idx === 0 ? '#9ca3af' : 'white',
                      border: 'none',
                      borderRadius: '2px',
                      cursor: idx === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '0.7rem',
                    }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => handleMoveDown(idx)}
                    disabled={idx === rects.length - 1}
                    style={{
                      padding: '4px 8px',
                      backgroundColor: idx === rects.length - 1 ? '#e5e7eb' : '#3b82f6',
                      color: idx === rects.length - 1 ? '#9ca3af' : 'white',
                      border: 'none',
                      borderRadius: '2px',
                      cursor: idx === rects.length - 1 ? 'not-allowed' : 'pointer',
                      fontSize: '0.7rem',
                    }}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => handleDelete(idx)}
                    style={{
                      padding: '4px 8px',
                      backgroundColor: '#ef4444',
                      color: 'white',
                      border: 'none',
                      borderRadius: '2px',
                      cursor: 'pointer',
                      fontSize: '0.7rem',
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

      {/* Right Panel - Canvas */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#525252', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ position: 'relative' }}>
            <canvas ref={canvasRef} style={{ display: 'block', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />

            {/* Drawing overlay */}
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
              {/* Show saved rects on current page */}
              {rects
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
                      backgroundColor: 'rgba(59, 130, 246, 0.2)',
                      pointerEvents: 'none',
                    }}
                  />
                ))}

              {/* Show current drawing rect */}
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

      {/* Toast notification */}
      {toast && (
        <div
          onClick={openViewer}
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            padding: '16px 20px',
            backgroundColor: '#10b981',
            color: 'white',
            borderRadius: '8px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '0.875rem',
            zIndex: 1000,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}