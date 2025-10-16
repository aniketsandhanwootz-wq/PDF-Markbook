'use client';

import { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const SAMPLE_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
const API_BASE = 'http://localhost:8000';

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

let currentRenderTasks: Map<number, any> = new Map();

export default function Viewer() {
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [markSetId, setMarkSetId] = useState<string>('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState<number>(0);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState<number>(1.2);
  const [loading, setLoading] = useState<boolean>(false);
  const [showMarksList, setShowMarksList] = useState<boolean>(true);
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('Initializing...');
  const [numPages, setNumPages] = useState<number>(0);
  const [renderComplete, setRenderComplete] = useState<boolean>(false);

  const pdfPaneRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollTimeoutRef = useRef<any>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url') || SAMPLE_PDF;
    const msId = params.get('mark_set_id') || '';
    const demo = params.get('demo') === '1';

    setPdfUrl(url);
    setMarkSetId(msId);
    setDemoMode(demo);
  }, []);

  useEffect(() => {
    if (demoMode) {
      setMarks([
        {
          id: 'demo-1',
          page_number: 1,
          x0: 0.1,
          y0: 0.3,
          x1: 0.5,
          y1: 0.5,
          label: 'Demo Mark on Page 1',
          order_index: 0,
        },
        {
          id: 'demo-2',
          page_number: 6,
          x0: 0.2,
          y0: 0.2,
          x1: 0.6,
          y1: 0.4,
          label: 'Demo Mark on Page 6',
          order_index: 1,
        },
      ]);
      setStatus('Demo mode - 2 marks');
      return;
    }

    if (!markSetId) return;

    setStatus('Fetching marks...');
    fetch(`${API_BASE}/mark-sets/${markSetId}/marks`)
      .then((res) => res.json())
      .then((data) => {
        setMarks(data.marks || []);
        setStatus(`Ready - ${data.marks?.length || 0} marks`);
      })
      .catch((err) => {
        console.error('Failed to fetch marks:', err);
        setStatus('Error loading marks');
      });
  }, [markSetId, demoMode]);

  useEffect(() => {
    if (!pdfUrl) return;

    setLoading(true);
    setStatus('Loading PDF...');
    pdfjsLib.getDocument(pdfUrl).promise
      .then((pdf) => {
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
        setLoading(false);
        setStatus('PDF loaded');
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err);
        setLoading(false);
        setStatus('Error loading PDF');
      });
  }, [pdfUrl]);

  useEffect(() => {
    if (!pdfDoc || numPages === 0) return;

    const renderAllPages = async () => {
      setRenderComplete(false);
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        await renderPage(pageNum);
      }
      setRenderComplete(true);
    };

    renderAllPages();
  }, [pdfDoc, numPages, scale]);

  const renderPage = async (pageNum: number) => {
    if (!pdfDoc) return;

    const canvas = canvasRefs.current.get(pageNum);
    if (!canvas) return;

    const existingTask = currentRenderTasks.get(pageNum);
    if (existingTask) {
      existingTask.cancel();
      currentRenderTasks.delete(pageNum);
    }

    try {
      const page = await pdfDoc.getPage(pageNum);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext('2d');

      if (!context) return;

      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const renderTask = page.render({
        canvasContext: context,
        viewport: viewport,
      });

      currentRenderTasks.set(pageNum, renderTask);
      await renderTask.promise;
      currentRenderTasks.delete(pageNum);
    } catch (err: any) {
      if (err.name !== 'RenderingCancelledException') {
        console.error(`Render error page ${pageNum}:`, err);
      }
    }
  };

  // Zoom to current mark when it changes
  useEffect(() => {
    if (!pdfDoc || marks.length === 0 || !pdfPaneRef.current) return;

    const currentMark = marks[currentMarkIndex];
    if (!currentMark) return;

    zoomAndScrollToMark(currentMark);
  }, [currentMarkIndex, marks, pdfDoc]);

  // Scroll after render complete
  useEffect(() => {
    if (!renderComplete || marks.length === 0) return;
    
    const currentMark = marks[currentMarkIndex];
    if (!currentMark) return;

    // Small delay to ensure DOM has updated
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    scrollTimeoutRef.current = setTimeout(() => {
      scrollToMarkCenter(currentMark);
    }, 150);

    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [renderComplete, currentMarkIndex]);

  const zoomAndScrollToMark = async (mark: Mark) => {
    if (!pdfDoc || !pdfPaneRef.current) return;

    try {
      const page = await pdfDoc.getPage(mark.page_number);
      const baseViewport = page.getViewport({ scale: 1 });

      // Calculate mark dimensions in page units
      const markWidth = (mark.x1 - mark.x0) * baseViewport.width;
      const markHeight = (mark.y1 - mark.y0) * baseViewport.height;

      // Get pane dimensions
      const paneWidth = pdfPaneRef.current.clientWidth - 100;
      const paneHeight = pdfPaneRef.current.clientHeight - 100;

      // Calculate scale to fit mark with padding
      const padding = 0.2; // 20% padding
      const scaleX = paneWidth / (markWidth * (1 + 2 * padding));
      const scaleY = paneHeight / (markHeight * (1 + 2 * padding));
      const fitScale = Math.min(scaleX, scaleY);

      // Apply 150% boost, clamped to reasonable limits
      const newScale = Math.max(1.2, Math.min(3.5, fitScale * 1.5));

      setScale(newScale);
      setStatus(`Zooming to: ${mark.label || `Mark ${currentMarkIndex + 1}`}`);
    } catch (err) {
      console.error('Zoom error:', err);
    }
  };

  const scrollToMarkCenter = (mark: Mark) => {
    if (!pdfPaneRef.current || !pdfDoc) return;

    try {
      const canvas = canvasRefs.current.get(mark.page_number);
      if (!canvas) return;

      // Calculate mark center in canvas coordinates
      const markCenterX = ((mark.x0 + mark.x1) / 2) * canvas.offsetWidth;
      const markCenterY = ((mark.y0 + mark.y1) / 2) * canvas.offsetHeight;

      // Calculate total offset from top of scrollable area
      let offsetTop = 0;
      for (let i = 1; i < mark.page_number; i++) {
        const prevCanvas = canvasRefs.current.get(i);
        if (prevCanvas) {
          offsetTop += prevCanvas.offsetHeight + 20; // 20px gap between pages
        }
      }

      // Add the Y position within the current page
      offsetTop += markCenterY;

      // Calculate scroll position to center the mark
      const paneHeight = pdfPaneRef.current.clientHeight;
      const paneWidth = pdfPaneRef.current.clientWidth;
      
      const scrollTop = offsetTop - (paneHeight / 2);
      const scrollLeft = markCenterX - (paneWidth / 2);

      // Get the page container to account for centering
      const pageContainer = pageContainerRefs.current.get(mark.page_number);
      if (pageContainer) {
        const containerLeft = pageContainer.offsetLeft;
        pdfPaneRef.current.scrollTo({
          top: Math.max(0, scrollTop),
          left: Math.max(0, containerLeft + markCenterX - (paneWidth / 2)),
          behavior: 'smooth',
        });
      } else {
        pdfPaneRef.current.scrollTo({
          top: Math.max(0, scrollTop),
          behavior: 'smooth',
        });
      }

      setStatus(`Viewing: ${mark.label || `Mark ${currentMarkIndex + 1}`}`);
    } catch (err) {
      console.error('Scroll error:', err);
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

  const jumpToMark = (index: number) => {
    setCurrentMarkIndex(index);
  };

  const handleZoomIn = () => {
    setScale((prev) => Math.min(4, prev + 0.3));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(0.5, prev - 0.3));
  };

  const handleResetZoom = () => {
    const currentMark = marks[currentMarkIndex];
    if (currentMark) {
      zoomAndScrollToMark(currentMark);
    }
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#f3f4f6', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ height: '60px', backgroundColor: 'white', borderBottom: '1px solid #d1d5db', padding: '0 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
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
            <div>
              <div style={{ fontWeight: '700', fontSize: '1rem', color: '#1f2937' }}>
                {currentMark.label || `Mark ${currentMarkIndex + 1}`}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                Page {currentMark.page_number} • {currentMarkIndex + 1} of {marks.length}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handlePrevious}
            disabled={currentMarkIndex === 0}
            style={{
              padding: '10px 20px',
              backgroundColor: currentMarkIndex === 0 ? '#d1d5db' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: currentMarkIndex === 0 ? 'not-allowed' : 'pointer',
              fontWeight: '600',
            }}
          >
            ← Previous
          </button>
          <button
            onClick={handleNext}
            disabled={currentMarkIndex >= marks.length - 1}
            style={{
              padding: '10px 20px',
              backgroundColor: currentMarkIndex >= marks.length - 1 ? '#d1d5db' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: currentMarkIndex >= marks.length - 1 ? 'not-allowed' : 'pointer',
              fontWeight: '600',
            }}
          >
            Next →
          </button>

          <div style={{ width: '1px', height: '30px', backgroundColor: '#d1d5db', margin: '0 8px' }} />

          <button onClick={handleZoomOut} style={{ padding: '8px 14px', backgroundColor: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' }}>
            −
          </button>
          <div style={{ padding: '8px 14px', backgroundColor: '#dbeafe', color: '#1e40af', borderRadius: '4px', fontSize: '0.875rem', fontWeight: '700', minWidth: '70px', textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </div>
          <button onClick={handleZoomIn} style={{ padding: '8px 14px', backgroundColor: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' }}>
            +
          </button>
          <button
            onClick={handleResetZoom}
            style={{
              padding: '8px 12px',
              backgroundColor: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '500',
              fontSize: '0.75rem',
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* PDF Pane */}
        <div
          ref={pdfPaneRef}
          style={{
            flex: 1,
            overflow: 'auto',
            backgroundColor: '#525252',
            padding: '20px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <div
                key={pageNum}
                ref={(el) => {
                  if (el) pageContainerRefs.current.set(pageNum, el);
                }}
                style={{ position: 'relative', backgroundColor: 'white', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}
              >
                <div style={{ position: 'absolute', top: '-28px', left: '0', fontSize: '0.875rem', color: '#e5e7eb', fontWeight: '700', backgroundColor: '#374151', padding: '4px 10px', borderRadius: '4px' }}>
                  Page {pageNum}
                </div>

                <canvas
                  ref={(el) => {
                    if (el) canvasRefs.current.set(pageNum, el);
                  }}
                  style={{ display: 'block' }}
                />

                {/* Highlight marks on this page */}
                {marks
                  .filter((mark) => mark.page_number === pageNum)
                  .map((mark) => {
                    const isCurrent = marks[currentMarkIndex]?.id === mark.id;
                    const canvas = canvasRefs.current.get(pageNum);
                    if (!canvas) return null;

                    const left = mark.x0 * canvas.offsetWidth;
                    const top = mark.y0 * canvas.offsetHeight;
                    const width = (mark.x1 - mark.x0) * canvas.offsetWidth;
                    const height = (mark.y1 - mark.y0) * canvas.offsetHeight;

                    return (
                      <div key={mark.id}>
                        <div
                          style={{
                            position: 'absolute',
                            left: `${left}px`,
                            top: `${top}px`,
                            width: `${width}px`,
                            height: `${height}px`,
                            border: isCurrent ? '5px solid #ef4444' : '2px solid #3b82f6',
                            backgroundColor: isCurrent ? 'rgba(239, 68, 68, 0.25)' : 'rgba(59, 130, 246, 0.08)',
                            pointerEvents: 'none',
                            boxSizing: 'border-box',
                            transition: 'all 0.3s',
                          }}
                        />

                        {isCurrent && mark.label && (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${left}px`,
                              top: `${Math.max(0, top - 38)}px`,
                              backgroundColor: '#ef4444',
                              color: 'white',
                              padding: '8px 14px',
                              borderRadius: '6px',
                              fontSize: '0.875rem',
                              fontWeight: '700',
                              whiteSpace: 'nowrap',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                              zIndex: 10,
                            }}
                          >
                            📍 {mark.label}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>

        {/* Marks List */}
        {showMarksList && (
          <div style={{ width: '320px', backgroundColor: 'white', borderLeft: '1px solid #d1d5db', overflowY: 'auto', flexShrink: 0 }}>
            <div style={{ padding: '16px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#f9fafb', position: 'sticky', top: 0, zIndex: 10 }}>
              <h3 style={{ fontSize: '1rem', fontWeight: '700', margin: 0, color: '#1f2937' }}>
                All Marks ({marks.length})
              </h3>
              <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '4px 0 0 0' }}>{status}</p>
            </div>

            <div>
              {marks.map((mark, idx) => (
                <div
                  key={mark.id}
                  onClick={() => jumpToMark(idx)}
                  style={{
                    padding: '14px',
                    cursor: 'pointer',
                    backgroundColor: idx === currentMarkIndex ? '#dbeafe' : 'white',
                    borderLeft: idx === currentMarkIndex ? '4px solid #3b82f6' : '4px solid transparent',
                    borderBottom: '1px solid #e5e7eb',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (idx !== currentMarkIndex) {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (idx !== currentMarkIndex) {
                      e.currentTarget.style.backgroundColor = 'white';
                    }
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.875rem', fontWeight: '700', marginBottom: '4px', color: '#1f2937' }}>
                        {mark.label || `Mark ${idx + 1}`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        Page {mark.page_number}
                      </div>
                    </div>
                    {idx === currentMarkIndex && (
                      <div style={{ fontSize: '1.25rem', color: '#3b82f6' }}>
                        ●
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}