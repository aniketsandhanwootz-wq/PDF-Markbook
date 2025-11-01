'use client';

import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSwipeable } from 'react-swipeable';
import toast, { Toaster } from 'react-hot-toast';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import ZoomToolbar from '../components/ZoomToolbar';
import InputPanel from '../components/InputPanel';
import ReviewScreen from '../components/ReviewScreen';
import { clampZoom } from '../lib/pdf';
import PDFSearch from '../components/PDFSearch';
import usePinchZoom from '../hooks/usePinchZoom';


pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

// --- precise centering helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the page's <canvas> reaches the expected CSS size for the target zoom.
 * Prevents "center then resize" drift.
 */
async function waitForCanvasLayout(
  pageEl: HTMLElement,
  expectedW: number,
  expectedH: number,
  timeoutMs = 1200
) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const canvas = pageEl.querySelector('canvas') as HTMLCanvasElement | null;
    const w = (canvas?.clientWidth ?? pageEl.clientWidth) | 0;
    const h = (canvas?.clientHeight ?? pageEl.clientHeight) | 0;
    if (Math.abs(w - expectedW) <= 2 && Math.abs(h - expectedH) <= 2) return;
    await sleep(50);
  }
}

function clampScroll(container: HTMLElement, left: number, top: number) {
  const maxL = Math.max(0, container.scrollWidth - container.clientWidth);
  const maxT = Math.max(0, container.scrollHeight - container.clientHeight);
  return {
    left: Math.max(0, Math.min(left, maxL)),
    top: Math.max(0, Math.min(top, maxT)),
  };
}

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
const SWIPE_TO_STEP_ENABLED = false;

// Setup Screen Component
function ViewerSetupScreen({ onStart }: { onStart: (pdfUrl: string, markSetId: string) => void }) {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [availableMarkSets, setAvailableMarkSets] = useState<MarkSetInfo[]>([]);
  const [error, setError] = useState('');
  const [loadingMarkSets, setLoadingMarkSets] = useState(true);

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
          <div style={{ textAlign: 'center', padding: '20px', color: '#666', marginBottom: '24px' }}>
            Loading mark sets...
          </div>
        )}

        <div style={{ borderTop: '2px solid #f0f0f0', paddingTop: '24px' }}>
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
  const [currentMarkIndex, setCurrentMarkIndex] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // Start closed on mobile
  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchHighlights, setSearchHighlights] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [highlightPageNumber, setHighlightPageNumber] = useState<number>(0);
  const [isMobileInputMode, setIsMobileInputMode] = useState(false);

  // Input mode states
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [showReview, setShowReview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);
  const pageElsRef = useRef<Array<HTMLDivElement | null>>([]);
  // keep current zoom in a ref for synchronous math
const zoomRef = useRef(zoom);
useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const isDemo = searchParams?.get('demo') === '1';
  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const markSetIdParam = searchParams?.get('mark_set_id') || '';
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

  const rawPdfUrl = isDemo
    ? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
    : pdfUrlParam || 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const pdfUrl = rawPdfUrl 
    ? `${apiBase}/proxy-pdf?url=${encodeURIComponent(rawPdfUrl)}`
    : '';

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
  usePinchZoom({
  containerRef,
  setZoom,
  zoomRef,
  clampZoom,
  maxPhoneZoom: 3,
});

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
      setIsMobileInputMode(false);
      return;
    }

    fetch(`${apiBase}/mark-sets/${markSetId}/marks`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch marks');
        return res.json();
      })
      .then((data: Mark[]) => {
        const sorted = [...data].sort((a, b) => a.order_index - b.order_index);
        setMarks(sorted);
        
        const initialEntries: Record<string, string> = {};
        sorted.forEach(mark => {
          if (mark.mark_id) {
            initialEntries[mark.mark_id] = '';
          }
        });
        setEntries(initialEntries);
        
        // Force mobile mode if marks exist AND screen is narrow
const isMobile = window.innerWidth < 900 || ('ontouchstart' in window && window.innerWidth < 1024);
setIsMobileInputMode(isMobile);
      })
      .catch((err) => {
        console.error('Marks fetch error:', err);
        setMarks([]);
        setIsMobileInputMode(false);
      });
  }, [markSetId, isDemo, showSetup, apiBase]);
  // Auto-navigate to first mark when marks load
useEffect(() => {
  if (marks.length > 0 && pdf && currentMarkIndex === 0) {
    const timer = setTimeout(() => {
      navigateToMark(0);
    }, 800);
    return () => clearTimeout(timer);
  }
}, [marks, pdf, currentMarkIndex]);
// Set initial sidebar state based on screen size
useEffect(() => {
  setSidebarOpen(window.innerWidth > 768);
}, []);
  useEffect(() => {
    const handleResize = () => {
      if (marks.length > 0) {
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        const isNarrowScreen = window.innerWidth <= 900;
        const shouldBeMobile = isNarrowScreen || isTouchDevice;
        
        setIsMobileInputMode(shouldBeMobile);
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => window.removeEventListener('resize', handleResize);
  }, [marks.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdf) return;

    const handleScroll = () => {
      let accumulatedHeight = 16;
      let foundPage = 1;

      for (let i = 0; i < numPages; i++) {
        const pageHeight = pageHeightsRef.current[i] || 0;
        if (container.scrollTop < accumulatedHeight + pageHeight / 2) {
          foundPage = i + 1;
          break;
        }
        accumulatedHeight += pageHeight + 16;
      }

      setCurrentPage(foundPage);
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [pdf, numPages]);

const navigateToMark = useCallback(
    async (index: number) => {
      if (!pdf || index < 0 || index >= marks.length) return;

      const mark = marks[index];
      setCurrentMarkIndex(index);

      const pageNumber = mark.page_index + 1;
      const container = containerRef.current;
      const pageEl = pageElsRef.current[mark.page_index];
      
      if (!container || !pageEl) return;

      try {
        const page = await pdf.getPage(pageNumber);
        const vp1 = page.getViewport({ scale: 1 });
        
        const rectAt1 = {
          x: mark.nx * vp1.width,
          y: mark.ny * vp1.height,
          w: mark.nw * vp1.width,
          h: mark.nh * vp1.height,
        };

        const containerW = container.clientWidth;
        const containerH = container.clientHeight;

const zoomX = (containerW * 0.8) / rectAt1.w;
const zoomY = (containerH * 0.8) / rectAt1.h;

let targetZoom = Math.min(zoomX, zoomY);   // declare
targetZoom = Math.min(targetZoom, 4);      // desktop guard
if (containerW < 600) targetZoom = Math.min(targetZoom, 3); // mobile guard
targetZoom = clampZoom(targetZoom);
setZoom(targetZoom);

        // Pre-compute expected page size at target zoom
        const vpExpected = page.getViewport({ scale: targetZoom });
        const expectedW = Math.round(vpExpected.width);
        const expectedH = Math.round(vpExpected.height);

        // Wait until the <canvas> actually reaches that CSS size
        await waitForCanvasLayout(pageEl, expectedW, expectedH);

        // Use the same viewport for rect math
        const vpZ = vpExpected;

        
        // Calculate mark rect at target zoom
        const rectAtZ = {
          x: mark.nx * vpZ.width,
          y: mark.ny * vpZ.height,
          w: mark.nw * vpZ.width,
          h: mark.nh * vpZ.height,
        };

        // Flash the mark
        setFlashRect({
          pageNumber,
          x: rectAtZ.x,
          y: rectAtZ.y,
          w: rectAtZ.w,
          h: rectAtZ.h,
        });
        setTimeout(() => setFlashRect(null), 1200);

        // Get actual page position in scrollable container
        const containerRect = container.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();
        
        // Calculate page offset relative to container's scroll origin
        const pageOffsetLeft = container.scrollLeft + (pageRect.left - containerRect.left);
        const pageOffsetTop = container.scrollTop + (pageRect.top - containerRect.top);

        // Calculate mark center in absolute scroll coordinates
        const markCenterX = pageOffsetLeft + rectAtZ.x + rectAtZ.w / 2;
        const markCenterY = pageOffsetTop + rectAtZ.y + rectAtZ.h / 2;

        // Calculate scroll position to center mark in viewport
        const targetScrollLeft = markCenterX - containerW / 2;
        const targetScrollTop = markCenterY - containerH / 2;

const { left: clampedL, top: clampedT } =
  clampScroll(container, targetScrollLeft, targetScrollTop);

container.scrollTo({ left: clampedL, top: clampedT, behavior: 'smooth' });


      } catch (error) {
        console.error('Error navigating to mark:', error);
      }
    },
    [marks, pdf]
  );
  const prevMark = useCallback(() => {
    if (currentMarkIndex > 0) {
      navigateToMark(currentMarkIndex - 1);
    }
  }, [currentMarkIndex, navigateToMark]);

  const nextMark = useCallback(() => {
    if (currentMarkIndex < marks.length - 1) {
      navigateToMark(currentMarkIndex + 1);
    } else {
      setShowReview(true);
    }
  }, [currentMarkIndex, marks.length, navigateToMark]);
  
  const selectFromList = useCallback((index: number) => {
  // If mobile and sidebar is open, we may close it and the container width changes.
  // Give layout a tick, then navigate so zoom math uses the final width.
  const needsDelay = window.innerWidth < 900; // narrow screens
  if (needsDelay) {
    // Close the sidebar if it's open (mobile UX)
    if (sidebarOpen) setSidebarOpen(false);
    setTimeout(() => navigateToMark(index), 80); // one frame on mobile Safari
  } else {
    navigateToMark(index);
  }
}, [navigateToMark, sidebarOpen]);

  const jumpToPage = useCallback((pageNumber: number) => {
    if (!pdf || !containerRef.current) return;

    const container = containerRef.current;
    const pageEl = pageElsRef.current[pageNumber - 1];
    if (!pageEl) return;

    const containerRect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();

    const pageLeftInScroll = container.scrollLeft + (pageRect.left - containerRect.left);
    const pageTopInScroll = container.scrollTop + (pageRect.top - containerRect.top);

    const targetLeft = Math.max(
      0,
      pageLeftInScroll + pageEl.clientWidth / 2 - container.clientWidth / 2
    );

    container.scrollTo({
      left: targetLeft,
      top: pageTopInScroll,
      behavior: 'smooth',
    });
  }, [pdf]);

  const handleEntryChange = useCallback((value: string) => {
    const currentMark = marks[currentMarkIndex];
    if (currentMark?.mark_id) {
      setEntries(prev => ({
        ...prev,
        [currentMark.mark_id!]: value
      }));
    }
  }, [currentMarkIndex, marks]);

const handleSubmit = useCallback(async () => {
  if (!markSetId) {
    toast.error('No mark set ID provided');
    return;
  }

  setIsSubmitting(true);

  try {
    // Call backend to save entries (Sheets) + build the PDF report
    const response = await fetch(`${apiBase}/mark-sets/${markSetId}/submissions/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries,
        pdf_url: rawPdfUrl,        // send original URL so backend can fetch
        padding_pct: 0.25,
        title: 'Markbook Submission',
        author: 'PDF Viewer',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Report API failed: ${response.status} ${text}`);
    }

    // Download the returned PDF
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `submission_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast.success('✓ Report generated!');
    setTimeout(() => {
      window.location.href = '/';
    }, 1500);
  } catch (error) {
    console.error('Submit error:', error);
    toast.error('Failed to generate report');
  } finally {
    setIsSubmitting(false);
  }
}, [markSetId, entries, apiBase, rawPdfUrl]);


  const swipeHandlers = useSwipeable({
  onSwipedLeft: () => {
    if (!showReview && marks.length > 0) {
      nextMark();
    }
  },
  onSwipedRight: () => {
    if (!showReview && marks.length > 0) {
      prevMark();
    }
  },
  trackMouse: false,
  trackTouch: true,
  delta: 100, // Require 100px swipe (less sensitive)
  preventScrollOnSwipe: false, // Allow vertical scroll
  swipeDuration: 500, // Must swipe within 500ms
});

  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * 1.2)), []);
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / 1.2)), []);
  const resetZoom = useCallback(() => setZoom(1.0), []);

  const fitToWidthZoom = useCallback(() => {
    if (!pdf || !containerRef.current) return;

    pdf.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = containerRef.current!.clientWidth - 32;
      const newZoom = containerWidth / viewport.width;
      setZoom(clampZoom(newZoom));
    });
  }, [pdf]);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const target = e.target as HTMLElement;
      if (!container.contains(target)) return;

      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;
      const contentX = scrollLeft + mouseX;
      const contentY = scrollTop + mouseY;
      
      const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05;

      setZoom((prevZoom) => {
        const newZoom = clampZoom(prevZoom * zoomFactor);
        const scale = newZoom / prevZoom;

        requestAnimationFrame(() => {
          container.scrollLeft = contentX * scale - mouseX;
          container.scrollTop = contentY * scale - mouseY;
        });

        return newZoom;
      });
    };

    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    
    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true } as any);
    };
  }, []);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePageReady = useCallback((pageNumber: number, height: number) => {
    pageHeightsRef.current[pageNumber - 1] = height;
  }, []);

  const handleSearchResult = useCallback((pageNumber: number, highlights: any[]) => {
    setHighlightPageNumber(pageNumber);
    setSearchHighlights(highlights);
    jumpToPage(pageNumber);
  }, [jumpToPage]);

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

  if (showReview) {
    return (
      <>
        <ReviewScreen
          marks={marks}
          entries={entries}
          onBack={() => setShowReview(false)}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />
        <Toaster position="top-center" />
      </>
    );
  }

  // Mobile input mode
  if (isMobileInputMode && marks.length > 0) {
    const currentMark = marks[currentMarkIndex];
    const currentValue = currentMark?.mark_id ? entries[currentMark.mark_id] || '' : '';

    return (
      <div style={{ 
  display: 'flex', 
  flexDirection: 'column', 
  height: '100dvh',
  overflow: 'hidden' 
}}>
        <Toaster position="top-center" />
        
        <div style={{ 
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
  overflow: 'hidden'
}}>

          <div style={{
            width: sidebarOpen ? '280px' : '0px',
            minWidth: sidebarOpen ? '280px' : '0px',
            height: '100%',
            background: '#fff',
            borderRight: sidebarOpen ? '1px solid #ddd' : 'none',
            transition: 'width 0.15s ease-out, min-width 0.15s ease-out',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: sidebarOpen ? '2px 0 8px rgba(0,0,0,0.1)' : 'none'
          }}>
            <div style={{
              padding: '6px 10px',
              borderBottom: '1px solid #ddd',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: '#f9f9f9',
              minHeight: '36px'
            }}>
              <button
                onClick={() => setSidebarOpen(false)}
                style={{
                  width: '32px',
                  height: '32px',
                  border: 'none',
                  background: 'transparent',
                  color: '#5f6368',
                  borderRadius: '0',
                  cursor: 'pointer',
                  fontSize: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  flexShrink: 0
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(60,64,67,0.08)';
                  e.currentTarget.style.borderRadius = '50%';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderRadius = '0';
                }}
                title="Close sidebar"
              >
                ☰
              </button>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', flex: 1 }}>Marks</h3>
            </div>

            <div style={{ flex: 1, overflow: 'auto' }}>
  <MarkList
  marks={marks}
  currentIndex={currentMarkIndex}
  onSelect={(index) => {
    setCurrentMarkIndex(index);
    selectFromList(index);   // ← will close sidebar (if needed) and then zoom+center
  }}
/>


</div>
          </div>

         <div
  className="swipe-gesture-host"
  style={{
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0
  }}
  {...(SWIPE_TO_STEP_ENABLED ? swipeHandlers : {})}
>


            <ZoomToolbar
              zoom={zoom}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onReset={resetZoom}
              onFit={fitToWidthZoom}
              currentPage={currentPage}
              totalPages={numPages}
              onPageJump={jumpToPage}
              showSidebarToggle={true}
              sidebarOpen={sidebarOpen}
              onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
            />

          <div
  style={{
    flex: 1,
    overflow: 'auto',
    background: '#525252',
    WebkitOverflowScrolling: 'touch',
    touchAction: 'pan-x pan-y',
  }}
  className="pdf-surface-wrap"
  ref={containerRef}
>

              <div className="pdf-surface">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <div 
                    key={pageNum} 
                    style={{ position: 'relative' }}
                    ref={(el) => {
                      pageElsRef.current[pageNum - 1] = el;
                    }}
                  >
                    <PageCanvas
                      pdf={pdf}
                      pageNumber={pageNum}
                      zoom={zoom}
                      onReady={(height) => handlePageReady(pageNum, height)}
                      flashRect={
                        flashRect?.pageNumber === pageNum
                          ? { x: flashRect.x, y: flashRect.y, w: flashRect.w, h: flashRect.h }
                          : null
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <InputPanel
          currentMark={currentMark}
          currentIndex={currentMarkIndex}
          totalMarks={marks.length}
          value={currentValue}
          onChange={handleEntryChange}
          onNext={nextMark}
          onPrev={prevMark}
          canNext={true}
          canPrev={currentMarkIndex > 0}
        />
      </div>
    );
  }

  // Desktop mode
return (
  <div className="viewer-container">
    <Toaster position="top-center" />

    {marks.length > 0 && (
      <div className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
          {sidebarOpen && <h3>Marks</h3>}
        </div>
        {sidebarOpen && (
          <MarkList
  marks={marks}
  currentIndex={currentMarkIndex}
  onSelect={selectFromList}
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
        currentPage={currentPage}
        totalPages={numPages}
        onPageJump={jumpToPage}
      />

      <div className="pdf-surface-wrap" ref={containerRef} style={{ touchAction: 'pan-y pan-x' }}>
        <div className="pdf-surface">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
            <div
              key={pageNum}
              style={{ position: 'relative' }}
              ref={(el) => { pageElsRef.current[pageNum - 1] = el; }}
            >
              <PageCanvas
                pdf={pdf}
                pageNumber={pageNum}
                zoom={zoom}
                onReady={(height) => handlePageReady(pageNum, height)}
                flashRect={
                  flashRect?.pageNumber === pageNum
                    ? { x: flashRect.x, y: flashRect.y, w: flashRect.w, h: flashRect.h }
                    : null
                }
              />

              {highlightPageNumber === pageNum && searchHighlights.map((h, idx) => (
                <div
                  key={`highlight-${idx}`}
                  style={{
                    position: 'absolute',
                    left: h.x * zoom,
                    top: h.y * zoom,
                    width: h.width * zoom,
                    height: h.height * zoom,
                    background: 'rgba(255, 235, 59, 0.4)',
                    border: '1px solid rgba(255, 193, 7, 0.8)',
                    pointerEvents: 'none',
                    zIndex: 100,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Keep Input Panel OUTSIDE the scroll area */}
      <div className="input-panel-section">
        <InputPanel
          currentMark={marks[currentMarkIndex] ?? null}
          currentIndex={currentMarkIndex}
          totalMarks={marks.length}
          value={(marks[currentMarkIndex]?.mark_id && entries[marks[currentMarkIndex]!.mark_id!]) || ''}
          onChange={handleEntryChange}
          onNext={nextMark}
          onPrev={prevMark}
          canPrev={currentMarkIndex > 0}
          canNext={currentMarkIndex < marks.length - 1}
        />
      </div>

      {/* PDFSearch should stay inside main-content, after the viewer area */}
      <PDFSearch
        pdf={pdf}
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
        onResultFound={handleSearchResult}
      />
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