'use client';

import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import ZoomToolbar from '../components/ZoomToolbar';
import Toast from '../components/Toast';
import FloatingNameBox from '../components/FloatingNameBox';
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
};

type Rect = { x: number; y: number; w: number; h: number };

type FlashRect = {
  pageNumber: number;
  x: number;
  y: number;
  w: number;
  h: number;
} | null;

type ToastMessage = {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
};

type MarkOverlay = {
  markId: string;
  pageIndex: number;
  style: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

// Setup Screen Component
function SetupScreen({ onStart }: { onStart: (pdfUrl: string, markSetName: string) => void }) {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetName, setMarkSetName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

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

  const handleStart = async () => {
    if (!pdfUrl.trim()) {
      setError('Please enter a PDF URL');
      return;
    }

    if (!markSetName.trim()) {
      setError('Please enter a name for this mark set');
      return;
    }

    setIsCreating(true);
    setError('');

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
      const response = await fetch(`${apiBase}/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdf_url: pdfUrl.trim(),
          name: markSetName.trim()
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create mark set');
      }

      const data = await response.json();
      onStart(pdfUrl.trim(), data.id);
    } catch (err) {
      console.error('Error creating mark set:', err);
      setError('Failed to create mark set. Is the backend running?');
      setIsCreating(false);
    }
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
          PDF Mark Editor
        </h1>
        <p style={{ color: '#666', marginBottom: '32px' }}>
          Create marks on any PDF document
        </p>

        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', fontWeight: '500', marginBottom: '8px' }}>
            PDF URL *
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

        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', fontWeight: '500', marginBottom: '8px' }}>
            Mark Set Name *
          </label>
          <input
            type="text"
            value={markSetName}
            onChange={(e) => setMarkSetName(e.target.value)}
            placeholder="e.g., Chapter 1 Review, Project Proposal"
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
          disabled={isCreating}
          style={{
            width: '100%',
            padding: '14px',
            background: isCreating ? '#ccc' : '#1976d2',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '16px',
            fontWeight: '600',
            cursor: isCreating ? 'not-allowed' : 'pointer'
          }}
        >
          {isCreating ? 'Creating...' : 'Start Marking'}
        </button>

        <div style={{
          marginTop: '24px',
          padding: '16px',
          background: '#f9f9f9',
          borderRadius: '4px',
          fontSize: '13px',
          color: '#666'
        }}>
          <strong>💡 Tip:</strong> For Google Drive PDFs, make sure to set sharing to "Anyone with the link" 
          and use the format: <code style={{ background: '#e0e0e0', padding: '2px 4px', borderRadius: '2px' }}>
            https://drive.google.com/uc?export=download&id=FILE_ID
          </code>
        </div>
      </div>
    </div>
  );
}

// Main Editor Component
function EditorContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [showSetup, setShowSetup] = useState(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [markOverlays, setMarkOverlays] = useState<MarkOverlay[]>([]);

  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number; pageIndex: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<Rect | null>(null);
  const [showNameBox, setShowNameBox] = useState(false);
  const [nameBoxPosition, setNameBoxPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pendingMark, setPendingMark] = useState<Partial<Mark> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);
  const pdfUrl = useRef<string>('');
  const markSetId = useRef<string>('');

  const isDemo = searchParams?.get('demo') === '1';
  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const urlMarkSetId = searchParams?.get('mark_set_id') || '';

  // Check if we should show setup screen
  useEffect(() => {
    if (isDemo || (pdfUrlParam && urlMarkSetId)) {
      setShowSetup(false);
    }
  }, [isDemo, pdfUrlParam, urlMarkSetId]);

  const handleSetupComplete = (url: string, setId: string) => {
    const newUrl = `${window.location.pathname}?pdf_url=${encodeURIComponent(url)}&mark_set_id=${setId}`;
    window.location.href = newUrl;
  };

  const demoMarks: Mark[] = [
    {
      mark_id: 'demo-1',
      page_index: 0,
      order_index: 0,
      name: 'Demo Mark 1',
      nx: 0.1,
      ny: 0.1,
      nw: 0.3,
      nh: 0.15,
      zoom_hint: 1.5,
    },
  ];

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  useEffect(() => {
    if (showSetup) return;
    if (isDemo) {
      const demoPdfUrl = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
      pdfUrl.current = demoPdfUrl;

      setLoading(true);
      pdfjsLib
        .getDocument({ url: demoPdfUrl })
        .promise.then((loadedPdf) => {
          setPdf(loadedPdf);
          setNumPages(loadedPdf.numPages);
          setMarks(demoMarks);
          setLoading(false);
        })
        .catch((err) => {
          console.error('PDF load error:', err);
          setError('Failed to load PDF');
          setLoading(false);
        });
    } else {
      const targetPdfUrl = pdfUrlParam;
      pdfUrl.current = targetPdfUrl;
      markSetId.current = urlMarkSetId;

      setLoading(true);

      pdfjsLib
        .getDocument({ url: targetPdfUrl })
        .promise.then((loadedPdf) => {
          setPdf(loadedPdf);
          setNumPages(loadedPdf.numPages);
          
          if (urlMarkSetId) {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
            return fetch(`${apiBase}/mark-sets/${urlMarkSetId}/marks`)
              .then((res) => {
                if (!res.ok) throw new Error('Failed to fetch marks');
                return res.json();
              })
              .then((data: any) => {
                const sorted = [...data].sort((a: Mark, b: Mark) => a.order_index - b.order_index);
                setMarks(sorted);
                setLoading(false);
              });
          } else {
            setMarks([]);
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error('Load error:', err);
          setError('Failed to load PDF or marks');
          setLoading(false);
        });
    }
  }, [showSetup, isDemo, pdfUrlParam, urlMarkSetId]);

  useEffect(() => {
    if (!pdf) return;

    const updateOverlays = async () => {
      const overlays: MarkOverlay[] = [];

      for (const mark of marks) {
        try {
          const page = await pdf.getPage(mark.page_index + 1);
          const vp = page.getViewport({ scale: zoom });
          
          overlays.push({
            markId: mark.mark_id!,
            pageIndex: mark.page_index,
            style: {
              left: mark.nx * vp.width,
              top: mark.ny * vp.height,
              width: mark.nw * vp.width,
              height: mark.nh * vp.height,
            },
          });
        } catch (e) {
          console.error('Error computing overlay:', e);
        }
      }

      setMarkOverlays(overlays);
    };

    updateOverlays();
  }, [pdf, marks, zoom]);

  const navigateToMark = useCallback(
    (mark: Mark) => {
      if (!pdf) return;

      setSelectedMarkId(mark.mark_id || null);

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

          const targetZoom = computeZoomForRect(
            { w: container.clientWidth, h: container.clientHeight },
            { w: vp1.width, h: vp1.height },
            { w: rectAt1.w, h: rectAt1.h },
            0.75
          );

          setZoom(targetZoom);

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

            // Calculate page top position
            let pageTop = 0;
            for (let i = 0; i < mark.page_index; i++) {
              pageTop += (pageHeightsRef.current[i] || 0) + 16;
            }

            // Center the marked rectangle in the viewport
            const markCenterX = rectAtZ.x + rectAtZ.w / 2;
            const markCenterY = rectAtZ.y + rectAtZ.h / 2;
            
            const scrollLeft = markCenterX - container.clientWidth / 2;
            const scrollTop = pageTop + markCenterY - container.clientHeight / 2;

            container.scrollTo({
              left: Math.max(0, scrollLeft),
              top: Math.max(0, scrollTop),
              behavior: 'smooth',
            });
          }, 50);
        });
      }, 50);
    },
    [pdf]
  );

  const saveMarks = useCallback(async () => {
    if (isDemo) {
      addToast('Demo mode - changes not saved', 'info');
      return;
    }

    if (!markSetId.current) {
      addToast('No mark set ID provided', 'error');
      return;
    }

    if (marks.length === 0) {
      addToast('No marks to save', 'info');
      return;
    }

    const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
    addToast('Saving...', 'info');

    try {
      await fetch(`${apiBase}/mark-sets/${markSetId.current}/marks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(marks),
      });

      addToast('Saved successfully', 'success');
    } catch (err) {
      console.error('Save error:', err);
      addToast('Failed to save marks', 'error');
    }
  }, [marks, isDemo, addToast]);

  const createMark = useCallback((name: string, zoomLevel: number) => {
    if (!pendingMark) return;

    const newMark: Mark = {
      mark_id: `temp-${Date.now()}`,
      page_index: pendingMark.page_index!,
      order_index: marks.length,
      name,
      nx: pendingMark.nx!,
      ny: pendingMark.ny!,
      nw: pendingMark.nw!,
      nh: pendingMark.nh!,
      zoom_hint: zoomLevel,
    };

    setMarks((prev) => [...prev, newMark]);
    setPendingMark(null);
    setShowNameBox(false);
    setCurrentRect(null);
    addToast(`Mark "${name}" created with ${Math.round(zoomLevel * 100)}% zoom`, 'success');

    setTimeout(() => navigateToMark(newMark), 100);
  }, [pendingMark, marks.length, addToast, navigateToMark]);

  const updateMark = useCallback((markId: string, updates: Partial<Mark>) => {
    setMarks((prev) =>
      prev.map((m) => (m.mark_id === markId ? { ...m, ...updates } : m))
    );
    addToast('Mark updated', 'success');
  }, [addToast]);

  const deleteMark = useCallback((markId: string) => {
    setMarks((prev) => prev.filter((m) => m.mark_id !== markId));
    addToast('Mark deleted', 'success');
  }, [addToast]);

  const duplicateMark = useCallback((markId: string) => {
    const source = marks.find((m) => m.mark_id === markId);
    if (!source) return;

    const newMark: Mark = {
      ...source,
      mark_id: `temp-${Date.now()}`,
      name: `${source.name} (copy)`,
      order_index: marks.length,
    };

    setMarks((prev) => [...prev, newMark]);
    addToast('Mark duplicated', 'success');
  }, [marks, addToast]);

  const reorderMark = useCallback((markId: string, direction: 'up' | 'down') => {
    setMarks((prev) => {
      const index = prev.findIndex((m) => m.mark_id === markId);
      if (index === -1) return prev;

      const newIndex = direction === 'up' ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= prev.length) return prev;

      const newMarks = [...prev];
      [newMarks[index], newMarks[newIndex]] = [newMarks[newIndex], newMarks[index]];

      return newMarks.map((m, i) => ({ ...m, order_index: i }));
    });
  }, []);

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

  const handleWheel = useCallback((e: WheelEvent) => {
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
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

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
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      if (!pdf || showNameBox) return;

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setIsDrawing(true);
      setDrawStart({ x, y, pageIndex });
      setCurrentRect(null);
    },
    [pdf, showNameBox]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      if (!isDrawing || !drawStart || drawStart.pageIndex !== pageIndex) return;

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const left = Math.min(drawStart.x, x);
      const top = Math.min(drawStart.y, y);
      const width = Math.abs(x - drawStart.x);
      const height = Math.abs(y - drawStart.y);

      setCurrentRect({ x: left, y: top, w: width, h: height });
    },
    [isDrawing, drawStart]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      if (!isDrawing || !drawStart || !currentRect || drawStart.pageIndex !== pageIndex) {
        setIsDrawing(false);
        return;
      }

      if (currentRect.w < 10 || currentRect.h < 10) {
        setIsDrawing(false);
        setCurrentRect(null);
        return;
      }

      const target = e.currentTarget as HTMLElement;
      const pageWidth = target.clientWidth;
      const pageHeight = target.clientHeight;

      const normalizedMark: Partial<Mark> = {
        page_index: pageIndex,
        nx: currentRect.x / pageWidth,
        ny: currentRect.y / pageHeight,
        nw: currentRect.w / pageWidth,
        nh: currentRect.h / pageHeight,
      };

      setPendingMark(normalizedMark);

      const container = containerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const absoluteX = targetRect.left - containerRect.left + container.scrollLeft + currentRect.x;
        const absoluteY = targetRect.top - containerRect.top + container.scrollTop + currentRect.y;

        setNameBoxPosition({ x: absoluteX, y: absoluteY });
      }

      setShowNameBox(true);
      setIsDrawing(false);
    },
    [isDrawing, drawStart, currentRect]
  );

  const handlePageReady = useCallback((pageNumber: number, height: number) => {
    pageHeightsRef.current[pageNumber - 1] = height;
  }, []);

  if (showSetup) {
    return <SetupScreen onStart={handleSetupComplete} />;
  }

  if (loading) {
    return (
      <div className="editor-container">
        <div className="loading">Loading PDF...</div>
      </div>
    );
  }

  if (error || !pdf) {
    return (
      <div className="editor-container">
        <div className="error">{error || 'Failed to load'}</div>
      </div>
    );
  }

  return (
    <div className="editor-container">
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
            selectedMarkId={selectedMarkId}
            onSelect={navigateToMark}
            onUpdate={updateMark}
            onDelete={deleteMark}
            onDuplicate={duplicateMark}
            onReorder={reorderMark}
          />
        )}
        {sidebarOpen && (
          <div className="sidebar-footer">
            <button
              className="save-btn"
              onClick={saveMarks}
              disabled={marks.length === 0}
            >
              Save {marks.length} Mark{marks.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>

      <div className="main-content">
        <ZoomToolbar
          zoom={zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={resetZoom}
          onFit={fitToWidthZoom}
        />

        <div className="pdf-surface-wrap" ref={containerRef}>
          <div className="pdf-surface">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <div
                key={pageNum}
                className="page-container"
                onMouseDown={(e) => handleMouseDown(e, pageNum - 1)}
                onMouseMove={(e) => handleMouseMove(e, pageNum - 1)}
                onMouseUp={(e) => handleMouseUp(e, pageNum - 1)}
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
                {isDrawing && drawStart?.pageIndex === pageNum - 1 && currentRect && (
                  <div
                    className="drawing-rect"
                    style={{
                      left: currentRect.x,
                      top: currentRect.y,
                      width: currentRect.w,
                      height: currentRect.h,
                    }}
                  />
                )}
                {markOverlays
                  .filter((overlay) => overlay.pageIndex === pageNum - 1)
                  .map((overlay) => (
                    <div
                      key={overlay.markId}
                      className={`mark-rect ${selectedMarkId === overlay.markId ? 'selected' : ''}`}
                      style={overlay.style}
                      onClick={() => {
                        const mark = marks.find((m) => m.mark_id === overlay.markId);
                        if (mark) navigateToMark(mark);
                      }}
                    />
                  ))}
              </div>
            ))}
          </div>

          {showNameBox && (
            <FloatingNameBox
              position={nameBoxPosition}
              onSave={(name, zoomLevel) => createMark(name, zoomLevel)}
              onCancel={() => {
                setShowNameBox(false);
                setPendingMark(null);
                setCurrentRect(null);
              }}
            />
          )}
        </div>
      </div>

      <div className="toast-container">
        {toasts.map((toast) => (
          <Toast key={toast.id} message={toast.message} type={toast.type} />
        ))}
      </div>
    </div>
  );
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="editor-container"><div className="loading">Loading...</div></div>}>
      <EditorContent />
    </Suspense>
  );
}