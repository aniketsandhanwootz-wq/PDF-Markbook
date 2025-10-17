'use client';

import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import ZoomToolbar from '../components/ZoomToolbar';
import { clampZoom, computeZoomForRect, scrollToRect } from '../lib/pdf';

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

type MarkSetInfo = {
  id: string;
  pdf_url: string;
  name: string;
};

// Setup Screen Component for Viewer
function ViewerSetupScreen({ onStart }: { onStart: (pdfUrl: string, markSetId: string) => void }) {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [availableMarkSets, setAvailableMarkSets] = useState<MarkSetInfo[]>([]);
  const [error, setError] = useState('');
  const [loadingMarkSets, setLoadingMarkSets] = useState(true);

  const samplePdfs = [
    {
      name: 'Mozilla TracemonKey (Sample)',
      url: 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
    },
    {
      name: 'PDF.js Sample',
      url: 'https://raw.githubusercontent.com/mozilla/pdf.js/ba2edeae/examples/learning/helloworld.pdf'
    }
  ];

  // Load available mark sets on mount
  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
    fetch(`${apiBase}/mark-sets`)
      .then(res => res.json())
      .then((data: MarkSetInfo[]) => {
        setAvailableMarkSets(data);
        setLoadingMarkSets(false);
      })
      .catch(err => {
        console.error('Failed to load mark sets:', err);
        setLoadingMarkSets(false);
      });
  }, []);

  const handleStart = () => {
    if (!pdfUrl.trim()) {
      setError('Please enter a PDF URL or select a mark set');
      return;
    }

    setIsLoading(true);
    setError('');

    onStart(pdfUrl.trim(), markSetId.trim());
  };

  const handleSelectMarkSet = (markSet: MarkSetInfo) => {
    setPdfUrl(markSet.pdf_url);
    setMarkSetId(markSet.id);
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#f5f5f5',
      padding: '20px'
    }}>
      <div style={{
        background: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
        padding: '40px',
        maxWidth: '600px',
        width: '100%'
      }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '8px' }}>
          PDF Mark Viewer
        </h1>
        <p style={{ color: '#666', marginBottom: '32px' }}>
          View and navigate marks on PDF documents
        </p>

        {/* Available Mark Sets */}
        {availableMarkSets.length > 0 && (
          <div style={{ marginBottom: '32px' }}>
            <label style={{ display: 'block', fontWeight: '500', marginBottom: '12px' }}>
              📋 Available Mark Sets
            </label>
            <div style={{
              border: '1px solid #ddd',
              borderRadius: '4px',
              maxHeight: '200px',
              overflowY: 'auto'
            }}>
              {availableMarkSets.map((markSet) => (
                <div
                  key={markSet.id}
                  onClick={() => handleSelectMarkSet(markSet)}
                  style={{
                    padding: '12px',
                    borderBottom: '1px solid #f0f0f0',
                    cursor: 'pointer',
                    background: markSetId === markSet.id ? '#e3f2fd' : 'white',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (markSetId !== markSet.id) {
                      e.currentTarget.style.background = '#f9f9f9';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (markSetId !== markSet.id) {
                      e.currentTarget.style.background = 'white';
                    }
                  }}
                >
                  <div style={{ fontWeight: '500', marginBottom: '4px' }}>
                    {markSet.name}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', wordBreak: 'break-all' }}>
                    {markSet.pdf_url.substring(0, 60)}...
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loadingMarkSets && (
          <div style={{ 
            textAlign: 'center', 
            padding: '20px', 
            color: '#666',
            marginBottom: '24px' 
          }}>
            Loading mark sets...
          </div>
        )}

        <div style={{ 
          borderTop: '2px solid #f0f0f0', 
          paddingTop: '24px',
          marginTop: availableMarkSets.length > 0 ? '0' : '0'
        }}>
          <label style={{ display: 'block', fontWeight: '500', marginBottom: '8px' }}>
            🔗 Or Enter PDF URL
          </label>
          <input
            type="text"
            value={pdfUrl}
            onChange={(e) => setPdfUrl(e.target.value)}
            placeholder="https://example.com/document.pdf"
            style={{
              width: '100%',
              padding: '12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px'
            }}
          />
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
            Sample PDFs:
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            {samplePdfs.map((sample, idx) => (
              <button
                key={idx}
                onClick={() => setPdfUrl(sample.url)}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  border: '1px solid #1976d2',
                  background: 'white',
                  color: '#1976d2',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                {sample.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: '24px', marginBottom: '24px' }}>
          <label style={{ display: 'block', fontWeight: '500', marginBottom: '8px' }}>
            🏷️ Mark Set ID (Optional)
          </label>
          <input
            type="text"
            value={markSetId}
            onChange={(e) => setMarkSetId(e.target.value)}
            placeholder="Leave empty to view PDF without marks"
            style={{
              width: '100%',
              padding: '12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px'
            }}
          />
        </div>

        {error && (
          <div style={{
            padding: '12px',
            background: '#ffebee',
            color: '#c62828',
            borderRadius: '4px',
            marginBottom: '24px',
            fontSize: '14px'
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleStart}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '14px',
            background: isLoading ? '#ccc' : '#1976d2',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '16px',
            fontWeight: '600',
            cursor: isLoading ? 'not-allowed' : 'pointer'
          }}
        >
          {isLoading ? 'Loading...' : 'Open PDF'}
        </button>

        <div style={{
          marginTop: '24px',
          padding: '16px',
          background: '#f9f9f9',
          borderRadius: '4px',
          fontSize: '13px',
          color: '#666'
        }}>
          <strong>💡 Tips:</strong>
          <ul style={{ marginTop: '8px', paddingLeft: '20px' }}>
            <li>Select a mark set from the list above to view with marks</li>
            <li>Or enter a PDF URL directly to view without marks</li>
            <li>Use Ctrl/Cmd + Scroll to zoom in/out</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// Main Viewer Component
function ViewerContent() {
  const searchParams = useSearchParams();
  const [showSetup, setShowSetup] = useState(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState(-1);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);

  const isDemo = searchParams?.get('demo') === '1';
  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const markSetIdParam = searchParams?.get('mark_set_id') || '';

  // Check if we should show setup screen
  useEffect(() => {
    if (isDemo || pdfUrlParam) {
      setShowSetup(false);
    }
  }, [isDemo, pdfUrlParam]);

  const handleSetupComplete = (url: string, setId: string) => {
    const params = new URLSearchParams();
    params.set('pdf_url', url);
    if (setId) {
      params.set('mark_set_id', setId);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.location.href = newUrl;
  };

  const pdfUrl = isDemo
    ? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
    : pdfUrlParam || 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

  const markSetId = markSetIdParam;

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
    if (showSetup) return;
    
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
  }, [pdfUrl, showSetup]);

  // Load marks
  useEffect(() => {
    if (showSetup) return;

    if (isDemo) {
      setMarks(demoMarks);
      return;
    }

    if (!markSetId) {
      setMarks([]);
      return;
    }

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
        setMarks([]);
      });
  }, [markSetId, isDemo, showSetup]);

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
          const vp1 = page.getViewport({ scale: 1 });
          const rectAt1 = {
            x: mark.nx * vp1.width,
            y: mark.ny * vp1.height,
            w: mark.nw * vp1.width,
            h: mark.nh * vp1.height,
          };

          const targetZoom =
            mark.zoom_hint ??
            computeZoomForRect(
              { w: container.clientWidth, h: container.clientHeight },
              { w: vp1.width, h: vp1.height },
              { w: rectAt1.w, h: rectAt1.h },
              0.75
            );

          setZoom(clampZoom(targetZoom));

          setTimeout(() => {
            const vpZ = page.getViewport({ scale: targetZoom });
            const rectAtZ = {
              x: mark.nx * vpZ.width,
              y: mark.ny * vpZ.height,
              w: mark.nw * vpZ.width,
              h: mark.nh * vpZ.height,
            };

            setFlashRect({ pageNumber, ...rectAtZ });
            setTimeout(() => setFlashRect(null), 1200);

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
      const newZoom = containerWidth / viewport.width;
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

  if (showSetup) {
    return <ViewerSetupScreen onStart={handleSetupComplete} />;
  }

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