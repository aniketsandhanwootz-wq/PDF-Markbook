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

  const pdfPaneRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());

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
      setStatus('Demo mode');
      return;
    }

    if (!markSetId) return;

    setStatus('Fetching marks...');
    fetch(`${API_BASE}/mark-sets/${markSetId}/marks`)
      .then((res) => res.json())
      .then((data) => {
        setMarks(data.marks || []);
        setStatus(`${data.marks?.length || 0} marks loaded`);
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
        setStatus('Ready');
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err);
        setLoading(false);
        setStatus('Error loading PDF');
      });
  }, [pdfUrl]);

  // Render all pages when PDF loads or scale changes
  useEffect(() => {
    if (!pdfDoc || numPages === 0) return;

    const renderAllPages = async () => {
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        await renderPage(pageNum);
      }
    };

    renderAllPages();
  }, [pdfDoc, numPages, scale]);

  const renderPage = async (pageNum: number) => {
    if (!pdfDoc) return;

    const canvas = canvasRefs.current.get(pageNum);
    if (!canvas) return;

    // Cancel existing render for this page
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

  // Scroll to current mark when it changes
  useEffect(() => {
    if (!pdfDoc || marks.length === 0 || !pdfPaneRef.current) return;

    const currentMark = marks[currentMarkIndex];
    if (!currentMark) return;

    scrollToMark(currentMark);
  }, [currentMarkIndex, marks, pdfDoc]);

  const scrollToMark = async (mark: Mark) => {
    if (!pdfDoc || !pdfPaneRef.current) return;

    try {
      const page = await pdfDoc.getPage(mark.page_number);
      const viewport = page.getViewport({ scale });

      // Calculate mark center in page coordinates
      const markCenterX = ((mark.x0 + mark.x1) / 2) * viewport.width;
      const markCenterY = ((mark.y0 + mark.y1) / 2) * viewport.height;

      // Calculate total offset from top (accounting for previous pages)
      let offsetTop = 0;
      for (let i = 1; i < mark.page_number; i++) {
        const prevCanvas = canvasRefs.current.get(i);
        if (prevCanvas) {
          offsetTop += prevCanvas.offsetHeight + 20; // 20px gap
        }
      }

      offsetTop += markCenterY;

      // Center the mark in the viewport
      const paneHeight = pdfPaneRef.current.clientHeight;
      const scrollTop = offsetTop - (paneHeight / 2);

      pdfPaneRef.current.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'smooth',
      });

      setStatus(`Viewing mark ${currentMarkIndex + 1} of ${marks.length}`);
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
    setScale((prev) => Math.min(3, prev + 0.2));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(0.5, prev - 0.2));
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
      <div style={{ height: '56px', backgroundColor: 'white', borderBottom: '1px solid #d1d5db', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
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
              <span style={{ fontWeight: '600' }}>
                {currentMark.label || `Mark ${currentMarkIndex + 1}`}
              </span>
              <span style={{ color: '#6b7280' }}> ({currentMarkIndex + 1}/{marks.length})</span>
            </div>
          )}

          <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{status}</div>
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
            ← Prev
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
          <div style={{ display: 'flex', gap: '4px', marginLeft: '12px' }}>
            <button onClick={handleZoomOut} style={{ padding: '6px 12px', backgroundColor: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
              −
            </button>
            <div style={{ padding: '6px 12px', backgroundColor: '#dbeafe', color: '#1e40af', borderRadius: '4px', fontSize: '0.875rem', fontWeight: '600', minWidth: '60px', textAlign: 'center' }}>
              {Math.round(scale * 100)}%
            </div>
            <button onClick={handleZoomIn} style={{ padding: '6px 12px', backgroundColor: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
              +
            </button>
          </div>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* PDF Pane - scrollable, shows ALL pages */}
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
                <div style={{ position: 'absolute', top: '-24px', left: '0', fontSize: '0.875rem', color: '#e5e7eb', fontWeight: '600' }}>
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
                  .map((mark, idx) => {
                    const isCurrent = marks[currentMarkIndex]?.id === mark.id;

                    return (
                      <div
                        key={mark.id}
                        style={{
                          position: 'absolute',
                          left: `${mark.x0 * (canvasRefs.current.get(pageNum)?.offsetWidth || 0)}px`,
                          top: `${mark.y0 * (canvasRefs.current.get(pageNum)?.offsetHeight || 0)}px`,
                          width: `${(mark.x1 - mark.x0) * (canvasRefs.current.get(pageNum)?.offsetWidth || 0)}px`,
                          height: `${(mark.y1 - mark.y0) * (canvasRefs.current.get(pageNum)?.offsetHeight || 0)}px`,
                          border: isCurrent ? '4px solid #ef4444' : '2px solid #3b82f6',
                          backgroundColor: isCurrent ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.1)',
                          pointerEvents: 'none',
                          boxSizing: 'border-box',
                          transition: 'all 0.2s',
                        }}
                      />
                    );
                  })}
              </div>
            ))}
          </div>
        </div>

        {/* Marks List */}
        {showMarksList && (
          <div style={{ width: '300px', backgroundColor: 'white', borderLeft: '1px solid #d1d5db', overflowY: 'auto', flexShrink: 0 }}>
            <div style={{ padding: '12px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#f9fafb' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: '600', margin: 0 }}>
                Marks ({marks.length})
              </h3>
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
                    borderLeft: idx === currentMarkIndex ? '3px solid #3b82f6' : '3px solid transparent',
                    borderBottom: '1px solid #e5e7eb',
                  }}
                >
                  <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '4px' }}>
                    Mark {idx + 1}
                  </div>
                  {mark.label && (
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>
                      {mark.label}
                    </div>
                  )}
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                    Page {mark.page_number}
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