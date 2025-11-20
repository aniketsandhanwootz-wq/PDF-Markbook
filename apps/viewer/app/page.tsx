'use client';

import type { MutableRefObject, CSSProperties } from 'react';
import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSwipeable } from 'react-swipeable';
import toast, { Toaster } from 'react-hot-toast';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import FloatingHUD from '../components/FloatingHUD';
import InputPanel from '../components/InputPanel';
import ReviewScreen from '../components/ReviewScreen';
import { clampZoom } from '../lib/pdf';
import PDFSearch from '../components/PDFSearch';
import SlideSidebar from '../components/SlideSidebar';



pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

/// Clean nested Cloudinary URLs
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
// --- smooth zoom helpers ---
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// ease-out cubic for pleasant feel
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
// PATCH[page.tsx] — add quantized zoom helpers (place after easeOutCubic)
const quantize = (z: number) => {
  // 2-decimal quantization stabilizes cache & reduces re-renders
  const q = Math.round(clampZoom(z) * 100) / 100;
  return q;
};



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
  label?: string;
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

type GroupWindowMeta = {
  group_id: string;
  name: string;
  startIndex: number;  // inclusive in marks[]
  endIndex: number;    // inclusive in marks[]
  page_index: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
};

const SWIPE_TO_STEP_ENABLED = false;
// === Touch gestures master switch (leave OFF to allow native scroll) ===
const TOUCH_GESTURES_ENABLED = false;
// Reserve some space so PDF content doesn't hide under the floating HUD buttons
const HUD_TOP_SAFE_PX = 72;   // approx height of top HUD bar
const HUD_SIDE_SAFE_PX = 90;  // approx width taken by right zoom buttons

// Reserve space at the bottom for the blue InputPanel (mostly mobile)
const INPUT_PANEL_SAFE_PX_MOBILE = 190; // ≈ height of InputPanel + padding

// ------- New types for bootstrap + markset summary -------
type BootstrapDoc = {
  document: {
    doc_id: string;
    project_name: string;
    id: string;            // external_id
    part_number: string;
    pdf_url: string;
    page_count: number;
  };
  mark_sets: Array<{
    mark_set_id: string;
    label: string;
    is_master: boolean;
    is_active: boolean;
    created_by: string;
    created_at: string;
    updated_by: string;
    marks_count?: number;
    description?: string | null;   // 👈 NEW
  }>;
  master_mark_set_id?: string | null;
  mark_set_count: number;
  status?: string;
};


type CreateDocMarkSetBody = {
  project_name: string;
  id: string;
  part_number: string;
  label: string;
  created_by?: string | null;
  is_master?: boolean;
};
function ViewerSetupScreen({ onStart }: { onStart: (pdfUrl: string, markSetId: string) => void }) {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const params = useSearchParams();

  // Query inputs
  const [projectName, setProjectName] = useState<string>(params?.get('project_name') || '');
  const [extId, setExtId] = useState<string>(params?.get('id') || '');
  const [partNumber, setPartNumber] = useState<string>(params?.get('part_number') || '');
  const [userMail, setUserMail] = useState<string>(params?.get('user_mail') || '');
  const [assemblyDrawing, setAssemblyDrawing] = useState<string>(params?.get('assembly_drawing') || '');

  // Bootstrap state
  const [boot, setBoot] = useState<BootstrapDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>('');

  // 👉 NEW: computed marks count for QC marksets
  const [qcMarkCounts, setQcMarkCounts] = useState<Record<string, number>>({});

  const hasBootstrapKeys =
    projectName.trim() && extId.trim() && partNumber.trim() && assemblyDrawing.trim();

  const runBootstrap = async () => {
    setErr('');
    try {
      setLoading(true);
      const res = await fetch(`${apiBase}/documents/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: projectName,
          id: extId,
          part_number: partNumber,
          user_mail: userMail || undefined,
          pdf_url: undefined,
          assembly_drawing: assemblyDrawing,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: BootstrapDoc = await res.json();
      setBoot(data);
    } catch (e: any) {
      console.error(e);
      setErr('Failed to initialize document.');
    } finally {
      setLoading(false);
    }
  };

  // Auto-bootstrap when keys present
  useEffect(() => {
    if (!boot && hasBootstrapKeys && !loading) {
      runBootstrap();
    }
  }, [hasBootstrapKeys]);

  // 👉 For each QC markset, fetch groups and compute TOTAL mark steps
  //     (no de-duplication) so this matches what the viewer/HUD sees.
  useEffect(() => {
    if (!boot) return;

    const qcSets = boot.mark_sets.filter((ms) => !ms.is_master);
    if (qcSets.length === 0) {
      setQcMarkCounts({});
      return;
    }

    let cancelled = false;

    (async () => {
      const result: Record<string, number> = {};

      await Promise.all(
        qcSets.map(async (ms) => {
          try {
            const res = await fetch(`${apiBase}/viewer/groups/${ms.mark_set_id}`);
            if (!res.ok) return;

            const data = await res.json();
            const groups: any[] = data.groups || [];

            // count ALL marks in all groups (steps in the viewer)
            let total = 0;
            for (const g of groups) {
              total += (g.marks || []).length;
            }

            result[ms.mark_set_id] = total;
          } catch (e) {
            console.warn('Failed to compute QC mark count for', ms.mark_set_id, e);
          }
        })
      );

      if (!cancelled) {
        setQcMarkCounts(result);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boot, apiBase]);

  const handleOpenMarkset = (markSetId: string) => {
    if (!boot?.document?.pdf_url) {
      setErr('No PDF URL on document.');
      return;
    }
    onStart(boot.document.pdf_url, markSetId);
  };

  const masterMarkset = boot?.mark_sets.find((ms) => ms.is_master);
  const otherMarksets = boot?.mark_sets.filter((ms) => !ms.is_master) || [];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f5f5',
        padding: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#fff',
          width: '100%',
          maxWidth: 860,
          borderRadius: 8,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
          PDF Mark Viewer — Markbook
        </h1>
        <p style={{ color: '#666', marginBottom: 18 }}>
          Pick a mark set to start reviewing.
        </p>

        {!hasBootstrapKeys && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr 1fr',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <input
                placeholder="Project Name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                style={inp}
              />
              <input
                placeholder="ID (Business ID)"
                value={extId}
                onChange={(e) => setExtId(e.target.value)}
                style={inp}
              />
              <input
                placeholder="Part Number"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                style={inp}
              />
              <input
                placeholder="Your Email (optional)"
                value={userMail}
                onChange={(e) => setUserMail(e.target.value)}
                style={inp}
              />
            </div>

            <input
              placeholder="assembly_drawing / PDF URL"
              value={assemblyDrawing}
              onChange={(e) => setAssemblyDrawing(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 12 }}
            />

            {err && (
              <div
                style={{
                  background: '#ffebee',
                  color: '#c62828',
                  padding: 10,
                  borderRadius: 4,
                  marginBottom: 12,
                }}
              >
                {err}
              </div>
            )}

            {!boot ? (
              <button onClick={runBootstrap} disabled={loading} style={btnPrimary}>
                {loading ? 'Bootstrapping…' : 'Bootstrap Document'}
              </button>
            ) : null}
          </>
        )}

        {hasBootstrapKeys && !boot && (
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              background: '#f9f9f9',
              border: '1px solid #eee',
            }}
          >
            Initializing document… please wait.
          </div>
        )}

        {boot && (
          <>
            {err && (
              <div
                style={{
                  background: '#ffebee',
                  color: '#c62828',
                  padding: 10,
                  borderRadius: 4,
                  marginTop: 12,
                }}
              >
                {err}
              </div>
            )}

            {/* Master Mark Set */}
            {masterMarkset && (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>⭐ Master Mark Set</div>
                </div>
                <div
                  style={{
                    border: '2px solid #ffc107',
                    borderRadius: 6,
                    padding: 12,
                    background: '#fffde7',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 16,
                          color: '#333',
                        }}
                      >
                        {masterMarkset.label}
                      </div>

                      {masterMarkset.description && (
                        <div
                          style={{
                            color: '#444',
                            fontSize: 12,
                            marginTop: 4,
                            whiteSpace: 'normal',
                            wordBreak: 'break-word',
                          }}
                        >
                          {masterMarkset.description}
                        </div>
                      )}

                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: '#666',
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span>
                          {(masterMarkset.marks_count ?? 0)} marks
                        </span>
                        {masterMarkset.created_by && (
                          <span>• by {masterMarkset.created_by}</span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleOpenMarkset(masterMarkset.mark_set_id)}
                      style={{
                        ...btn,
                        background: '#1976d2',
                        color: '#fff',
                        border: 'none',
                      }}
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Other Mark Sets */}
            {otherMarksets.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>Other Mark Sets</div>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {otherMarksets.map((ms) => {
                    const count =
                      ms.is_master
                        ? ms.marks_count ?? 0
                        : qcMarkCounts[ms.mark_set_id] ??
                        ms.marks_count ??
                        0;

                    return (
                      <div
                        key={ms.mark_set_id}
                        style={{
                          border: '1px solid #ddd',
                          borderRadius: 6,
                          padding: 10,
                          background: '#fff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <div>
                          <div
                            style={{ fontWeight: 600, color: '#333' }}
                          >
                            {ms.label}
                          </div>

                          {ms.description && (
                            <div
                              style={{
                                color: '#444',
                                fontSize: 12,
                                marginTop: 4,
                                whiteSpace: 'normal',
                                wordBreak: 'break-word',
                              }}
                            >
                              {ms.description}
                            </div>
                          )}

                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              color: '#666',
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span>{count} marks</span>
                            {ms.created_by && (
                              <span>• by {ms.created_by}</span>
                            )}
                          </div>
                        </div>

                        <button
                          onClick={() => handleOpenMarkset(ms.mark_set_id)}
                          style={btn}
                        >
                          Open
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!masterMarkset && otherMarksets.length === 0 && (
              <div
                style={{
                  marginTop: 16,
                  textAlign: 'center',
                  color: '#666',
                }}
              >
                No mark sets yet.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


// small styles for setup
const inp: CSSProperties = { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, outline: 'none' };
const btn: CSSProperties = { padding: '8px 14px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const btnPrimary: CSSProperties = { ...btn, borderColor: '#1976d2', color: '#1976d2', fontWeight: 700 };

// Main Viewer Component
function ViewerContent() {
  const searchParams = useSearchParams();
  const [showSetup, setShowSetup] = useState(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  // Quantized zoom setter (must live at component top-level)
  const setZoomQ = useCallback(
    (z: number, ref?: MutableRefObject<number>) => {
      const q = quantize(z);
      setZoom(q);
      if (ref) ref.current = q;
      return q;
    },
    []
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
    // Sidebar: start open only on large *non-touch* screens (real desktop)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return false;

    const w = window.innerWidth;
    const isTouch =
      'ontouchstart' in window || (navigator as any).maxTouchPoints > 0;

    // Only auto-open on big, non-touch displays
    return !isTouch && w >= 1024;
  });

  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  const [selectedRect, setSelectedRect] = useState<FlashRect>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchHighlights, setSearchHighlights] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [highlightPageNumber, setHighlightPageNumber] = useState<number>(0);
  const [isMobileInputMode, setIsMobileInputMode] = useState(false);

  // Input mode states
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [showReview, setShowReview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Markset meta + grouping for QC flows
  const [isMasterMarkSet, setIsMasterMarkSet] = useState<boolean | null>(null);
  const [groupWindows, setGroupWindows] = useState<GroupWindowMeta[] | null>(null);
  const [markToGroupIndex, setMarkToGroupIndex] = useState<number[]>([]);

  // Refs used by the viewer and smooth zoom
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);
  const pageElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const basePageSizeRef = useRef<Array<{ w: number; h: number }>>([]);


  // keep current zoom in a ref for synchronous math
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // smooth zoom animation bookkeeping
  const animRafRef = useRef<number | null>(null);
  const isZoomAnimatingRef = useRef(false);
  // ===== Windowing + prefix sums =====
  const GUTTER = 16; // vertical gap between pages
  const prefixHeightsRef = useRef<number[]>([]);   // top offsets of each page at current zoom
  const totalHeightRef = useRef<number>(0);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 3]); // 1-based inclusive

  function lowerBound(a: number[], x: number) { // first idx with a[idx] >= x
    let l = 0, r = a.length;
    while (l < r) { const m = (l + r) >> 1; a[m] < x ? (l = m + 1) : (r = m); }
    return l;
  }
  function upperBound(a: number[], x: number) { // first idx with a[idx] > x
    let l = 0, r = a.length;
    while (l < r) { const m = (l + r) >> 1; a[m] <= x ? (l = m + 1) : (r = m); }
    return l;
  }

  /** Recompute prefix tops from *base* page sizes (scale=1) and the current zoom. */
  const recomputePrefix = useCallback(() => {
    const base = basePageSizeRef.current; // [{w,h}] at scale=1, already filled elsewhere
    if (!base || base.length === 0) return;
    const n = base.length;
    const pref = new Array(n);
    let run = 0;
    for (let i = 0; i < n; i++) {
      pref[i] = run;
      run += base[i].h * zoomRef.current + GUTTER;
    }
    prefixHeightsRef.current = pref;           // pref[i] = CSS top of page i (0-based)
    totalHeightRef.current = run - GUTTER;     // overall scrollable height
  }, []);

  // ===== Windowing range calc (uses prefixHeights) =====
  const VBUF = 1; // render ±1 page buffer around viewport

  const updateVisibleRange = useCallback(() => {
    const cont = containerRef.current;
    const pref = prefixHeightsRef.current;
    if (!cont || pref.length === 0) return;

    const viewTop = cont.scrollTop;
    const viewBot = viewTop + cont.clientHeight;

    const lower = lowerBound(pref, viewTop);
    const upper = Math.max(lower, upperBound(pref, viewBot));

    const start = Math.max(1, lower + 1 - VBUF);                // 1-based
    const end = Math.min(numPages, upper + 1 + VBUF);
    setVisibleRange([start, end]);

    // Set current page near the viewport midpoint
    const mid = viewTop + cont.clientHeight / 2;
    const idx = Math.min(pref.length - 1, lowerBound(pref, mid));
    setCurrentPage(idx + 1);
  }, [numPages]);

  // Bind scroll + rAF-throttled resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => updateVisibleRange();

    let raf: number | null = null;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        recomputePrefix();
        updateVisibleRange();
        raf = null;
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    // initial compute
    updateVisibleRange();

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize as any);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [updateVisibleRange, recomputePrefix]);

  // ===== IntersectionObserver prefetch (tiny, gated) =====
  useEffect(() => {
    const conn = (navigator as any).connection;
    const ok = conn?.effectiveType ? (conn.effectiveType === '4g') : true; // default allow on desktops
    if (!ok || !pdf) return;

    const root = containerRef.current;
    if (!root) return;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const page = Number((e.target as HTMLElement).dataset.page || '0');
        // prefetch next/prev once
        if (page + 1 <= numPages) pdf.getPage(page + 1).catch(() => { });
        if (page - 1 >= 1) pdf.getPage(page - 1).catch(() => { });
      }
    }, { root, rootMargin: '600px 0px' });

    // Observe currently visible page nodes
    const nodes = pageElsRef.current;
    nodes.forEach((node, idx) => {
      if (!node) return;
      node.dataset.page = String(idx + 1);
      io.observe(node);
    });

    return () => { io.disconnect(); };
  }, [pdf, numPages, visibleRange]);


  // Smooth animated zoom that keeps the same focal point centered
  // Smooth animated zoom that keeps the same focal point centered
  const smoothZoom = useCallback(
    (toZoomRaw: number, durationMs = 240) => {
      const container = containerRef.current;
      if (!container) return;

      const toZoom = clampZoom(toZoomRaw);

      // cancel an in-flight animation
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);

      const startZoom = zoomRef.current;
      if (Math.abs(toZoom - startZoom) < 1e-4) return;

      // anchor at the center of the viewport
      const anchorX = container.clientWidth / 2;
      const anchorY = container.clientHeight / 2;

      // content coords under that anchor at start
      const contentX = container.scrollLeft + anchorX;
      const contentY = container.scrollTop + anchorY;

      const mark = marks[currentMarkIndex];                 // ⬅️ use current mark
      const base = mark ? basePageSizeRef.current[mark.page_index] : undefined;

      const t0 = performance.now();
      isZoomAnimatingRef.current = true;

      const step = (now: number) => {
        const t = Math.min(1, durationMs === 0 ? 1 : (now - t0) / durationMs);
        const z = lerp(startZoom, toZoom, easeOutCubic(t));
        const k = z / startZoom;

        // 1) apply zoom (triggers canvas resize/layout)
        setZoomQ(z, zoomRef);


        // 2) keep focal point centered (clamped)
        const targetLeft = contentX * k - anchorX;
        const targetTop = contentY * k - anchorY;
        const { left, top } = clampScroll(container, targetLeft, targetTop);
        container.scrollLeft = left;
        container.scrollTop = top;

        // 3) move the yellow rect *in sync* with zoom (no waiting)
        if (mark && base) {
          const wZ = base.w * z;
          const hZ = base.h * z;
          setSelectedRect({
            pageNumber: mark.page_index + 1,
            x: mark.nx * wZ,
            y: mark.ny * hZ,
            w: mark.nw * wZ,
            h: mark.nh * hZ,
          });
        }

        if (t < 1) {
          animRafRef.current = requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
          isZoomAnimatingRef.current = false;
        }
      };

      animRafRef.current = requestAnimationFrame(step);
    },
    // deps: include things we read directly
    [marks, currentMarkIndex, clampZoom]
  );
  // PATCH[page.tsx] — add focal-point zoom helper
  const zoomAt = useCallback(
    (nextZoomRaw: number, clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return;

      const nextZoom = clampZoom(nextZoomRaw);
      const prevZoom = zoomRef.current;
      if (Math.abs(nextZoom - prevZoom) < 1e-4) return;

      // Anchor at the given screen point (mouse or gesture center)
      const rect = container.getBoundingClientRect();
      const anchorX = clientX - rect.left;
      const anchorY = clientY - rect.top;

      // Content coords under anchor at previous zoom
      const contentX = container.scrollLeft + anchorX;
      const contentY = container.scrollTop + anchorY;

      const scale = nextZoom / prevZoom;

      // 1) set zoom state quickly (no extra animations here)
      setZoomQ(nextZoom, zoomRef);


      // 2) keep the same content point under the anchor
      const targetLeft = contentX * scale - anchorX;
      const targetTop = contentY * scale - anchorY;

      const { left, top } = clampScroll(container, targetLeft, targetTop);
      // rAF prevents layout thrash during trackpad zooming
      requestAnimationFrame(() => {
        container.scrollLeft = left;
        container.scrollTop = top;
      });
    },
    [clampZoom]
  );


  const isDemo = searchParams?.get('demo') === '1';
  const qProject = searchParams?.get('project_name') || '';
  const qExtId = searchParams?.get('id') || '';
  const qPartNumber = searchParams?.get('part_number') || '';
  const qUser = searchParams?.get('user_mail') || '';
  const qAssembly = searchParams?.get('assembly_drawing') || '';
  const hasBootstrapKeys = !!(qProject && qExtId && qPartNumber && qAssembly);
  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const markSetIdParam = searchParams?.get('mark_set_id') || '';
  // Show viewer if pdf_url is present; otherwise, if link has keys, show compact markset list
  useEffect(() => {
    if (pdfUrlParam) {
      setShowSetup(false);
    } else if (hasBootstrapKeys) {
      setShowSetup(true);
    } else {
      setShowSetup(true);
    }
  }, [pdfUrlParam, hasBootstrapKeys]);


  const handleSetupComplete = (url: string, setId: string) => {
    const prevQs = sessionStorage.getItem('viewerLastSetupParams')
      || window.location.search.slice(1); // drop '?'
    const params = new URLSearchParams(prevQs);

    // keep existing bootstrap params (project_name, id, part_number, user_mail, assembly_drawing)
    params.set('pdf_url', url);
    if (setId) params.set('mark_set_id', setId);

    // persist and navigate
    sessionStorage.setItem('viewerLastSetupParams', params.toString());
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.location.href = newUrl;
  };

  const rawPdfUrl = cleanPdfUrl(
    isDemo
      ? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
      : pdfUrlParam || 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
  );
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

  // Load marks (MASTER vs QC, group-wise for QC)
  useEffect(() => {
    if (showSetup) return;

    // Demo
    if (isDemo) {
      setMarks(demoMarks);
      setIsMasterMarkSet(null);
      setGroupWindows(null);
      setMarkToGroupIndex([]);
      return;
    }

    // No markset -> reset
    if (!markSetId) {
      setMarks([]);
      setEntries({});
      setIsMasterMarkSet(null);
      setGroupWindows(null);
      setMarkToGroupIndex([]);
      setIsMobileInputMode(false);
      return;
    }

    const loadMarks = async () => {
      try {
        // ---------- 1) Figure out if this mark set is MASTER or QC ----------
        let markSetMeta: any | null = null;

        if (qProject && qExtId && qPartNumber) {
          const qs = new URLSearchParams({
            project_name: qProject,
            id: qExtId,
            part_number: qPartNumber,
          });
          if (qUser) qs.set('user_mail', qUser);

          const metaRes = await fetch(`${apiBase}/documents/by-identifier?${qs.toString()}`);
          if (metaRes.ok) {
            const meta = await metaRes.json();
            const msets: any[] = meta.mark_sets || [];
            markSetMeta = msets.find((m) => m.mark_set_id === markSetId) || null;
          } else {
            console.warn('by-identifier failed, falling back to legacy marks loader');
          }
        }

        // ========== MASTER MARKSET (old behaviour) ==========
        if (markSetMeta && markSetMeta.is_master) {
          setIsMasterMarkSet(true);
          setGroupWindows(null);
          setMarkToGroupIndex([]);

          const res = await fetch(`${apiBase}/mark-sets/${markSetId}/marks`);
          if (!res.ok) throw new Error('Failed to fetch master marks');
          const marksData: Mark[] = await res.json();

          const sorted = [...marksData].sort((a, b) => a.order_index - b.order_index);
          setMarks(sorted);

          const initialEntries: Record<string, string> = {};
          sorted.forEach((mark) => {
            if (mark.mark_id) initialEntries[mark.mark_id] = '';
          });
          setEntries(initialEntries);

          const isMobile =
            sorted.length > 0 &&
            (window.innerWidth < 900 ||
              ('ontouchstart' in window && window.innerWidth < 1024));
          setIsMobileInputMode(isMobile);
          return;
        }

        // ========== QC MARKSET: group-wise, instrument-sorted ==========
        if (markSetMeta && !markSetMeta.is_master) {
          setIsMasterMarkSet(false);

          const res = await fetch(`${apiBase}/viewer/groups/${markSetId}`);
          if (!res.ok) throw new Error('Failed to fetch QC groups');

          const wrapper = await res.json();
          const groups: any[] = wrapper.groups || [];

          const orderedMarks: Mark[] = [];
          const groupMeta: GroupWindowMeta[] = [];
          const groupIndexForMark: number[] = [];

          groups.forEach((g, gi) => {
            const gm = ((g.marks || []) as any[]).slice();
            if (!gm.length) return;

            // Sort marks INSIDE the group by instrument, then by order_index
            gm.sort((a: any, b: any) => {
              const ai = (a.instrument || '').toLowerCase();
              const bi = (b.instrument || '').toLowerCase();
              if (ai && bi && ai !== bi) return ai.localeCompare(bi);
              return (a.order_index ?? 0) - (b.order_index ?? 0);
            });

            const startIndex = orderedMarks.length;

            gm.forEach((m: any) => {
              const cloned: Mark = { ...m };
              cloned.order_index = orderedMarks.length; // global order index
              orderedMarks.push(cloned);
              groupIndexForMark.push(gi);
            });

            const endIndex = orderedMarks.length - 1;
            if (startIndex > endIndex) return;

            // If group has its own bbox, use it; else derive from marks
            const pageIndex =
              g.page_index ??
              (gm[0]?.page_index ?? 0);

            const nxVals = gm.map((m: any) => m.nx ?? 0);
            const nyVals = gm.map((m: any) => m.ny ?? 0);
            const x2Vals = gm.map((m: any) => (m.nx ?? 0) + (m.nw ?? 0));
            const y2Vals = gm.map((m: any) => (m.ny ?? 0) + (m.nh ?? 0));

            const minNx = g.nx ?? Math.min(...nxVals);
            const minNy = g.ny ?? Math.min(...nyVals);
            const maxNx = g.nw ? minNx + g.nw : Math.max(...x2Vals);
            const maxNy = g.nh ? minNy + g.nh : Math.max(...y2Vals);

            groupMeta.push({
              group_id: String(g.group_id ?? gi),
              name: g.name || `Group ${gi + 1}`,
              startIndex,
              endIndex,
              page_index: pageIndex,
              nx: minNx,
              ny: minNy,
              nw: Math.max(0.01, maxNx - minNx),
              nh: Math.max(0.01, maxNy - minNy),
            });
          });

          setMarks(orderedMarks);
          setGroupWindows(groupMeta);
          setMarkToGroupIndex(groupIndexForMark);

          const initialEntries: Record<string, string> = {};
          orderedMarks.forEach((mark) => {
            if (mark.mark_id) initialEntries[mark.mark_id] = '';
          });
          setEntries(initialEntries);

          const isMobile =
            orderedMarks.length > 0 &&
            (window.innerWidth < 900 ||
              ('ontouchstart' in window && window.innerWidth < 1024));
          setIsMobileInputMode(isMobile);
          return;
        }

        // ========== Unknown meta → legacy fallback ==========
        setIsMasterMarkSet(null);
        setGroupWindows(null);
        setMarkToGroupIndex([]);

        const res = await fetch(`${apiBase}/mark-sets/${markSetId}/marks`);
        if (!res.ok) throw new Error('Failed to fetch marks (fallback)');
        const marksData: Mark[] = await res.json();

        const sorted = [...marksData].sort((a, b) => a.order_index - b.order_index);
        setMarks(sorted);

        const initialEntries: Record<string, string> = {};
        sorted.forEach((mark) => {
          if (mark.mark_id) initialEntries[mark.mark_id] = '';
        });
        setEntries(initialEntries);

        const isMobile =
          sorted.length > 0 &&
          (window.innerWidth < 900 ||
            ('ontouchstart' in window && window.innerWidth < 1024));
        setIsMobileInputMode(isMobile);
      } catch (err) {
        console.error('Marks fetch error:', err);
        setMarks([]);
        setEntries({});
        setIsMobileInputMode(false);
        setIsMasterMarkSet(null);
        setGroupWindows(null);
        setMarkToGroupIndex([]);
      }
    };

    loadMarks();
  }, [markSetId, isDemo, showSetup, apiBase, qProject, qExtId, qPartNumber, qUser]);

  useEffect(() => {
    if (marks.length > 0 && pdf && currentMarkIndex === 0) {
      const timer = setTimeout(() => {
        navigateToMark(0);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [marks, pdf]);


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


  // ===== Precompute base page sizes (scale=1) and then prefix sums =====
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;

    (async () => {
      const n = pdf.numPages;
      const sizes: Array<{ w: number; h: number }> = new Array(n);
      for (let i = 1; i <= n; i++) {
        const page = await pdf.getPage(i);
        if (cancelled) return;
        const vp = page.getViewport({ scale: 1 });
        sizes[i - 1] = { w: vp.width, h: vp.height };
      }
      basePageSizeRef.current = sizes;
      recomputePrefix();              // 👈 build prefix tops right away
      // Initial visible range after sizes land
      requestAnimationFrame(() => updateVisibleRange());
    })();

    return () => { cancelled = true; };
  }, [pdf, recomputePrefix]);

  // Recompute prefix on zoom change without re-measuring
  useEffect(() => {
    recomputePrefix();
    // keep visible range in sync
    updateVisibleRange();
  }, [zoom, recomputePrefix]);

  const navigateToMark = useCallback(
    async (index: number) => {
      if (!pdf || index < 0 || index >= marks.length) return;

      const mark = marks[index];
      const pageNumber = mark.page_index + 1;
      const container = containerRef.current;
      const pageEl = pageElsRef.current[mark.page_index];
      if (!container || !pageEl) return;

      const base = basePageSizeRef.current[mark.page_index];
      if (!base) return;

      const containerW = container.clientWidth;
      const containerH = container.clientHeight;

      // Only true when we *know* it is a master markset
      const isMaster = isMasterMarkSet === true;

      // Does this mark belong to a QC group?
      const hasGroup =
        !!groupWindows &&
        markToGroupIndex[index] != null &&
        markToGroupIndex[index] >= 0;

      // ---------- MASTER / LEGACY (no group info) → old mark-wise auto zoom ----------
      if (isMaster || !hasGroup) {
        // Rect at scale=1
        const rectAt1 = {
          x: mark.nx * base.w,
          y: mark.ny * base.h,
          w: mark.nw * base.w,
          h: mark.nh * base.h,
        };

        let targetZoom = Math.min(
          (containerW * 0.8) / rectAt1.w,
          (containerH * 0.8) / rectAt1.h
        );
        targetZoom = Math.min(targetZoom, 4);
        if (containerW < 600) targetZoom = Math.min(targetZoom, 3);

        const qZoom = setZoomQ(targetZoom, zoomRef);

        const rectAtZ = {
          x: mark.nx * base.w * qZoom,
          y: mark.ny * base.h * qZoom,
          w: mark.nw * base.w * qZoom,
          h: mark.nh * base.h * qZoom,
        };

        setFlashRect({ pageNumber, ...rectAtZ });
        setTimeout(() => setFlashRect(null), 1200);
        const keepAliveRect = { pageNumber, ...rectAtZ };
        setSelectedRect(keepAliveRect);
        setTimeout(() => setSelectedRect(keepAliveRect), 1250);

        requestAnimationFrame(async () => {
          const expectedW = base.w * qZoom;
          const expectedH = base.h * qZoom;

          await waitForCanvasLayout(pageEl, expectedW, expectedH, 1500);

          const containerRect = container.getBoundingClientRect();
          const pageRect = pageEl.getBoundingClientRect();

          const pageOffsetLeft = container.scrollLeft + (pageRect.left - containerRect.left);
          const pageOffsetTop = container.scrollTop + (pageRect.top - containerRect.top);

          const markCenterX = pageOffsetLeft + rectAtZ.x + rectAtZ.w / 2;
          const markCenterY = pageOffsetTop + rectAtZ.y + rectAtZ.h / 2;

          const targetScrollLeft = markCenterX - containerW / 2;
          const targetScrollTop = markCenterY - containerH / 2;

          const { left: clampedL, top: clampedT } = clampScroll(
            container,
            targetScrollLeft,
            targetScrollTop
          );

          container.scrollTo({ left: clampedL, top: clampedT, behavior: 'smooth' });
        });

        setCurrentMarkIndex(index);
        return;
      }

      // ---------- QC FLOW: group-wise handling ----------
      const gi = markToGroupIndex[index];
      const gMeta = groupWindows![gi];
      const groupBase = basePageSizeRef.current[gMeta.page_index];
      if (!groupBase) {
        setCurrentMarkIndex(index);
        return;
      }

      // Group rect at scale=1 (normalized → px)
      const groupRectAt1 = {
        x: gMeta.nx * groupBase.w,
        y: gMeta.ny * groupBase.h,
        w: gMeta.nw * groupBase.w,
        h: gMeta.nh * groupBase.h,
      };

      // Which group were we on *before*?
      const prevIdx = currentMarkIndex;
      const prevGroupIdx =
        prevIdx >= 0 && prevIdx < marks.length && markToGroupIndex[prevIdx] != null
          ? markToGroupIndex[prevIdx]
          : gi;

      const groupChanged = gi !== prevGroupIdx;

       // ✅ 1) Choose zoom:
      //    - first time / switching groups → fit group vertically in the
      //      area between the HUD and the (floating) InputPanel on mobile
      //    - within same group → keep current zoom (only slide in X)
      let targetZoom = zoomRef.current || 1.0;
      if (groupChanged || !zoomRef.current) {
        const isMobileViewport =
          typeof window !== 'undefined' && window.innerWidth < 900;

        let bottomSafe = 0;

        if (isMobileViewport && typeof document !== 'undefined') {
          // Try to use the REAL InputPanel height if present (mobile mode)
          const panel = document.getElementById('mobile-input-panel');
          if (panel) {
            const rect = panel.getBoundingClientRect();
            bottomSafe = rect.height + 16; // small extra padding
          } else {
            // Fallback if panel not yet mounted
            bottomSafe = INPUT_PANEL_SAFE_PX_MOBILE;
          }
        }

        // Available vertical space for the group (inside the scroll container)
        let usableHeight = containerH - HUD_TOP_SAFE_PX - bottomSafe;

        // Safety guard so we don't explode the zoom on tiny windows
        if (usableHeight < containerH * 0.4) {
          usableHeight = containerH * 0.4;
        }

        const rawZoom = usableHeight / (groupRectAt1.h || 1);
        targetZoom = setZoomQ(rawZoom, zoomRef);
      }


      // Rect for THIS MARK at target zoom (for yellow outline)
      const rectAtZ = {
        x: mark.nx * groupBase.w * targetZoom,
        y: mark.ny * groupBase.h * targetZoom,
        w: mark.nw * groupBase.w * targetZoom,
        h: mark.nh * groupBase.h * targetZoom,
      };

      // Group rect at target zoom (for scroll anchoring when group changes)
      const groupRectAtZ = {
        x: groupRectAt1.x * targetZoom,
        y: groupRectAt1.y * targetZoom,
        w: groupRectAt1.w * targetZoom,
        h: groupRectAt1.h * targetZoom,
      };

      // Highlight current mark
      setFlashRect({ pageNumber, ...rectAtZ });
      setTimeout(() => setFlashRect(null), 1200);
      const keepAliveRect = { pageNumber, ...rectAtZ };
      setSelectedRect(keepAliveRect);
      setTimeout(() => setSelectedRect(keepAliveRect), 1250);

      requestAnimationFrame(async () => {
        const expectedW = groupBase.w * targetZoom;
        const expectedH = groupBase.h * targetZoom;

        // When zoom changed (new group / first time), wait for canvas to settle
        if (groupChanged) {
          await waitForCanvasLayout(pageEl, expectedW, expectedH, 1500);
        }

        const containerRect = container.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();

        const pageOffsetLeft = container.scrollLeft + (pageRect.left - containerRect.left);
        const pageOffsetTop = container.scrollTop + (pageRect.top - containerRect.top);

        // ✅ 2) X: center on mark, but bias slightly away from right HUD
        const markCenterX = pageOffsetLeft + rectAtZ.x + rectAtZ.w / 2;
        const effectiveViewWidth = containerW - HUD_SIDE_SAFE_PX; // keep away from right zoom buttons
        const targetScrollLeft = markCenterX - effectiveViewWidth / 2;

        // ✅ 3) Y:
        //    - if group changed → align GROUP TOP just under HUD
        //    - if same group   → keep current scrollTop (pure X motion)
        let targetScrollTop: number;
        if (groupChanged) {
          const paddingTopPx = HUD_TOP_SAFE_PX;
          const groupTop = pageOffsetTop + groupRectAtZ.y;
          targetScrollTop = groupTop - paddingTopPx;
        } else {
          targetScrollTop = container.scrollTop; // preserve current Y
        }

        const { left: clampedL, top: clampedT } = clampScroll(
          container,
          targetScrollLeft,
          targetScrollTop
        );

        container.scrollTo({ left: clampedL, top: clampedT, behavior: 'smooth' });
      });

      setCurrentMarkIndex(index);
    },
    [marks, pdf, isMasterMarkSet, groupWindows, markToGroupIndex, currentMarkIndex]
  );




  useEffect(() => {
    if (marks.length === 0) return;
    if (isZoomAnimatingRef.current) return;

    const mark = marks[currentMarkIndex];
    if (!mark) return;

    const base = basePageSizeRef.current[mark.page_index];
    if (!base) return;

    const rectAtZ = {
      x: mark.nx * base.w * zoom,
      y: mark.ny * base.h * zoom,
      w: mark.nw * base.w * zoom,
      h: mark.nh * base.h * zoom,
    };

    setSelectedRect({
      pageNumber: mark.page_index + 1,
      ...rectAtZ,
    });
  }, [zoom, currentMarkIndex, marks]);

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

  const handleJumpFromReview = useCallback((index: number) => {
    setShowReview(false);           // close review
    setTimeout(() => {
      navigateToMark(index);        // jump to the chosen mark
    }, 0);                          // let ReviewScreen unmount first
  }, [navigateToMark]);

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

    // Fill missing entries as "NA"
    const finalEntries: Record<string, string> = { ...entries };
    marks.forEach((mark) => {
      if (mark.mark_id && !finalEntries[mark.mark_id]?.trim()) {
        finalEntries[mark.mark_id] = 'NA';
      }
    });

    try {
      // Use actual email from query params if present
      const userEmail = searchParams?.get('user_mail') || qUser || null;
      if (userEmail && !userEmail.includes('@')) {
        console.warn('Invalid email format, skipping email send');
      }

      const response = await fetch(`${apiBase}/reports/generate-bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mark_set_id: markSetId,
          entries: finalEntries,
          pdf_url: rawPdfUrl,
          user_email: userEmail,   // still accepted (alias user_mail also works server-side)
          padding_pct: 0.25,
          office_variant: 'o365',
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Submit failed: ${response.status} ${text}`);
      }

      // ✅ EMAIL-ONLY RESPONSE (JSON)
      const data = await response.json().catch(() => ({} as any));
      const emailStatus = data?.email_status;

      if (emailStatus === 'queued' && (searchParams?.get('user_mail') || qUser)) {
        toast.success('✓ Submission received. Email is on the way!', { duration: 4000 });
      } else if (emailStatus === 'not_configured') {
        toast.success('✓ Submission saved. Email is not configured on server.', { duration: 4000 });
      } else if (!searchParams?.get('user_mail') && !qUser) {
        toast.success('✓ Submission saved. No email provided.', { duration: 3500 });
      } else {
        // generic success
        toast.success('✓ Submission processed.', { duration: 3500 });
      }

      // Navigate back to the mark-set chooser (same behavior you had)
      setTimeout(() => {
        const qs = sessionStorage.getItem('viewerLastSetupParams') || window.location.search.slice(1);
        const sp = new URLSearchParams(qs);
        sp.set('autoboot', '1');
        sp.delete('pdf_url');
        sp.delete('mark_set_id');
        window.location.href = `${window.location.pathname}?${sp.toString()}`;
      }, 1200);

    } catch (error) {
      console.error('Submit error:', error);
      toast.error('Failed to submit. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [markSetId, entries, apiBase, rawPdfUrl, searchParams, qUser, marks]);

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

  // PATCH: HUD zoom anchored at viewer center (consistent with wheel/pinch)
  const zoomIn = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = clampZoom(zoomRef.current * 1.2);
    zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAt, clampZoom]);

  const zoomOut = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = clampZoom(zoomRef.current / 1.2);
    zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAt, clampZoom]);


  // (optional) make reset smooth as well:
  // const resetZoom = useCallback(() => smoothZoom(1.0), [smoothZoom]);

  const resetZoom = useCallback(() => setZoomQ(1.0, zoomRef), []);

  const fitToWidthZoom = useCallback(() => {
    if (!pdf || !containerRef.current) return;

    pdf.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = containerRef.current!.clientWidth - 32;
      const newZoom = containerWidth / viewport.width;
      setZoomQ(newZoom, zoomRef);
    });
  }, [pdf]);

  // PATCH: desktop wheel/trackpad zoom anchored at cursor, scoped to container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let raf: number | null = null;

    const onWheel = (e: WheelEvent) => {
      // Zoom only when ctrl/cmd is held (Mac trackpad pinch sets ctrlKey)
      if (!e.ctrlKey && !e.metaKey) return;
      if (!container.contains(e.target as Node)) return;

      e.preventDefault();
      e.stopPropagation();

      const factor = e.deltaY > 0 ? 0.95 : 1.05;

      // Throttle to one update per frame
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = clampZoom(zoomRef.current * factor);
        zoomAt(next, e.clientX, e.clientY);
        raf = null;
      });
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel as any);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [zoomAt, clampZoom]);

  // PATCH: touch pan (1 finger) + pinch-zoom (2 fingers) on the container
  useEffect(() => {
    if (!TOUCH_GESTURES_ENABLED) return; // ➜ disable custom gestures; let native scrolling handle pan
    const el = containerRef.current;
    if (!el) return;

    // Tracking pointers
    const pts = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let pinch = false;

    // For drag
    let dragStartX = 0;
    let dragStartY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    // For pinch
    let lastMidX = 0;
    let lastMidY = 0;
    let lastDist = 0;

    const getTwo = () => {
      const arr = Array.from(pts.values());
      return [arr[0], arr[1]] as const;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) return;
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pts.size === 1) {
        // Start drag
        dragging = true;
        pinch = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        startScrollLeft = el.scrollLeft;
        startScrollTop = el.scrollTop;
      } else if (pts.size === 2) {
        // Start pinch
        dragging = false;
        pinch = true;
        const [p0, p1] = getTwo();
        lastMidX = (p0.x + p1.x) / 2;
        lastMidY = (p0.y + p1.y) / 2;
        lastDist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinch && pts.size >= 2) {
        // Pinch: zoom at gesture midpoint + translate by midpoint drift
        const [p0, p1] = getTwo();
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);

        if (lastDist > 0) {
          const factor = dist / lastDist;
          const next = clampZoom(zoomRef.current * factor);
          // Zoom around gesture center
          zoomAt(next, midX, midY);

          // Also pan by the midpoint drift so the content stays under fingers
          el.scrollLeft -= (midX - lastMidX);
          el.scrollTop -= (midY - lastMidY);
        }

        lastMidX = midX;
        lastMidY = midY;
        lastDist = dist;

        e.preventDefault();
        e.stopPropagation();
      } else if (dragging && pts.size === 1) {
        // One-finger pan (works when zoomed)
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        el.scrollLeft = startScrollLeft - dx;
        el.scrollTop = startScrollTop - dy;

        e.preventDefault();
        e.stopPropagation();
      }
    };

    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) {
        pinch = false;
        lastDist = 0;
      }
      if (pts.size === 0) {
        dragging = false;
      }
      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', end, { passive: true });
    el.addEventListener('pointercancel', end, { passive: true });
    el.addEventListener('pointerleave', end, { passive: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', end as any);
      el.removeEventListener('pointercancel', end as any);
      el.removeEventListener('pointerleave', end as any);
    };
  }, [zoomAt, clampZoom]);

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
          onBack={() => {
            setShowReview(false);
            // give the viewer a tick to reflow before centering
            setTimeout(() => navigateToMark(currentMarkIndex), 120);
          }}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          onJumpTo={(i) => {
            setShowReview(false);
            // jump straight to the chosen mark (center + zoom)
            setTimeout(() => navigateToMark(i), 120);
          }}
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

          {/* Slide-over sidebar (mobile) */}
          <SlideSidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            title="Marks"
          >
            <MarkList
              marks={marks}
              currentIndex={currentMarkIndex}
              entries={entries}
              groupsMeta={
                isMasterMarkSet === false && groupWindows
                  ? groupWindows
                  : undefined
              }
              onSelect={(index) => {
                setCurrentMarkIndex(index);
                setSidebarOpen(false);
                setTimeout(() => selectFromList(index), 80);
              }}
            />

          </SlideSidebar>


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


            {/* ✅ Floating HUD (mobile) */}
            <FloatingHUD
              sidebarOpen={sidebarOpen}
              onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
              currentMarkIndex={currentMarkIndex}
              totalMarks={marks.length}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
            />

            <div
              style={{
                flex: 1,
                overflow: 'auto',
                background: '#525252',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-x pan-y', // PATCH: allow pinch-zoom via pointer events
              }}
              className="pdf-surface-wrap"
              ref={containerRef}
            >


              <div className="pdf-surface" style={{ position: 'relative', height: totalHeightRef.current }}>
                {Array.from({ length: visibleRange[1] - visibleRange[0] + 1 }, (_, i) => visibleRange[0] + i).map((pageNum) => {
                  const top = prefixHeightsRef.current[pageNum - 1] || 0;
                  return (
                    <div
                      key={pageNum}
                      style={{ position: 'absolute', top, left: 0, right: 0 }}
                      ref={(el) => { pageElsRef.current[pageNum - 1] = el; }}
                    >
                      <PageCanvas
                        pdf={pdf}
                        pageNumber={pageNum}
                        zoom={zoom}
                        flashRect={
                          flashRect?.pageNumber === pageNum
                            ? { x: flashRect.x, y: flashRect.y, w: flashRect.w, h: flashRect.h }
                            : null
                        }
                        selectedRect={
                          selectedRect?.pageNumber === pageNum
                            ? { x: selectedRect.x, y: selectedRect.y, w: selectedRect.w, h: selectedRect.h }
                            : null
                        }
                      />


                      {/* Scaled single-layer search overlay */}
                      {highlightPageNumber === pageNum && (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            transform: `scale(${zoom})`,
                            transformOrigin: 'top left',
                            pointerEvents: 'none',
                            zIndex: 100
                          }}
                        >
                          {searchHighlights.map((h, idx) => (
                            <div
                              key={`hl-${idx}`}
                              style={{
                                position: 'absolute',
                                left: h.x,
                                top: h.y,
                                width: h.width,
                                height: h.height,
                                background: 'rgba(255, 235, 59, 0.35)',
                                border: '1px solid rgba(255, 193, 7, 0.85)'
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
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
        <SlideSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          title="Marks"
        >
          <MarkList
            marks={marks}
            currentIndex={currentMarkIndex}
            entries={entries}
            groupsMeta={
              isMasterMarkSet === false && groupWindows
                ? groupWindows
                : undefined
            }
            onSelect={(index) => {
              setCurrentMarkIndex(index);
              setSidebarOpen(false);
              setTimeout(() => selectFromList(index), 80);
            }}
          />

        </SlideSidebar>
      )}


      <div className="main-content">
        {/* ✅ Floating HUD (desktop) */}
        <FloatingHUD
          sidebarOpen={sidebarOpen}
          onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
          currentMarkIndex={currentMarkIndex}
          totalMarks={marks.length}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />



        <div className="pdf-surface" style={{ position: 'relative', height: totalHeightRef.current }}>
          {Array.from({ length: visibleRange[1] - visibleRange[0] + 1 }, (_, i) => visibleRange[0] + i).map((pageNum) => {
            const top = prefixHeightsRef.current[pageNum - 1] || 0;
            return (
              <div
                key={pageNum}
                style={{ position: 'absolute', top, left: 0, right: 0 }}
                ref={(el) => { pageElsRef.current[pageNum - 1] = el; }}
              >
                <PageCanvas
                  pdf={pdf}
                  pageNumber={pageNum}
                  zoom={zoom}
                  flashRect={
                    flashRect?.pageNumber === pageNum
                      ? { x: flashRect.x, y: flashRect.y, w: flashRect.w, h: flashRect.h }
                      : null
                  }
                  selectedRect={
                    selectedRect?.pageNumber === pageNum
                      ? { x: selectedRect.x, y: selectedRect.y, w: selectedRect.w, h: selectedRect.h }
                      : null
                  }
                />


                {/* Scaled single-layer search overlay */}
                {highlightPageNumber === pageNum && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      transform: `scale(${zoom})`,
                      transformOrigin: 'top left',
                      pointerEvents: 'none',
                      zIndex: 100
                    }}
                  >
                    {searchHighlights.map((h, idx) => (
                      <div
                        key={`hl-${idx}`}
                        style={{
                          position: 'absolute',
                          left: h.x,
                          top: h.y,
                          width: h.width,
                          height: h.height,
                          background: 'rgba(255, 235, 59, 0.35)',
                          border: '1px solid rgba(255, 193, 7, 0.85)'
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
  );

}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="viewer-container"><div className="loading">Loading...</div></div>}>
      <ViewerContent />
    </Suspense>
  );
}