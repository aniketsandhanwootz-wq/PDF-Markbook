'use client';

import { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const SAMPLE_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

interface Mark {
  id: string;
  page_number: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  label: string | null;
  order_index: number;
}

// Single-flight rendering
let currentRenderTask: any = null;

// Rotation-aware coordinate mapping
function mapRectToRotation(
  W: number,
  H: number,
  rect: { x: number; y: number; w: number; h: number },
  rotation: number
): { rx: number; ry: number; rw: number; rh: number; RW: number; RH: number } {
  const { x, y, w, h } = rect;
  let rx: number, ry: number, rw: number, rh: number, RW: number, RH: number;

  switch (rotation) {
    case 90:
      rx = y;
      ry = W - (x + w);
      rw = h;
      rh = w;
      RW = H;
      RH = W;
      break;
    case 180:
      rx = W - (x + w);
      ry = H - (y + h);
      rw = w;
      rh = h;
      RW = W;
      RH = H;
      break;
    case 270:
      rx = H - (y + h);
      ry = x;
      rw = h;
      rh = w;
      RW = H;
      RH = W;
      break;
    default: // 0
      rx = x;
      ry = y;
      rw = w;
      rh = h;
      RW = W;
      RH = H;
  }

  return { rx, ry, rw, rh, RW, RH };
}

export default function Viewer() {
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [markSetId, setMarkSetId] = useState<string>('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState<number>(0);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState<PDFPageProxy | null>(null);
  const [scale, setScale] = useState<number>(1.5);
  const [loading, setLoading] = useState<boolean>(false);
  const [showMarksList, setShowMarksList] = useState<boolean>(true);
  const [demoMode, setDemoMode] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfPaneRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef<number>(0);

  // Parse URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url') || SAMPLE_PDF;
    const msId = params.get('mark_set_id') || '';
    const demo = params.get('demo') === '1';

    setPdfUrl(url);
    setMarkSetId(msId);
    setDemoMode(demo);
  }, []);

  // Fetch marks from API or use demo marks
  useEffect(() => {
    if (demoMode) {
      // Demo marks on pages 1 and 6
      setMarks([
        {
          id: 'demo-1',
          page_number: 1,
          x0: 0.1,
          y0: 0.3,
          x1: 0.5,
          y1: 0.5,
          label: 'Demo Mark 1',
          order_index: 0,
        },
        {
          id: 'demo-2',
          page_number: 6,
          x0: 0.2,
          y0: 0.2,
          x1: 0.6,
          y1: 0.4,
          label: 'Demo Mark 2',
          order_index: 1,
        },
      ]);
      return;
    }

    if (!markSetId) return;

    fetch(`http://localhost:8000/mark-sets/${markSetId}/marks`)
      .then((res) => res.json())
      .then((data) => {
        setMarks(data.marks || []);
      })
      .catch((err) => console.error('Failed to fetch marks:', err));
  }, [markSetId, demoMode]);

  // Load PDF
  useEffect(() => {
    if (!pdfUrl) return;

    setLoading(true);
    pdfjsLib.getDocument(pdfUrl).promise
      .then((pdf) => {
        setPdfDoc(pdf);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err);
        setLoading(false);
      });
  }, [pdfUrl]);

  // Render current mark's page
  useEffect(() => {
    if (!pdfDoc || marks.length === 0) return;

    const currentMark = marks[currentMarkIndex];
    if (!currentMark) return;

    renderMarkPage(currentMark);
  }, [pdfDoc, marks, currentMarkIndex, scale]);

  const renderMarkPage = async (mark: Mark) => {
    if (!pdfDoc || !canvasRef.current || !pdfPaneRef.current) return;

    // Cancel any ongoing render
    if (currentRenderTask) {
      currentRenderTask.cancel();
      currentRenderTask = null;
    }

    // Increment render token
    const thisToken = ++renderTokenRef.current;

    try {
      const page = await pdfDoc.getPage(mark.page_number);
      setCurrentPage(page);

      // Check if this render is still valid
      if (thisToken !== renderTokenRef.current) return;

      const rotation = page.rotate || 0;
      const unrotatedViewport = page.getViewport({ scale: 1, rotation: 0 });
      const W = unrotatedViewport.width;
      const H = unrotatedViewport.height;

      // Map mark rect to rotated space
      const markRect = {
        x: mark.x0 * W,
        y: mark.y0 * H,
        w: (mark.x1 - mark.x0) * W,
        h: (mark.y1 - mark.y0) * H,
      };

      const { rx, ry, rw, rh, RW, RH } = mapRectToRotation(W, H, markRect, rotation);

      // Calculate auto-scale to fit mark with 150% boost
      const paneWidth = pdfPaneRef.current.clientWidth;
      const paneHeight = pdfPaneRef.current.clientHeight;
      const padding = Math.max(rw, rh) * 0.1;
      const fitScale = Math.min(
        paneWidth / (rw + 2 * padding),
        paneHeight / (rh + 2 * padding)
      );
      const targetScale = Math.max(0.25, Math.min(8, fitScale * 1.5));
      setScale(targetScale);

      // Hi-DPI rendering
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: targetScale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      if (!context) return;

      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Start render
      currentRenderTask = page.render({
        canvasContext: context,
        viewport: viewport,
      });

      await currentRenderTask.promise;
      currentRenderTask = null;

      // Check again if still valid
      if (thisToken !== renderTokenRef.current) return;

      // Center the mark in the pane
      const centerX = rx * targetScale + (rw * targetScale) / 2;
      const centerY = ry * targetScale + (rh * targetScale) / 2;

      const maxLeft = Math.max(0, viewport.width - paneWidth);
      const maxTop = Math.max(0, viewport.height - paneHeight);

      const targetLeft = Math.max(0, Math.min(maxLeft, centerX - paneWidth / 2));
      const targetTop = Math.max(0, Math.min(maxTop, centerY - paneHeight / 2));

      pdfPaneRef.current.scrollTo({
        left: targetLeft,
        top: targetTop,
        behavior: 'smooth',
      });

      // Preload next page for snappy navigation
      if (currentMarkIndex < marks.length - 1) {
        const nextMark = marks[currentMarkIndex + 1];
        pdfDoc.getPage(nextMark.page_number).catch(() => {});
      }
    } catch (err: any) {
      if (err.name !== 'RenderingCancelledException') {
        console.error('Render error:', err);
      }
    }
  };

  const handlePrevious = () => {
    if (currentMarkIndex > 0) {
      setCurrentMarkIndex(currentMarkIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentMarkIndex < marks.length - 1) {
      setCurrentMarkIndex(currentMarkIndex + 1);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey || !canvasRef.current || !pdfPaneRef.current) return;

    e.preventDefault();

    const delta = e.deltaY;
    const zoomFactor = delta > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.25, Math.min(8, scale * zoomFactor));

    // Zoom at cursor point
    const rect = pdfPaneRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const scrollX = pdfPaneRef.current.scrollLeft;
    const scrollY = pdfPaneRef.current.scrollTop;

    const pointX = x + scrollX;
    const pointY = y + scrollY;

    const ratioX = pointX / (canvasRef.current.offsetWidth || 1);
    const ratioY = pointY / (canvasRef.current.offsetHeight || 1);

    setScale(newScale);

    // Adjust scroll to keep point stable
    setTimeout(() => {
      if (canvasRef.current && pdfPaneRef.current) {
        const newPointX = ratioX * canvasRef.current.offsetWidth;
        const newPointY = ratioY * canvasRef.current.offsetHeight;

        pdfPaneRef.current.scrollLeft = newPointX - x;
        pdfPaneRef.current.scrollTop = newPointY - y;
      }
    }, 0);
  };

  const jumpToMark = (index: number) => {
    setCurrentMarkIndex(index);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#f3f4f6' }}>
        <div style={{ fontSize: '1.25rem' }}>Loading PDF...</div>
      </div>
    );
  }

  const currentMark = marks[currentMarkIndex];

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f3f4f6', overflow: 'hidden' }}>
      {/* Marks Sidebar */}
      {showMarksList && (
        <div style={{ width: '320px', backgroundColor: 'white', borderRight: '1px solid #d1d5db', overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ padding: '16px', borderBottom: '1px solid #d1d5db', backgroundColor: '#f9fafb' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', margin: 0 }}>Marks</h2>
            <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: '4px 0 0 0' }}>
              {marks.length} total {demoMode && '(Demo)'}
            </p>
          </div>

          <div>
            {marks.map((mark, idx) => (
              <div
                key={mark.id}
                onClick={() => jumpToMark(idx)}
                style={{
                  padding: '12px',
                  cursor: 'pointer',
                  backgroundColor: idx === currentMarkIndex ? '#dbeafe' : 'white',
                  borderLeft: idx === currentMarkIndex ? '4px solid #3b82f6' : '4px solid transparent',
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '600', fontSize: '0.875rem' }}>Mark {idx + 1}</div>
                    {mark.label && (
                      <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px' }}>{mark.label}</div>
                    )}
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '4px' }}>Page {mark.page_number}</div>
                  </div>
                  {idx === currentMarkIndex && (
                    <div style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#3b82f6' }}>CURRENT</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ backgroundColor: 'white', borderBottom: '1px solid #d1d5db', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              onClick={() => setShowMarksList(!showMarksList)}
              style={{
                padding: '8px 12px',
                backgroundColor: '#e5e7eb',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: '500',
              }}
            >
              {showMarksList ? '◀ Hide' : '▶ Show'} List
            </button>

            {currentMark && (
              <div style={{ fontSize: '0.875rem' }}>
                <span style={{ fontWeight: '600' }}>Mark {currentMarkIndex + 1}</span>
                <span style={{ color: '#6b7280' }}> of {marks.length}</span>
                {currentMark.label && <span style={{ marginLeft: '8px', color: '#6b7280' }}>({currentMark.label})</span>}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={handlePrevious}
              disabled={currentMarkIndex === 0}
              style={{
                padding: '8px 16px',
                backgroundColor: currentMarkIndex === 0 ? '#d1d5db' : '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: currentMarkIndex === 0 ? 'not-allowed' : 'pointer',
                fontWeight: '500',
              }}
            >
              ← Previous
            </button>
            <button
              onClick={handleNext}
              disabled={currentMarkIndex >= marks.length - 1}
              style={{
                padding: '8px 16px',
                backgroundColor: currentMarkIndex >= marks.length - 1 ? '#d1d5db' : '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: currentMarkIndex >= marks.length - 1 ? 'not-allowed' : 'pointer',
                fontWeight: '500',
              }}
            >
              Next →
            </button>
            <div style={{ marginLeft: '16px', padding: '8px 12px', backgroundColor: '#d1fae5', color: '#065f46', borderRadius: '4px', fontSize: '0.875rem', fontWeight: '600', border: '1px solid #6ee7b7' }}>
              Zoom: {Math.round(scale * 100)}%
            </div>
          </div>
        </div>

        {/* PDF Pane - scrollable */}
        <div
          ref={pdfPaneRef}
          onWheel={handleWheel}
          style={{
            flex: 1,
            overflow: 'auto',
            backgroundColor: '#525252',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div style={{ position: 'relative' }}>
            <canvas ref={canvasRef} style={{ display: 'block', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
            
            {/* Highlight overlay */}
            {currentMark && currentPage && (() => {
              const rotation = currentPage.rotate || 0;
              const unrotatedViewport = currentPage.getViewport({ scale: 1, rotation: 0 });
              const W = unrotatedViewport.width;
              const H = unrotatedViewport.height;

              const markRect = {
                x: currentMark.x0 * W,
                y: currentMark.y0 * H,
                w: (currentMark.x1 - currentMark.x0) * W,
                h: (currentMark.y1 - currentMark.y0) * H,
              };

              const { rx, ry, rw, rh } = mapRectToRotation(W, H, markRect, rotation);

              return (
                <div
                  style={{
                    position: 'absolute',
                    left: `${rx * scale}px`,
                    top: `${ry * scale}px`,
                    width: `${rw * scale}px`,
                    height: `${rh * scale}px`,
                    border: '4px solid #ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                    pointerEvents: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}