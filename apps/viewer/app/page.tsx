'use client';

import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import ZoomToolbar from '../components/ZoomToolbar';
import { clampZoom, fitToWidth, scrollToRect } from '../lib/pdf';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

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

type FlashRect = {
  pageNumber: number;
  x: number;
  y: number;
  w: number;
  h: number;
} | null;

function ViewerContent() {
  const searchParams = useSearchParams();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState(-1);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);

  // Parse query params
  const isDemo = searchParams?.get('demo') === '1';
  const pdfUrl = isDemo
    ? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
    : searchParams?.get('pdf_url') || '';
  const markSetId = searchParams?.get('mark_set_id') || '';

  // Demo marks
  const demoMarks: Mark[] = [
    {
      mark_id: 'demo-1',
      page_index: 0,
      order_index: 0,
      name: 'First Mark',
      nx: 0.1,
      ny: 0.1,
      nw: 0.3,
      nh: 0.15,
      zoom_hint: 1.5,
    },
    {
      mark_id: 'demo-2',
      page_index: 5,
      order_index: 1,
      name: 'Second Mark',
      nx: 0.2,
      ny: 0.3,
      nw: 0.4,
      nh: 0.2,
      zoom_hint: 1.5,
    },
  ];

  // Load PDF
  useEffect(() => {
    if (!pdfUrl) {
      setError('No PDF URL provided');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    pdfjsLib
      .getDocument({ url: pdfUrl })
      .promise.then((loadedPdf) => {
        setPdf(loadedPdf);
        setNumPages(loadedPdf.numPages);
        setLoading(false);
      })
      .catch((err) => {
        console.error('PDF load error:', err);
        setError('Failed to load PDF');
        setLoading(false);
      });
  }, [pdfUrl]);

  // Load marks
  useEffect(() => {
    if (isDemo) {
      setMarks(demoMarks);
      return;
    }

    if (!markSetId) return;

    const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
    fetch(`${apiBase}/mark-sets/${markSetId}/marks`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch marks');
        return res.json();
      })
      .then((data: Mark[]) => {
        const sorted = [...data].sort((a, b) => a.order_index - b.order_index);
        setMarks(sorted);
      })
      .catch((err) => {
        console.error('Marks fetch error:', err);
      });
  }, [markSetId, isDemo]);

  // Navigate to mark
  // Navigate to mark
    const navigateToMark = useCallback(
      (index: number) => {
        if (!pdf || index < 0 || index >= marks.length) return;

        const mark = marks[index];
        setCurrentMarkIndex(index);

        setTimeout(() => {
          const pageNumber = mark.page_index + 1;
          const container = containerRef.current!;

          pdf.getPage(pageNumber).then((page) => {
            // 1) Compute rect @ scale=1
            const vp1 = page.getViewport({ scale: 1 });
            const rectAt1 = {
              x: mark.nx * vp1.width,
              y: mark.ny * vp1.height,
              w: mark.nw * vp1.width,
              h: mark.nh * vp1.height,
            };

            // 2) Use zoom_hint if provided, else compute optimal zoom
            const targetZoom =
              mark.zoom_hint ??
              computeZoomForRect(
                { w: container.clientWidth, h: container.clientHeight },
                { w: vp1.width, h: vp1.height },
                { w: rectAt1.w, h: rectAt1.h },
                0.75
              );

            setZoom(clampZoom(targetZoom));

            // 3) After zoom update, compute pixel rect at targetZoom and scroll
            setTimeout(() => {
              const vpZ = page.getViewport({ scale: targetZoom });
              const rectAtZ = {
                x: mark.nx * vpZ.width,
                y: mark.ny * vpZ.height,
                w: mark.nw * vpZ.width,
                h: mark.nh * vpZ.height,
              };

              // Flash highlight
              setFlashRect({ pageNumber, ...rectAtZ });
              setTimeout(() => setFlashRect(null), 1200);

              // Compute vertical page top
              let pageTop = 0;
              for (let i = 0; i < mark.page_index; i++) {
                pageTop += (pageHeightsRef.current[i] || 0) + 16;
              }

              scrollToRect(
                container,
                pageTop,
                undefined,
                rectAtZ,
                { w: container.clientWidth, h: container.clientHeight }
              );
            }, 60);
          });
        }, 50);
      },
      [marks, pdf]
    );
    
  // Previous/Next mark
  const prevMark = useCallback(() => {
    if (currentMarkIndex > 0) {
      navigateToMark(currentMarkIndex - 1);
    }
  }, [currentMarkIndex, navigateToMark]);

  const nextMark = useCallback(() => {
    if (currentMarkIndex < marks.length - 1) {
      navigateToMark(currentMarkIndex + 1);
    }
  }, [currentMarkIndex, marks.length, navigateToMark]);

  // Zoom controls
  const zoomIn = useCallback(() => {
    setZoom((z) => clampZoom(z * 1.2));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => clampZoom(z / 1.2));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1.0);
  }, []);

  const fitToWidthZoom = useCallback(() => {
    if (!pdf || !containerRef.current) return;

    pdf.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = containerRef.current!.clientWidth - 32;
      const newZoom = fitToWidth(containerWidth, viewport.width);
      setZoom(clampZoom(newZoom));
    });
  }, [pdf]);

  // Wheel zoom with Ctrl/Cmd
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;

      const contentX = scrollLeft + mouseX;
      const contentY = scrollTop + mouseY;

      const delta = e.deltaY;
      const zoomFactor = delta > 0 ? 0.9 : 1.1;

      setZoom((prevZoom) => {
        const newZoom = clampZoom(prevZoom * zoomFactor);
        const scale = newZoom / prevZoom;

        setTimeout(() => {
          if (container) {
            container.scrollLeft = contentX * scale - mouseX;
            container.scrollTop = contentY * scale - mouseY;
          }
        }, 0);

        return newZoom;
      });
    },
    []
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Handle page ready callback
  const handlePageReady = useCallback((pageNumber: number, height: number) => {
    pageHeightsRef.current[pageNumber - 1] = height;
  }, []);

  if (loading) {
    return (
      <div className="viewer-container">
        <div className="loading">Loading PDF...</div>
      </div>
    );
  }

  if (error || !pdf) {
    return (
      <div className="viewer-container">
        <div className="error">{error || 'Failed to load PDF'}</div>
      </div>
    );
  }

  return (
    <div className="viewer-container">
      {marks.length > 0 && (
        <div className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
          <div className="sidebar-header">
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>
            {sidebarOpen && <h3>Marks</h3>}
          </div>
          {sidebarOpen && (
            <MarkList
              marks={marks}
              currentIndex={currentMarkIndex}
              onSelect={navigateToMark}
            />
          )}
        </div>
      )}

      <div className="main-content">
        <ZoomToolbar
          zoom={zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={resetZoom}
          onFit={fitToWidthZoom}
          onPrev={marks.length > 0 ? prevMark : undefined}
          onNext={marks.length > 0 ? nextMark : undefined}
          canPrev={currentMarkIndex > 0}
          canNext={currentMarkIndex < marks.length - 1}
        />

        <div className="pdf-surface-wrap" ref={containerRef}>
          <div className="pdf-surface">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <PageCanvas
                key={pageNum}
                pdf={pdf}
                pageNumber={pageNum}
                zoom={zoom}
                onReady={(height) => handlePageReady(pageNum, height)}
                flashRect={
                  flashRect?.pageNumber === pageNum
                    ? {
                        x: flashRect.x,
                        y: flashRect.y,
                        w: flashRect.w,
                        h: flashRect.h,
                      }
                    : null
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="viewer-container"><div className="loading">Loading...</div></div>}>
      <ViewerContent />
    </Suspense>
  );
}