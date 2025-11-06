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
import { clampZoom } from '../lib/pdf';
import PDFSearch from '../components/PDFSearch';
import { applyLabels, indexToLabel } from '../lib/labels';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
// Clean nested Cloudinary URLs
// Clean nested Cloudinary URLs - DEBUG VERSION
function cleanPdfUrl(url: string): string {
  console.log('🔍 [cleanPdfUrl] INPUT:', url);
  
  if (!url) {
    console.log('❌ [cleanPdfUrl] Empty URL');
    return url;
  }
  
  // Decode URL-encoded string to find nested URLs
  let decoded = url;
  try {
    let prev = '';
    let iterations = 0;
    while (decoded !== prev && iterations < 5) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
      iterations++;
      console.log(`🔄 [cleanPdfUrl] Decode iteration ${iterations}:`, decoded.substring(0, 100) + '...');
    }
  } catch (e) {
    console.warn('⚠️ [cleanPdfUrl] Decode failed, using original');
    decoded = url;
  }
  
  // Extract Google Storage URL
  const match = decoded.match(/https:\/\/storage\.googleapis\.com\/[^\s"'<>)]+\.pdf/i);
  if (match) {
    const cleaned = match[0].replace(/ /g, '%20');
    console.log('✅ [cleanPdfUrl] OUTPUT:', cleaned);
    return cleaned;
  }
  
  console.log('⚠️ [cleanPdfUrl] No Google Storage URL found, returning original');
  return url;
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
  label?: string; // ✅ NEW
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
// ---- Normalizers ----
function normalizeMarks(arr: Mark[]): Mark[] {
  // 1) ensure every mark has a stable id
  const withIds = arr.map((m, i) =>
    m.mark_id ? m : { ...m, mark_id: `m-${i}-${Date.now()}` }
  );

  // 2) reindex order_index to match array order
  const withOrder = withIds.map((m, i) => ({ ...m, order_index: i }));

  // 3) compute labels from order_index
  return applyLabels(withOrder);
}

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
    // Clean the URL
    const cleanedUrl = cleanPdfUrl(pdfUrl.trim());
    setIsCreating(true);
    setError('');

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
      const response = await fetch(`${apiBase}/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdf_url: cleanedUrl,
          name: markSetName.trim()
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create mark set');
      }

      const data = await response.json();
      onStart(cleanedUrl, data.id);
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
  // Gap between pages in .pdf-surface-wrap
const PAGE_GAP = 16;

/** Top scroll offset for a given 0-based page index */
const pageTopFor = useCallback((pageIndex: number) => {
  let top = PAGE_GAP; // initial padding
  for (let i = 0; i < pageIndex; i++) {
    top += (pageHeightsRef.current[i] || 0) + PAGE_GAP;
  }
  return top;
}, []);

// Keep IDs, order_index, labels in sync after any change
useEffect(() => {
  setMarks((prev) => {
    if (prev.length === 0) return prev;

    const normalized = normalizeMarks(prev);

    const changed =
      normalized.length !== prev.length ||
      normalized.some((m, i) =>
        m.mark_id !== prev[i].mark_id ||
        m.order_index !== prev[i].order_index ||
        m.label !== prev[i].label
      );

    return changed ? normalized : prev;
  });
}, [marks]);


  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [markOverlays, setMarkOverlays] = useState<MarkOverlay[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchHighlights, setSearchHighlights] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [highlightPageNumber, setHighlightPageNumber] = useState<number>(0);

  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number; pageIndex: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<Rect | null>(null);
  const [showNameBox, setShowNameBox] = useState(false);
  const [nameBoxPosition, setNameBoxPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pendingMark, setPendingMark] = useState<Partial<Mark> | null>(null);
  
  // Mark editing states
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'move' | 'resize' | null>(null);
  const [editStart, setEditStart] = useState<{ x: number; y: number; rect: Rect } | null>(null);

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
    // Clean URL one more time before adding to query params
    const finalUrl = cleanPdfUrl(url);
    const newUrl = `${window.location.pathname}?pdf_url=${encodeURIComponent(finalUrl)}&mark_set_id=${setId}`;
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
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const proxiedUrl = `${apiBase}/proxy-pdf?url=${encodeURIComponent(demoPdfUrl)}`;
  pdfUrl.current = proxiedUrl;

  setLoading(true);
  pdfjsLib
    .getDocument({ url: proxiedUrl })
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
  const targetPdfUrl = cleanPdfUrl(pdfUrlParam);  // ✅ Clean before proxying
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const proxiedUrl = `${apiBase}/proxy-pdf?url=${encodeURIComponent(targetPdfUrl)}`;
  
  pdfUrl.current = proxiedUrl;
  markSetId.current = urlMarkSetId;

  setLoading(true);

  pdfjsLib
    .getDocument({ url: proxiedUrl })
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
  setMarks(normalizeMarks(sorted));
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

// Track current page while user scrolls (manual scroll -> toolbar updates)
useEffect(() => {
  const container = containerRef.current;
  if (!container) return;

  let raf = 0;

  const computeCurrentPage = () => {
    const scrollTop = container.scrollTop;
    const pages = numPages;

    let found = 1;
    let top = PAGE_GAP; // same gap as jumpToPage/pageTopFor
    for (let i = 0; i < pages; i++) {
      const h = pageHeightsRef.current[i] || 0;
      const midpoint = top + h / 2;
      if (scrollTop < midpoint) {
        found = i + 1;
        break;
      }
      top += h + PAGE_GAP;
    }
    setCurrentPage(found);
  };

  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      computeCurrentPage();
    });
  };

  container.addEventListener('scroll', onScroll, { passive: true });

  // Initial sync (in case we mount mid-document or after a jump/zoom)
  computeCurrentPage();

  return () => {
    container.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}, [numPages, zoom]); // re-evaluate when page count or zoom changes

// ✅ NEW: Jump to specific page
const jumpToPage = useCallback((pageNumber: number) => {
  const container = containerRef.current;
  if (!container) return;

  const top = pageTopFor(pageNumber - 1);
  container.scrollTo({ left: 0, top, behavior: 'smooth' });

  // keep the toolbar in sync immediately
  setCurrentPage(pageNumber);
}, [pageTopFor]);


const navigateToMark = useCallback((mark: Mark) => {
  const container = containerRef.current;
  if (!container) return;

  setSelectedMarkId(mark.mark_id || null);

  // compute where that page starts
  const targetTop = pageTopFor(mark.page_index);
  const curTop = container.scrollTop;
  const pageH = pageHeightsRef.current[mark.page_index] || 0;

  // robust "same page" check that does NOT rely on currentPage state
  const samePage = curTop > (targetTop - pageH / 2) && curTop < (targetTop + pageH / 2);

  if (!samePage) {
    container.scrollTo({ left: 0, top: targetTop, behavior: 'smooth' });
    setCurrentPage(mark.page_index + 1); // sync toolbar right away
  }
}, [pageTopFor]);


        
  
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
        body: JSON.stringify(applyLabels(marks)),
      });

      addToast('Saved successfully', 'success');
    } catch (err) {
      console.error('Save error:', err);
      addToast('Failed to save marks', 'error');
    }
  }, [marks, isDemo, addToast]);

  // ✅ NEW: Check for duplicate names and overlapping areas (client-side only - NO API calls)
  const checkDuplicates = useCallback((name: string, pageIndex: number, nx: number, ny: number, nw: number, nh: number): string | null => {
    // Check for duplicate names
    const duplicateName = marks.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (duplicateName) {
      return `⚠️ A mark named "${name}" already exists. Continue anyway?`;
    }

    // Check for overlapping marks on the same page
    const marksOnSamePage = marks.filter(m => m.page_index === pageIndex);
    
    for (const existingMark of marksOnSamePage) {
      // Calculate overlap
      const x1 = Math.max(nx, existingMark.nx);
      const y1 = Math.max(ny, existingMark.ny);
      const x2 = Math.min(nx + nw, existingMark.nx + existingMark.nw);
      const y2 = Math.min(ny + nh, existingMark.ny + existingMark.nh);

      // Check if there's overlap
      if (x1 < x2 && y1 < y2) {
        const overlapArea = (x2 - x1) * (y2 - y1);
        const mark1Area = nw * nh;
        const mark2Area = existingMark.nw * existingMark.nh;
        const overlapPercentage = (overlapArea / Math.min(mark1Area, mark2Area)) * 100;

        // If more than 30% overlap, warn user
        if (overlapPercentage > 30) {
          return `⚠️ This mark overlaps ${Math.round(overlapPercentage)}% with "${existingMark.name}". Continue anyway?`;
        }
      }
    }

    return null; // No duplicates found
  }, [marks]);

const createMark = useCallback((name: string) => {
  if (!pendingMark || !pdf) return;

  // Duplicate/overlap check
  const duplicateWarning = checkDuplicates(
    name,
    pendingMark.page_index!,
    pendingMark.nx!,
    pendingMark.ny!,
    pendingMark.nw!,
    pendingMark.nh!
  );
  if (duplicateWarning && !window.confirm(duplicateWarning)) return;

  const newMark: Mark = {
    mark_id: `temp-${Date.now()}`,
    page_index: pendingMark.page_index!,
    order_index: marks.length,
    name: name || '',         // allow blank name
    nx: pendingMark.nx!,
    ny: pendingMark.ny!,
    nw: pendingMark.nw!,
    nh: pendingMark.nh!,
    zoom_hint: null,          // viewer-side "Auto"
  };

  setMarks((prev) => [...prev, newMark]);
  setPendingMark(null);
  setShowNameBox(false);
  setCurrentRect(null);

  addToast(`Mark "${name || '(no name)'}" created`, 'success');

  // Do NOT auto-scroll/center/zoom after creation
  // If you want it to just highlight (no scroll), uncomment:
  setSelectedMarkId(newMark.mark_id!);
}, [pendingMark, marks.length, addToast, pdf, checkDuplicates]);

  const updateMark = useCallback((markId: string, updates: Partial<Mark>) => {
    setMarks((prev) =>
      prev.map((m) => (m.mark_id === markId ? { ...m, ...updates } : m))
    );
    addToast('Mark updated', 'success');
  }, [addToast]);

const deleteMark = useCallback((markId: string) => {
  setMarks((prev) => normalizeMarks(prev.filter((m) => m.mark_id !== markId)));
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

    return normalizeMarks(newMarks);
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

const finalizeAndDownload = useCallback(async () => {
  try {
    const res = await fetch(pdfUrl.current);
    const srcBytes: ArrayBuffer = await res.arrayBuffer();

    const doc = await PDFDocument.load(srcBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const toDraw = applyLabels(marks);
    toDraw.forEach(m => {
      const page = doc.getPage(m.page_index);
      const { width, height } = page.getSize();

      const x = m.nx * width;
      const w = m.nw * width;
      const y = (1 - m.ny - m.nh) * height;
      const h = m.nh * height;

      page.drawRectangle({
        x, y, width: w, height: h,
        borderWidth: 2,
        color: undefined,
        borderColor: rgb(0.0, 0.55, 0.2)
      });

// Stroke used on the rectangle; nudge the circle to hug the corner
const stroke = 2;

// Circle radius (same scaling)
const r = Math.max(8, Math.min(12, Math.min(w, h) * 0.06));

// Smaller pad for export (PDF only)
const PAD_PDF = 0.75; // ↓ make this 0.5 if you want it even tighter

// Top-left corner in PDF coords
const cornerX = x;
const cornerY = y + h;

// Circle center just outside the corner, adjusted for stroke so it sits closer
const circleCX = cornerX - r - PAD_PDF + stroke / 2;
const circleCY = cornerY + r + PAD_PDF - stroke / 2;

// Draw the circle
page.drawCircle({
  x: circleCX,
  y: circleCY,
  size: r,
  borderWidth: 1.5,
  borderColor: rgb(0, 0, 0),
  color: undefined,
});


// Draw the label centered in the circle
const label = m.label ?? indexToLabel(m.order_index);
const textSize = r;
const textWidth = font.widthOfTextAtSize(label, textSize);
const textX = circleCX - textWidth / 2;
const textY = circleCY - textSize / 3;

page.drawText(label, {
  x: textX,
  y: textY,
  size: textSize,
  font,
  color: rgb(0, 0, 0),
});

    });

// 4) download
const pdfBytes: Uint8Array = await doc.save(); // explicit
const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'marked-document.pdf';
a.click();
URL.revokeObjectURL(a.href);



    addToast('PDF generated', 'success');
  } catch (e) {
    console.error(e);
    addToast('Failed to generate PDF', 'error');
  }
}, [marks, addToast]);


  // Wheel zoom - prevent browser zoom, only zoom PDF (SLOWER SPEED)
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Check if event is within PDF container
      const target = e.target as HTMLElement;
      if (!container.contains(target)) return;

      // Check if it's a zoom gesture
      if (!e.ctrlKey && !e.metaKey) return;

      // STOP browser zoom
      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;
      const contentX = scrollLeft + mouseX;
      const contentY = scrollTop + mouseY;
      
      // SLOWER zoom speed - reduced from 0.9/1.1 to 0.95/1.05
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

    // Add to DOCUMENT to catch before browser
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    
    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);
    // Ctrl+F / Cmd+F to open search
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
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      if (!pdf || showNameBox) return;

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if clicking on existing mark overlay
      const clickedOverlay = markOverlays.find(overlay => {
        if (overlay.pageIndex !== pageIndex) return false;
        const { left, top, width, height } = overlay.style;
        return x >= left && x <= left + width && y >= top && y <= top + height;
      });

      if (clickedOverlay) {
        // Start editing existing mark
        const mark = marks.find(m => m.mark_id === clickedOverlay.markId);
        if (mark) {
          setEditingMarkId(clickedOverlay.markId);
          const { left, top, width, height } = clickedOverlay.style;
          
          // Check if near edge (resize) or center (move)
          const isNearEdge = 
            x < left + 10 || x > left + width - 10 ||
            y < top + 10 || y > top + height - 10;
          
          setEditMode(isNearEdge ? 'resize' : 'move');
          setEditStart({
            x,
            y,
            rect: { x: left, y: top, w: width, h: height }
          });
          e.stopPropagation();
          return;
        }
      }

      // Normal drawing mode
      setIsDrawing(true);
      setDrawStart({ x, y, pageIndex });
      setCurrentRect(null);
    },
    [pdf, showNameBox, markOverlays, marks]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Handle mark editing (move/resize)
      if (editingMarkId && editStart && editMode) {
        const dx = x - editStart.x;
        const dy = y - editStart.y;

        if (editMode === 'move') {
          // Move the mark
          const newX = Math.max(0, editStart.rect.x + dx);
          const newY = Math.max(0, editStart.rect.y + dy);
          
          // Update mark overlay temporarily
          setMarkOverlays(prev => prev.map(overlay => {
            if (overlay.markId === editingMarkId) {
              return {
                ...overlay,
                style: {
                  ...overlay.style,
                  left: newX,
                  top: newY
                }
              };
            }
            return overlay;
          }));
        } else if (editMode === 'resize') {
          // Resize the mark
          const newW = Math.max(20, editStart.rect.w + dx);
          const newH = Math.max(20, editStart.rect.h + dy);
          
          setMarkOverlays(prev => prev.map(overlay => {
            if (overlay.markId === editingMarkId) {
              return {
                ...overlay,
                style: {
                  ...overlay.style,
                  width: newW,
                  height: newH
                }
              };
            }
            return overlay;
          }));
        }
        return;
      }

      // Handle normal drawing
      if (!isDrawing || !drawStart || drawStart.pageIndex !== pageIndex) return;

      const left = Math.min(drawStart.x, x);
      const top = Math.min(drawStart.y, y);
      const width = Math.abs(x - drawStart.x);
      const height = Math.abs(y - drawStart.y);

      setCurrentRect({ x: left, y: top, w: width, h: height });
    },
    [isDrawing, drawStart, editingMarkId, editStart, editMode]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      // Handle mark editing finish
      if (editingMarkId && editMode) {
        const overlay = markOverlays.find(o => o.markId === editingMarkId);
        if (overlay) {
          const target = e.currentTarget as HTMLElement;
          const pageWidth = target.clientWidth;
          const pageHeight = target.clientHeight;

          // Update the actual mark with new normalized coordinates
          const updatedMark: Partial<Mark> = {
            nx: overlay.style.left / pageWidth,
            ny: overlay.style.top / pageHeight,
            nw: overlay.style.width / pageWidth,
            nh: overlay.style.height / pageHeight,
          };

          updateMark(editingMarkId, updatedMark);
        }

        setEditingMarkId(null);
        setEditMode(null);
        setEditStart(null);
        return;
      }

      // Handle normal drawing finish
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
    [isDrawing, drawStart, currentRect, editingMarkId, editMode, markOverlays, updateMark]
  );

  const handlePageReady = useCallback((pageNumber: number, height: number) => {
    pageHeightsRef.current[pageNumber - 1] = height;
  }, []);

const handleSearchResult = useCallback((pageNumber: number, highlights: any[]) => {
  setHighlightPageNumber(pageNumber);
  setSearchHighlights(highlights);
  jumpToPage(pageNumber);
}, [jumpToPage]);

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
  currentPage={currentPage}
  totalPages={numPages}
  onPageJump={jumpToPage}
  onFinalize={finalizeAndDownload}
/>


        <div className="pdf-surface-wrap" ref={containerRef} style={{ touchAction: 'pan-y pan-x' }}>
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
                
                {/* Search Highlights */}
                {highlightPageNumber === pageNum && searchHighlights.map((highlight, idx) => (
                  <div
                    key={`highlight-${idx}`}
                    style={{
                      position: 'absolute',
                      left: highlight.x * zoom,
                      top: highlight.y * zoom,
                      width: highlight.width * zoom,
                      height: highlight.height * zoom,
                      background: 'rgba(255, 235, 59, 0.4)',
                      border: '1px solid rgba(255, 193, 7, 0.8)',
                      pointerEvents: 'none',
                      zIndex: 100,
                    }}
                  />
                ))}
                {isDrawing && drawStart?.pageIndex === pageNum - 1 && currentRect && (
                  <div
                    className="drawing-rect"
                    style={{
                      left: currentRect.x,
                      top: currentRect.y,
                      width: currentRect.w,
                      height: currentRect.h,
                      pointerEvents: 'none'
                    }}
                  />
                )}
{markOverlays
  .filter((overlay) => overlay.pageIndex === pageNum - 1)
  .map((overlay) => {
    const mark = marks.find((m) => m.mark_id === overlay.markId);
    const label = mark?.label ?? indexToLabel(mark?.order_index ?? 0);

    return (
      <div
        key={overlay.markId}
        className={`mark-rect ${selectedMarkId === overlay.markId ? 'selected' : ''} ${editingMarkId === overlay.markId ? 'editing' : ''}`}
        style={{
          position: 'absolute',
          left: overlay.style.left,
          top: overlay.style.top,
          width: overlay.style.width,
          height: overlay.style.height,
          cursor: editingMarkId === overlay.markId ? (editMode === 'move' ? 'move' : 'nwse-resize') : 'pointer',
          transition: editingMarkId === overlay.markId ? 'none' : 'all 0.2s',
          zIndex: editingMarkId === overlay.markId ? 10 : 5,
        }}
        onClick={(e) => {
          if (editingMarkId) return;
          if (mark) navigateToMark(mark);
        }}
      >
        {(() => {
          const w = overlay.style.width;
          const h = overlay.style.height;
          const r = Math.max(8, Math.min(12, Math.min(w, h) * 0.06));
          const pad = 2;
          const diameter = 2 * r;

          return (
            <div
              style={{
                position: 'absolute',
                left: -(diameter + pad),
                top: -(diameter + pad),
                width: diameter,
                height: diameter,
                borderRadius: '50%',
                border: '2px solid #000',
                background: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 600,
                fontSize: r,
                lineHeight: 1,
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            >
              {label}
            </div>
          );
        })()}
      </div>
    );
  })}


  
              </div>
            ))}
          </div>

          {showNameBox && (
            <FloatingNameBox
  position={nameBoxPosition}
  onSave={(name) => createMark(name)}
  onCancel={() => {
    setShowNameBox(false);
    setPendingMark(null);
    setCurrentRect(null);
  }}
/>

          )}
                    {/* PDF Search Component */}
          <PDFSearch
            pdf={pdf}
            isOpen={showSearch}
            onClose={() => setShowSearch(false)}
            onResultFound={handleSearchResult}
          />
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