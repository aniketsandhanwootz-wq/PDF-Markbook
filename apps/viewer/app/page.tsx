'use client';

import type { MutableRefObject, CSSProperties } from 'react';
import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSwipeable } from 'react-swipeable';
import toast, { Toaster } from 'react-hot-toast';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PageCanvas from '../components/PageCanvas';
import MarkList from '../components/MarkList';
import FloatingHUD from '../components/FloatingHUD';
import InputPanel from '../components/InputPanel';
import ReviewScreen from '../components/ReviewScreen';
import ReportTitlePanel from '../components/ReportTitlePanel';
import { clampZoom, downloadMasterReport, computeZoomForRect } from '../lib/pdf';
import PDFSearch from '../components/PDFSearch';
import SlideSidebar from '../components/SlideSidebar';
import usePinchZoom from '../hooks/usePinchZoom';
import DrawingSheetPanel from '../components/DrawingSheetPanel'; // ✅ NEW
import DraftResumeDialog from '../components/DraftResumeDialog';
import { useQCDraft } from '../hooks/useQCDraft';


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

// 🔧 UPDATED: also wait until scrollHeight matches expected total height
async function waitForCanvasLayout(
  pageEl: HTMLElement,
  expectedW: number,
  expectedH: number,
  timeoutMs = 1200,
  container?: HTMLElement | null,
  expectedTotalHeight?: number | null
) {
  const t0 = performance.now();

  while (performance.now() - t0 < timeoutMs) {
    const canvas = pageEl.querySelector('canvas') as HTMLCanvasElement | null;
    const w = (canvas?.clientWidth ?? pageEl.clientWidth) | 0;
    const h = (canvas?.clientHeight ?? pageEl.clientHeight) | 0;

    const sizeOk =
      Math.abs(w - expectedW) <= 2 && Math.abs(h - expectedH) <= 2;

    let scrollOk = true;
    if (container && typeof expectedTotalHeight === 'number') {
      const sh = container.scrollHeight | 0;
      // thoda tolerance, gutters / rounding ke liye
      scrollOk = sh >= expectedTotalHeight - 4;
    }

    if (sizeOk && scrollOk) return;
    await sleep(50);
  }
}

// --- smooth zoom helpers ---
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// ease-out cubic for pleasant feel
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
// PATCH[page.tsx] — add quantized zoom helpers (place after easeOutCubic)
const quantize = (z: number) => {
  // 4-decimal quantization – less jumpy, still stable
  const q = Math.round(clampZoom(z) * 10000) / 10000;
  return q;
};

// --- Default report title helper ---
// Generates: Report[DD/MM/YYYY] using Asia/Kolkata timezone
function getDefaultReportTitle(): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date()); // e.g. "12/12/2025"

  return `Report[${date}]`;
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
  label?: string;
};

type MarkStatus = 'PASS' | 'FAIL' | 'DOUBT' | '';

type FlashRect = {
  pageNumber: number;
  x: number;
  y: number;
  w: number;
  h: number;
} | null;

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

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

// === Touch gestures master switch ===
// Enable only on touch-capable devices so desktop scroll / wheel behave normally.
const TOUCH_GESTURES_ENABLED =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator as any).maxTouchPoints > 0);

// Smart sub-region inside a group: quadrant / between quadrants / center.
// Always returns a rect fully inside the group, ~55% of group size for context.
function computeSmartRegionWithinGroup(group: Rect, mark: Rect): Rect {
  const gx = group.x;
  const gy = group.y;
  const gw = Math.max(group.w, 1);
  const gh = Math.max(group.h, 1);

  const markCx = mark.x + mark.w / 2;
  const markCy = mark.y + mark.h / 2;

  const rx = (markCx - gx) / gw;
  const ry = (markCy - gy) / gh;

  const crx = Math.min(1, Math.max(0, rx));
  const cry = Math.min(1, Math.max(0, ry));

  // 3x3 grid thresholds
  const t1 = 0.33;
  const t2 = 0.67;

  // Region ~slightly larger than a strict quadrant for more context
  const baseW = gw * 0.55;
  const baseH = gh * 0.55;

  const clampRegion = (cx: number, cy: number): Rect => {
    let x = cx - baseW / 2;
    let y = cy - baseH / 2;
    x = Math.max(gx, Math.min(x, gx + gw - baseW));
    y = Math.max(gy, Math.min(y, gy + gh - baseH));
    return { x, y, w: baseW, h: baseH };
  };

  // Center region: mark roughly in center of group
  if (crx >= t1 && crx <= t2 && cry >= t1 && cry <= t2) {
    return clampRegion(gx + gw / 2, gy + gh / 2);
  }

  // Top middle band (between top-left & top-right)
  if (cry < t1 && crx >= t1 && crx <= t2) {
    return clampRegion(gx + gw / 2, gy + gh * 0.25);
  }

  // Bottom middle band (between bottom-left & bottom-right)
  if (cry > t2 && crx >= t1 && crx <= t2) {
    return clampRegion(gx + gw / 2, gy + gh * 0.75);
  }

  // Middle left band (between top-left & bottom-left)
  if (crx < t1 && cry >= t1 && cry <= t2) {
    return clampRegion(gx + gw * 0.25, gy + gh / 2);
  }

  // Middle right band (between top-right & bottom-right)
  if (crx > t2 && cry >= t1 && cry <= t2) {
    return clampRegion(gx + gw * 0.75, gy + gh / 2);
  }

  // Otherwise standard quadrants:
  const cx = crx < 0.5 ? gx + gw * 0.25 : gx + gw * 0.75;
  const cy = cry < 0.5 ? gy + gh * 0.25 : gy + gh * 0.75;
  return clampRegion(cx, cy);
}

// ------- New types for bootstrap + markset summary -------
type BootstrapDoc = {
  document: {
    doc_id: string;
    project_name: string;
    id: string;            // external_id
    part_number: string;
    dwg_num?: string | null;
    pdf_url: string;
    page_count: number;
    // 👇 NEW: document-level drawing type (optional)
    drawing_type?: string | null;
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
    description?: string | null;

    // 👇 per-markset drawing & PDF (optional)
    dwg_num?: string | null;
    pdf_url?: string | null;
  }>;
  master_mark_set_id?: string | null;
  included_mark_set_id?: string | null;
  marks: any[];

  // 👇 NEW: map DWG number → drawing_type (e.g. "Assembly", "Part", etc.)
  dwgTypeMap?: Record<string, string | null>;
};


type CreateDocMarkSetBody = {
  project_name: string;
  id: string;
  part_number: string;
  label: string;
  created_by?: string | null;
  is_master?: boolean;
};
function ViewerSetupScreen({
  onStart,
}: {
  onStart: (pdfUrl: string, markSetId: string, dwgNum?: string | null) => void;
}) {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const params = useSearchParams();

  // Query inputs
  const [projectName, setProjectName] = useState<string>(params?.get('project_name') || '');
  const [extId, setExtId] = useState<string>(params?.get('id') || '');
  const [partNumber, setPartNumber] = useState<string>(params?.get('part_number') || '');
  const [dwgNum, setDwgNum] = useState<string>(params?.get('dwg_num') || '');
  const [userMail, setUserMail] = useState<string>(params?.get('user_mail') || '');
  const [assemblyDrawing, setAssemblyDrawing] = useState<string>(params?.get('assembly_drawing') || '');


  // Bootstrap state
  const [boot, setBoot] = useState<BootstrapDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>('');
  const [autoTriedBootstrap, setAutoTriedBootstrap] = useState(false);

  // 👉 NEW: which DWG is currently opened in the bottom sheet (null = closed)
  const [activeDwgKey, setActiveDwgKey] = useState<string | null>(null);
  // 👉 NOTE: we no longer show QC mark counts on the initial screen,
  // so we don't need to compute them here. Keeping this commented so
  // it's easy to restore in future if UI changes.
  // const [qcMarkCounts, setQcMarkCounts] = useState<Record<string, number>>({});


  // For viewer we only need the business triple; dwg_num + assembly_drawing are optional.
  const hasBootstrapKeys =
    projectName.trim() && extId.trim() && partNumber.trim();

  const runBootstrap = async () => {
    setErr('');
    try {
      setLoading(true);

      const qs = new URLSearchParams({
        project_name: projectName,
        id: extId,
        part_number: partNumber,
      });

      // 👇 Only filter by dwg_num if user explicitly typed it.
      // For Glide 2 (viewer), we *never* filter by assembly_drawing here,
      // so we get ALL mark_sets across ALL drawings for this triple.
      if (dwgNum.trim()) qs.set('dwg_num', dwgNum.trim());

      if (userMail.trim()) qs.set('user_mail', userMail.trim());

      // ❌ IMPORTANT: do NOT send assembly_drawing to /documents/by-identifier
      // Viewer uses assemblyDrawing only as a fallback pdf_url later,
      // not as a filter.
      // if (assemblyDrawing.trim()) {
      //   qs.set('assembly_drawing', assemblyDrawing.trim());
      // }


      const res = await fetch(
        `${apiBase}/documents/by-identifier?${qs.toString()}`,
        { method: 'GET' }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');

        // 404 -> document/inspection map not found
        if (res.status === 404 && text.includes('DOCUMENT_NOT_FOUND')) {
          setErr(
            'No inspection map exists. To create a map, go to Wootz.Browser > Assembly > All > Info > Inspection Map'
          );
          return; // stop here, boot null hi rahega
        }


        throw new Error(text || 'Bootstrap failed');
      }

      const meta: any = await res.json();

      // Normalise into BootstrapDoc shape used by the UI
      const doc = meta.document || meta.documents?.[0] || {};


      // 👇 Build a DWG → drawing_type map from all related documents (if present)
      const docsArray: any[] = meta.documents
        ? meta.documents
        : doc
          ? [doc]
          : [];

      const dwgTypeMap: Record<string, string | null> = {};
      docsArray.forEach((d) => {
        const key =
          (d.dwg_num && String(d.dwg_num).trim()) || 'UNKNOWN';
        const value =
          (d.drawing_type && String(d.drawing_type).trim()) || null;
        dwgTypeMap[key] = value;
      });

      const bootData: BootstrapDoc = {
        document: {
          doc_id: doc.doc_id ?? '',
          project_name: doc.project_name ?? projectName,
          id: doc.id ?? extId,
          part_number: doc.part_number ?? partNumber,
          dwg_num: doc.dwg_num ?? null,
          pdf_url: doc.pdf_url ?? (assemblyDrawing || ''),
          page_count: doc.page_count ?? 0,
          drawing_type: doc.drawing_type ?? null,
        },
        mark_sets: (meta.mark_sets || []) as BootstrapDoc['mark_sets'],
        master_mark_set_id: meta.master_mark_set_id ?? null,
        included_mark_set_id: meta.included_mark_set_id ?? null,
        marks: [],
        dwgTypeMap, // 👈 attach the map to boot
      };

      setBoot(bootData);
    } catch (e: any) {
      console.error(e);
      setErr('Failed to initialize document.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // URL se aayi triple ke liye sirf EK baar auto bootstrap karo
    if (!boot && hasBootstrapKeys && !loading && !autoTriedBootstrap) {
      setAutoTriedBootstrap(true);   // ✅ ab dobara auto-run nahi hoga
      runBootstrap();
    }
  }, [boot, hasBootstrapKeys, loading, autoTriedBootstrap]);


  // ❌ We used to compute QC mark counts here by calling /viewer/groups
  //    for every non-master markset, just to show "X marks" in the UI.
  //    That UI is now disabled, so these network calls are pure overhead.
  //
  // useEffect(() => {
  //   if (!boot) return;
  //
  //   const qcSets = boot.mark_sets.filter((ms) => !ms.is_master);
  //   if (qcSets.length === 0) {
  //     setQcMarkCounts({});
  //     return;
  //   }
  //
  //   let cancelled = false;
  //
  //   (async () => {
  //     const result: Record<string, number> = {};
  //
  //     await Promise.all(
  //       qcSets.map(async (ms) => {
  //         try {
  //           const res = await fetch(`${apiBase}/viewer/groups/${ms.mark_set_id}`);
  //           if (!res.ok) return;
  //
  //           const data = await res.json();
  //           const groups: any[] = data.groups || [];
  //
  //           let total = 0;
  //           for (const g of groups) {
  //             total += (g.marks || []).length;
  //           }
  //
  //           result[ms.mark_set_id] = total;
  //         } catch (e) {
  //           console.warn('Failed to compute QC mark count for', ms.mark_set_id, e);
  //         }
  //       })
  //     );
  //
  //     if (!cancelled) {
  //       setQcMarkCounts(result);
  //     }
  //   })();
  //
  //   return () => {
  //     cancelled = true;
  //   };
  // }, [boot, apiBase]);

  // Master Report download handler
  const handleDownloadMasterReport = async () => {
    if (!boot) return;

    setErr('');
    try {
      setLoading(true);
      await downloadMasterReport({
        project_name: projectName,
        id: extId,
        part_number: partNumber,
        dwg_num: dwgNum || undefined,
        report_title: dwgNum
          ? `${partNumber} - ${dwgNum} Master Report`
          : `${partNumber} Master Report`,
        apiBase,
      });


      // Show success toast (optional, or use native alert)
      alert('✓ Master report downloaded successfully!');
    } catch (e: any) {
      console.error('Master report download failed:', e);
      setErr('Failed to generate master report. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  type MarksetLike = {
    mark_set_id: string;
    label?: string;
    dwg_num?: string | null;
    pdf_url?: string | null;
  };


  const handleOpenMarkset = (ms: MarksetLike) => {
    // Prefer per-markset pdf_url/dwg_num; fall back to document-level
    const url =
      (ms as any).pdf_url ||
      (boot?.document as any)?.pdf_url ||
      '';

    if (!url) {
      setErr('No PDF URL for this mark set.');
      return;
    }

    const dwg =
      (ms as any).dwg_num ??
      (boot?.document as any)?.dwg_num ??
      null;

    onStart(url, ms.mark_set_id, dwg);
  };


  const masterMarkset = boot?.mark_sets.find((ms) => ms.is_master);
  const otherMarksets =
    boot?.mark_sets
      ?.filter((ms) => !ms.is_master)
      .slice()
      .sort((a, b) => {
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        // newest first
        return bt - at;
      }) || [];

  // 🔹 Group QC marksets by DWG number (drawing)
  const groupedByDwg: Record<string, BootstrapDoc['mark_sets']> = {};
  otherMarksets.forEach((ms) => {
    const key =
      ((ms as any).dwg_num as string | null | undefined) ??
      (boot?.document as any)?.dwg_num ??
      'UNKNOWN';

    if (!groupedByDwg[key]) groupedByDwg[key] = [];
    groupedByDwg[key].push(ms);
  });

  const dwgKeys = Object.keys(groupedByDwg).sort((a, b) => {
    if (a === 'UNKNOWN') return 1;
    if (b === 'UNKNOWN') return -1;
    return a.localeCompare(b);
  });


  // Helper: DWG + boot se human-friendly type name nikaalo
  const resolveTypeLabelForDwg = (
    dwgKey: string,
    bootState: BootstrapDoc | null
  ): string => {
    if (!bootState) return 'Others';

    // Sirf per-DWG drawing_type use karna hai
    const rawType = bootState.dwgTypeMap?.[dwgKey] ?? null;
    const v = (rawType || '').trim();

    // Agar blank / '-' hai to "Others"
    if (!v || v === '-') {
      return 'Others';
    }

    const lc = v.toLowerCase();

    if (lc === 'assembly') {
      return 'Assembly';
    }
    if (lc === 'sub assembly' || lc === 'sub-assembly' || lc === 'subassembly') {
      return 'Sub Assembly';
    }
    if (lc === 'part' || lc === 'part drawing' || lc === 'part drawings') {
      return 'Parts';
    }
    if (lc === 'boughtout' || lc === 'bought-out' || lc === 'bought out') {
      return 'Boughtouts';
    }
    if (lc === 'fabrication' || lc === 'fab') {
      return 'Fabrication';
    }

    // Kuch aur diya hai to wohi label use karlo (jaise koi custom type)
    return v;
  };


  // 🔹 Re-group each DWG cluster by drawing "type" (using drawing_type)
  type DwgCluster = {
    dwgKey: string;
    dwgLabel: string;
    marksets: BootstrapDoc['mark_sets'];
    typeName: string;
  };

  const groupedByType: Record<string, DwgCluster[]> = {};
  dwgKeys.forEach((dwgKey) => {
    const marksets = groupedByDwg[dwgKey];
    if (!marksets || !marksets.length) return;

    // 👉 Now type is driven by drawing_type, not mark-set label
    const typeName = resolveTypeLabelForDwg(dwgKey, boot);

    const dwgLabel =
      dwgKey === 'UNKNOWN' ? 'Drawing number not set' : dwgKey;

    const cluster: DwgCluster = {
      dwgKey,
      dwgLabel,
      marksets,
      typeName,
    };

    if (!groupedByType[typeName]) groupedByType[typeName] = [];
    groupedByType[typeName].push(cluster);
  });

  const TYPE_ORDER = ['Assembly', 'Sub Assembly', 'Parts', 'Boughtouts', 'Fabrication'];

  const typeKeys = Object.keys(groupedByType).sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);

    const na = ia === -1 ? TYPE_ORDER.length + 1 : ia;
    const nb = ib === -1 ? TYPE_ORDER.length + 1 : ib;

    if (na !== nb) {
      return na - nb; // pehle ordered types, phir Others / custom
    }
    // Same bucket ho to alphabetically
    return a.localeCompare(b);
  });


  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#171717',
        padding: '24px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#1F1F1F',
          width: '100%',
          maxWidth: 860,
          borderRadius: 16,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          padding: 24,
          minHeight: '72vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >

        <div
          style={{
            textAlign: 'left',
            marginBottom: 18,
          }}
        >
          <h1
            style={{
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 4,
              color: '#C9C9C9'

            }}
          >
            {extId}
          </h1>
          <p
            style={{
              color: '#666',
              fontSize: 14,
              fontWeight: 400,
              margin: 0,
            }}
          >
            {partNumber}
          </p>
        </div>


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
                placeholder="Drawing Number (dwg_num, optional)"
                value={dwgNum}
                onChange={(e) => setDwgNum(e.target.value)}
                style={inp}
              />
            </div>

            <input
              placeholder="Your Email (optional)"
              value={userMail}
              onChange={(e) => setUserMail(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 12 }}
            />

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
              background: '#1F1F1F',
              border: '1px solid #3B3B3B',
              fontSize: 12,
              fontWeight: 400,
              fontStyle: 'italic',
              color: '#C9C9C9',
            }}
          >
            {loading && !err && 'Initializing document… please wait.'}
            {!loading && err && err}
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

            {/* Master Mark Set
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
            )} */}

            {/* Other Mark Sets (grouped by DWG) */}
            {/* Other Mark Sets (grouped by DWG & type) */}
            {otherMarksets.length > 0 && (
              <div
                style={{
                  marginTop: 32,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                {/* Header + master report button */}
                <div
                  style={{
                    fontWeight: 400,
                    fontSize: 14,
                    color: '#C9C9C9',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 4,
                    gap: 12,
                  }}
                >
                  <div style={{ fontWeight: 500 }}>Available Inspection Maps</div>

                  <button
                    // ❌ temporarily disabled: no onClick
                    // onClick={handleDownloadMasterReport}
                    disabled={true}
                    style={{
                      padding: 0,
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      border: '1px solid #3B3B3B',
                      background: '#171717',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'default',     // pointer nahi dikhayenge
                      opacity: 0.35,         // thoda fade so it looks disabled
                    }}
                    title="Master report download will be enabled soon"
                  >
                    <img
                      src="/icons/spreadsheet.png"
                      alt="Master report (coming soon)"
                      style={{
                        width: 22,
                        height: 22,
                        display: 'block',
                        pointerEvents: 'none', // image pe click bhi ignore
                      }}
                    />
                  </button>

                </div>

                {/* Scrollable list: sections by type → drawing cards */}
                <div
                  style={{
                    maxHeight: '56vh',
                    overflowY: 'auto',
                    paddingRight: 4,
                    paddingBottom: 4,
                  }}
                >
                  {typeKeys.map((typeName) => (
                    <div key={typeName} style={{ marginBottom: 18 }}>
                      {/* e.g. "Assembly Drawings", "Part Drawings" */}
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: '#C9C9C9',
                          marginBottom: 8,
                        }}
                      >
                        {typeName}
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                        }}
                      >
                        {groupedByType[typeName].map((cluster) => {
                          const count = cluster.marksets.length;
                          const dwgWithCount = `${cluster.dwgLabel} : ${String(count).padStart(2, '0')}`;

                          return (
                            <button
                              key={cluster.dwgKey}
                              onClick={() => setActiveDwgKey(cluster.dwgKey)}
                              style={{
                                textAlign: 'left',
                                border: '1px solid #3B3B3B',
                                borderRadius: 12,
                                padding: '14px 18px',
                                background: '#1F1F1F',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                cursor: 'pointer',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'baseline',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 14,
                                    fontWeight: 600,
                                    color: '#FFFFFF',
                                  }}
                                >
                                  {dwgWithCount}
                                </span>
                              </div>

                              <div
                                style={{
                                  fontSize: 16,
                                  color: '#FFFFFF',
                                  opacity: 0.85,
                                }}
                              >
                                ›
                              </div>
                            </button>
                          );
                        })}

                      </div>
                    </div>
                  ))}
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
        {boot && activeDwgKey && groupedByDwg[activeDwgKey] && (
          <DrawingSheetPanel
            dwgLabel={
              activeDwgKey === 'UNKNOWN'
                ? 'Drawing number not set'
                : activeDwgKey
            }
            marksets={groupedByDwg[activeDwgKey]}
            onClose={() => setActiveDwgKey(null)}
            onOpenMarkset={(ms) => {
              // start inspection for that markset
              handleOpenMarkset(ms);
            }}
          />
        )}
      </div>
    </div>
  );
}


// small styles for setup
const inp: CSSProperties = { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, outline: 'none' };
const btn: CSSProperties = { padding: '8px 14px', border: '1px solid #D99E02', borderRadius: 6, background: '#D99E02', color: '#FFFFFF', cursor: 'pointer' };
const btnPrimary: CSSProperties = { ...btn, borderColor: '#1976d2', color: '#1976d2', fontWeight: 700 };
const btnSecondary: CSSProperties = {
  padding: '8px 18px',
  borderRadius: 7,              // pill shape
  border: '1px solid #3B3B3B',
  background: 'transparent',
  color: '#FFFFFF',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};
// Main Viewer Component
function ViewerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [showSetup, setShowSetup] = useState(true);

  // NEW: keep chosen PDF URL + markset in local state
  const [selectedPdfUrl, setSelectedPdfUrl] = useState<string | null>(null);
  const [selectedMarkSetId, setSelectedMarkSetId] = useState<string | null>(null);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentMarkIndex, setCurrentMarkIndex] = useState(0);
  // NEW: remember if we've already done the initial "jump to first group/mark"
  const hasBootstrappedViewerRef = useRef(false);
  // NEW: last committed mark index, for stable group-change detection
  const lastMarkIndexRef = useRef<number | null>(null);
  // When we jump to a group, force first mark navigation to behave as "group overview"
  const pendingGroupOverviewRef = useRef<number | null>(null);
  // When we come from group view / sidebar / review directly to a mark,
  // request a smart quadrant-style frame instead of full-group overview.
  const pendingSmartFrameRef = useRef<boolean>(false);

  const [zoom, setZoom] = useState(1.0);
  // Quantized zoom setter (must live at component top-level)
  // Single atomic zoom setter - updates zoom + mark box in one tick

  // Markset meta + grouping for QC flows
  const [isMasterMarkSet, setIsMasterMarkSet] = useState<boolean | null>(null);
  const [groupWindows, setGroupWindows] = useState<GroupWindowMeta[] | null>(null);
  const [markToGroupIndex, setMarkToGroupIndex] = useState<number[]>([]);

  const [panelMode, setPanelMode] = useState<'group' | 'mark'>('mark');
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

  // Cache zoom level per group so we don’t recompute on every mark navigation
  const groupZoomCache = useRef<Map<number, number>>(new Map());

  // Report metadata
  const [reportTitle, setReportTitle] = useState(() => getDefaultReportTitle());
  const [showReportTitle, setShowReportTitle] = useState(true);


  const setZoomQ = useCallback(
    (z: number, ref?: MutableRefObject<number>) => {
      const q = quantize(z);
      setZoom(q);
      if (ref) ref.current = q;

      // Atomic: update yellow box in same tick
      const mark = marks[currentMarkIndex];
      if (mark) {
        // Respect QC group page index
        const isMaster = isMasterMarkSet === true;
        let pageIndex = mark.page_index ?? 0;

        if (!isMaster && groupWindows && markToGroupIndex[currentMarkIndex] != null) {
          const gi = markToGroupIndex[currentMarkIndex];
          if (gi >= 0 && gi < groupWindows.length) {
            const gMeta = groupWindows[gi];
            pageIndex = gMeta.page_index ?? mark.page_index ?? 0;
          }
        }

        const base = basePageSizeRef.current[pageIndex];
        if (base) {
          const wZ = base.w * q;
          const hZ = base.h * q;
          setSelectedRect({
            pageNumber: pageIndex + 1,
            x: mark.nx * wZ,
            y: mark.ny * hZ,
            w: mark.nw * wZ,
            h: mark.nh * hZ,
          });
        }
      }

      return q;
    },
    [marks, currentMarkIndex, isMasterMarkSet, groupWindows, markToGroupIndex]
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

  // Always keep sidebar closed while the report-title panel is active
  useEffect(() => {
    if (showReportTitle) {
      setSidebarOpen(false);
    }
  }, [showReportTitle]);

  const [flashRect, setFlashRect] = useState<FlashRect>(null);
  const [selectedRect, setSelectedRect] = useState<FlashRect>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchHighlights, setSearchHighlights] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [highlightPageNumber, setHighlightPageNumber] = useState<number>(0);
  const [isMobileInputMode, setIsMobileInputMode] = useState(false);

  // Always allow browser scroll – we only intercept pinch in the hook
  const pdfTouchAction: CSSProperties['touchAction'] = 'pan-x pan-y';


  const [entries, setEntries] = useState<Record<string, string>>({});
  // Per-mark QC status: PASS / FAIL / DOUBT (keyed by mark_id)
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [showReview, setShowReview] = useState(false);
  const [hasVisitedReview, setHasVisitedReview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Local draft autosave toggle – we enable this only after initial
  // "resume / start fresh" decision so that old drafts aren't overwritten.
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);




  // Refs used by the viewer and smooth zoom
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);
  const pageElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const basePageSizeRef = useRef<Array<{ w: number; h: number }>>([]);

  const layoutRafRef = useRef<number | null>(null);



  // Generate a unique report ID once per viewer session
  const [reportId] = useState(() => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as any).randomUUID();
    }
    return `rpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  });

  // keep current zoom in a ref for synchronous math
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // smooth zoom animation bookkeeping
  const animRafRef = useRef<number | null>(null);
  const isZoomAnimatingRef = useRef(false);
  // ===== Windowing + prefix sums =====
  const GUTTER = 16; // vertical gap between pages
  const SAFE_BOTTOM = 120; // px reserved at bottom so marks don't hide behind InputPanel/keyboard

  const prefixHeightsRef = useRef<number[]>([]);   // top offsets of each page at current zoom
  const totalHeightRef = useRef<number>(0);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 3]); // 1-based inclusive
  // Whenever the document/page-count changes, reset to a safe initial window
  useEffect(() => {
    if (!numPages) return;
    // 🔹 NEW: Show more pages initially (up to 5) so user can scroll during title screen
    setVisibleRange([1, Math.min(5, numPages)]);
  }, [numPages]);

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

  /**
 * Ensure we have base page size for a given pageIndex (0-based).
 * If missing, lazily fetch from pdf and recompute prefix heights.
 */
  const ensureBasePageSize = useCallback(
    async (pageIndex: number): Promise<{ w: number; h: number } | null> => {
      const base = basePageSizeRef.current;

      // already have it
      if (base[pageIndex]) {
        return base[pageIndex];
      }

      if (!pdf) return null;

      try {
        const page = await pdf.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: 1 });
        const entry = { w: vp.width, h: vp.height };
        base[pageIndex] = entry;

        // page height changed → recompute prefix layout
        recomputePrefix();
        return entry;
      } catch (e) {
        console.warn('[ensureBasePageSize] failed for pageIndex=', pageIndex, e);
        return null;
      }
    },
    [pdf, recomputePrefix]
  );

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
    // Don’t bind while we’re still on the setup screen
    if (showSetup) return;
    if (!pdf) return;

    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      updateVisibleRange();
    };

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

    // initial compute once listeners are attached
    recomputePrefix();
    updateVisibleRange();

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize as any);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    pdf,
    showSetup,
    isMobileInputMode,   // layout mode affects container size
    updateVisibleRange,
    recomputePrefix,
    showReportTitle,
  ]);

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
  const smoothZoom = useCallback(
    (toZoomRaw: number, durationMs = 240) => {
      const container = containerRef.current;
      if (!container) return;

      const toZoom = clampZoom(toZoomRaw);

      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);

      const startZoom = zoomRef.current;
      if (Math.abs(toZoom - startZoom) < 1e-4) return;

      const anchorX = container.clientWidth / 2;
      const anchorY = container.clientHeight / 2;

      const contentX = container.scrollLeft + anchorX;
      const contentY = container.scrollTop + anchorY;

      const t0 = performance.now();
      isZoomAnimatingRef.current = true;

      const step = (now: number) => {
        const t = Math.min(1, durationMs === 0 ? 1 : (now - t0) / durationMs);
        const z = lerp(startZoom, toZoom, easeOutCubic(t));
        const k = z / startZoom;

        // ATOMIC: zoom + mark box
        setZoomQ(z, zoomRef);

        const targetLeft = contentX * k - anchorX;
        const targetTop = contentY * k - anchorY;
        const { left, top } = clampScroll(container, targetLeft, targetTop);
        container.scrollLeft = left;
        container.scrollTop = top;

        if (t < 1) {
          animRafRef.current = requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
          isZoomAnimatingRef.current = false;
        }
      };

      animRafRef.current = requestAnimationFrame(step);
    },
    [clampZoom, setZoomQ]
  );

  const zoomAt = useCallback(
    (nextZoomRaw: number, clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return;

      const nextZoom = clampZoom(nextZoomRaw);
      const prevZoom = zoomRef.current;

      // ignore tiny changes – pinch hook already filtered, but double guard
      if (Math.abs(nextZoom - prevZoom) < 0.0005) return;

      const rect = container.getBoundingClientRect();
      const anchorX = clientX - rect.left;
      const anchorY = clientY - rect.top;

      const contentXBefore = container.scrollLeft + anchorX;
      const contentYBefore = container.scrollTop + anchorY;

      // ATOMIC: zoom state + selected box
      const actualZoom = setZoomQ(nextZoom, zoomRef);

      // Let the zoom useEffect handle layout; just fix scroll
      requestAnimationFrame(() => {
        const scale = actualZoom / prevZoom;
        const newScrollLeft = contentXBefore * scale - anchorX;
        const newScrollTop = contentYBefore * scale - anchorY;

        const maxL = Math.max(0, container.scrollWidth - container.clientWidth);
        const maxT = Math.max(0, container.scrollHeight - container.clientHeight);

        container.scrollLeft = Math.max(0, Math.min(newScrollLeft, maxL));
        container.scrollTop = Math.max(0, Math.min(newScrollTop, maxT));
      });
    },
    [clampZoom, setZoomQ]
  );

  const isDemo = searchParams?.get('demo') === '1';
  const qProject = searchParams?.get('project_name') || '';
  const qExtId = searchParams?.get('id') || '';
  const qPartNumber = searchParams?.get('part_number') || '';
  const qDwgNum = searchParams?.get('dwg_num') || '';
  const qUser = searchParams?.get('user_mail') || '';
  const qAssembly = searchParams?.get('assembly_drawing') || '';
  // NEW: optional POC CC list from Glide (comma-separated emails)
  const qPocCc = searchParams?.get('poc_cc') || searchParams?.get('poc') || '';
  const userEmail = (qUser || '').trim() || null;

  // ✅ PATCH: Save the initial querystring once (includes poc / poc_cc)
  // so that later "open markset" doesn't lose it.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const cur = window.location.search.slice(1); // no '?'
    if (!cur) return;

    const existing = sessionStorage.getItem('viewerLastSetupParams');
    if (!existing) {
      sessionStorage.setItem('viewerLastSetupParams', cur);
    }
  }, []);

  // Viewer only needs the business triple; assembly_drawing is optional
  const hasBootstrapKeys = !!(qProject && qExtId && qPartNumber);

  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const markSetIdParam = searchParams?.get('mark_set_id') || '';
  // Show viewer if pdf_url is present OR user already selected a markset
  useEffect(() => {
    // 1) Direct deep-link with ?pdf_url=... → skip setup
    if (pdfUrlParam) {
      setShowSetup(false);
      return;
    }

    // 2) User just chose a markset in this session → skip setup
    if (selectedPdfUrl) {
      setShowSetup(false);
      return;
    }

    // 3) Only bootstrap keys present → show setup
    if (hasBootstrapKeys) {
      setShowSetup(true);
    } else {
      setShowSetup(true);
    }
  }, [pdfUrlParam, selectedPdfUrl, hasBootstrapKeys]);

  // Prefer the PDF URL chosen in this session; fall back to URL param
  const effectivePdfUrl = selectedPdfUrl || pdfUrlParam;


  const handleSetupComplete = (url: string, setId: string, dwgNum?: string | null) => {
    // ✅ Always start from CURRENT URL first (most reliable),
    // fallback to stored baseline only if needed.
    const baseQs =
      window.location.search.slice(1) ||
      sessionStorage.getItem('viewerLastSetupParams') ||
      '';

    const params = new URLSearchParams(baseQs);

    // ✅ Support poc alias: if URL has poc but not poc_cc, convert it
    if (!params.get('poc_cc') && params.get('poc')) {
      params.set('poc_cc', params.get('poc')!);
    }

    // Keep existing bootstrap params + add viewer-specific params
    params.set('pdf_url', url);
    if (setId) params.set('mark_set_id', setId);

    if (dwgNum && dwgNum.trim()) {
      params.set('dwg_num', dwgNum.trim());
    } else {
      params.delete('dwg_num');
    }

    const qsString = params.toString();

    // ✅ Update storage so future flows (submit/reset) retain poc_cc too
    sessionStorage.setItem('viewerLastSetupParams', qsString);

    // Stay on same page, switch to viewer mode
    setSelectedPdfUrl(url);
    setSelectedMarkSetId(setId || null);
    setShowSetup(false);

    // Keep URL sharable without full reload
    const newUrl = `${window.location.pathname}?${qsString}`;
    router.push(newUrl, { scroll: false });
  };


  const rawPdfUrl = cleanPdfUrl(
    isDemo
      ? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
      : effectivePdfUrl ||
      'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'
  );

  const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  const pdfUrl = rawPdfUrl
    ? `${apiBase}/proxy-pdf?url=${encodeURIComponent(rawPdfUrl)}`
    : '';

  const markSetId = selectedMarkSetId || markSetIdParam;

  // 🔹 Local draft persistence (report title + entries + statuses + cursor)
  const { draft, hasDraft, clearDraft, loaded } = useQCDraft({
    enabled: !!markSetId && !showSetup,
    projectName: qProject || '',
    extId: qExtId || '',
    partNumber: qPartNumber || '',
    markSetId: markSetId || null,
    userEmail,
    liveState: {
      reportTitle,
      entries,
      statuses: statuses as Record<string, 'PASS' | 'FAIL' | 'DOUBT' | ''>,
      currentMarkIndex,
      // title panel already confirmed = user actually started inspection
      titleConfirmed: !showReportTitle,
    },
    autosave: autosaveEnabled,
  });

  const [showDraftDialog, setShowDraftDialog] = useState(false);
  const [hasHandledInitialDraft, setHasHandledInitialDraft] = useState(false);

  // Decide once per markset: either show resume dialog, or enable autosave directly
  useEffect(() => {
    if (!markSetId || showSetup) return;

    // ✅ NEW: wait until useQCDraft has actually checked localStorage
    if (!loaded) return;

    if (hasHandledInitialDraft) return;

    if (draft && hasDraft) {
      // previous data exists → ask user
      setShowDraftDialog(true);
    } else {
      // no previous data → start autosaving immediately
      setAutosaveEnabled(true);
      setHasHandledInitialDraft(true);
    }
  }, [draft, hasDraft, hasHandledInitialDraft, markSetId, showSetup, loaded]);


  // Reset viewer bootstrap state when markset changes
  useEffect(() => {
    hasBootstrappedViewerRef.current = false;
    lastMarkIndexRef.current = null;
    groupZoomCache.current.clear();
    setCurrentGroupIndex(0);
    setPanelMode('group'); // QC will immediately jump to group 0; master will override to mark mode
    setCurrentMarkIndex(0);
    setShowReview(false);
    setHasVisitedReview(false);

    // ✅ NEW: draft handling is per-markset, so reset these too
    setAutosaveEnabled(false);
    setHasHandledInitialDraft(false);

    // Reset title for each new inspection session
    setReportTitle(getDefaultReportTitle());
    setShowReportTitle(true);
  }, [markSetId]);



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
      setStatuses({});           // 🔴 reset statuses as well
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
          if (qDwgNum) qs.set('dwg_num', qDwgNum);
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
          setStatuses({}); // 🔴 clear any stale statuses when loading new marks


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

            // Sort marks inside the group
            //gm.sort((a: any, b: any) => {
            //  const ai = (a.instrument || '').toLowerCase();
            //  const bi = (b.instrument || '').toLowerCase();
            //    if (ai && bi && ai !== bi) return ai.localeCompare(bi);
            //    return (a.order_index ?? 0) - (b.order_index ?? 0);
            //});
            // Sort marks inside the group (instrument A→Z, blanks last; stable secondary)
            gm.sort((a: any, b: any) => {
              const ai = String(a?.instrument ?? '').trim().toLowerCase();
              const bi = String(b?.instrument ?? '').trim().toLowerCase();

              const aEmpty = !ai;
              const bEmpty = !bi;

              // 1) instruments with no value go to the end
              if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;

              // 2) instrument alphabetical (only when both non-empty)
              if (!aEmpty && ai !== bi) return ai.localeCompare(bi);

              // 3) secondary: label (if both present), else order_index
              const al = String(a?.label ?? '').trim().toLowerCase();
              const bl = String(b?.label ?? '').trim().toLowerCase();
              if (al && bl && al !== bl) return al.localeCompare(bl);

              return (a?.order_index ?? 0) - (b?.order_index ?? 0);
            });

            const startIndex = orderedMarks.length;

            // 🔑 Index inside *groupMeta*, not original gi
            const groupMetaIndex = groupMeta.length;

            gm.forEach((m: any) => {
              const cloned: Mark = { ...m };
              cloned.order_index = orderedMarks.length; // global order index

              orderedMarks.push(cloned);
              // ✅ map marks → "dense" group index (0..groupMeta.length-1)
              groupIndexForMark.push(groupMetaIndex);
            });

            const endIndex = orderedMarks.length - 1;
            if (startIndex > endIndex) return;

            const pageIndex = g.page_index ?? (gm[0]?.page_index ?? 0);

            const nxVals = gm.map((m: any) => m.nx ?? 0);
            const nyVals = gm.map((m: any) => m.ny ?? 0);
            const x2Vals = gm.map((m: any) => (m.nx ?? 0) + (m.nw ?? 0));
            const y2Vals = gm.map((m: any) => (m.ny ?? 0) + (m.nh ?? 0));

            const minNx = g.nx ?? Math.min(...nxVals);
            const minNy = g.ny ?? Math.min(...nyVals);
            const maxNx = g.nw ? minNx + g.nw : Math.max(...x2Vals);
            const maxNy = g.nh ? minNy + g.nh : Math.max(...y2Vals);

            groupMeta.push({
              group_id: String(g.group_id ?? groupMetaIndex),
              name: g.name || `Group ${groupMetaIndex + 1}`,
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
          setStatuses({}); // 🔴 start with blank statuses for this QC run


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
        setStatuses({}); // 🔴 legacy path also resets statuses


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
  }, [markSetId, isDemo, showSetup, apiBase, qProject, qExtId, qPartNumber, qDwgNum, qUser]);



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

  useEffect(() => {
    if (layoutRafRef.current != null) return;

    layoutRafRef.current = requestAnimationFrame(() => {
      recomputePrefix();
      updateVisibleRange();
      layoutRafRef.current = null;
    });
  }, [zoom, recomputePrefix, updateVisibleRange]);


  const navigateToMark = useCallback(
    async (index: number) => {
      if (!pdf) return;

      // Defensive: re-check bounds
      if (index < 0 || index >= marks.length) {
        console.warn('[navigateToMark] invalid index', index, 'marks length:', marks.length);
        return;
      }

      // Move currentMarkIndex immediately so InputPanel / HUD update
      setCurrentMarkIndex(index);

      const prevIdx = lastMarkIndexRef.current ?? currentMarkIndex;
      const mark = marks[index];
      if (!mark) {
        console.warn('[navigateToMark] mark at index is undefined', index);
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      const isMaster = isMasterMarkSet === true;

      // Resolve group index (QC only)
      let groupIdx: number | null = null;
      if (!isMaster && groupWindows && markToGroupIndex[index] != null) {
        const gi = markToGroupIndex[index];
        if (gi != null && gi >= 0 && gi < groupWindows.length) {
          groupIdx = gi;
        }
      }

      const hasGroup = groupIdx !== null;
      const gMeta = hasGroup ? groupWindows![groupIdx!] : null;

      // Page index: group page for QC, mark page for master/legacy
      const pageIndex =
        hasGroup && gMeta
          ? (gMeta.page_index ?? mark.page_index ?? 0)
          : (mark.page_index ?? 0);
      const pageNumber = pageIndex + 1;

      // Ensure DOM element for that page exists (windowing)
      let pageEl = pageElsRef.current[pageIndex];

      if (!pageEl) {
        const pref = prefixHeightsRef.current;

        if (pref.length > pageIndex) {
          const targetTop = pref[pageIndex];
          container.scrollTo({ top: targetTop, behavior: 'auto' });
        }

        // Let windowing catch up
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            updateVisibleRange();
            requestAnimationFrame(() => resolve());
          });
        });

        pageEl = pageElsRef.current[pageIndex];

        let retries = 0;
        while (!pageEl && retries < 5) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          updateVisibleRange();
          pageEl = pageElsRef.current[pageIndex];
          retries++;
        }

        if (!pageEl) {
          console.warn(
            '[navigateToMark] page element still missing after retries, pageIndex=',
            pageIndex
          );
          return;
        }
      }

      let base = basePageSizeRef.current[pageIndex];
      if (!base) {
        const ensuredBase = await ensureBasePageSize(pageIndex);
        if (!ensuredBase) {
          console.warn(
            '[navigateToMark] could not resolve base size for pageIndex=',
            pageIndex
          );
          return;
        }
        base = ensuredBase;
      }

      const containerW = container.clientWidth;
      const containerH = container.clientHeight;

      // Mark rect on this page at scale = 1
      const markRectAt1: Rect = {
        x: mark.nx * base.w,
        y: mark.ny * base.h,
        w: mark.nw * base.w,
        h: mark.nh * base.h,
      };

      // One-shot flag: did caller request smart framing for this navigation?
      const wantsSmartFrame = pendingSmartFrameRef.current;
      pendingSmartFrameRef.current = false;

      // ---------- MASTER / LEGACY FLOW ----------
      if (isMaster || !hasGroup || !gMeta) {
        const rectAt1 = markRectAt1;

        let targetZoom = Math.min(
          (containerW * 0.8) / rectAt1.w,
          (containerH * 0.8) / rectAt1.h
        );
        targetZoom = Math.min(targetZoom, 4);
        if (containerW < 600) targetZoom = Math.min(targetZoom, 3);

        const qZoom = setZoomQ(targetZoom, zoomRef);

        // ✅ prefix + totalHeight ko isi zoom pe update kar do
        recomputePrefix();

        requestAnimationFrame(async () => {
          const expectedW = base.w * qZoom;
          const expectedH = base.h * qZoom;
          const expectedTotalHeight = totalHeightRef.current;

          await waitForCanvasLayout(
            pageEl!,
            expectedW,
            expectedH,
            1500,
            container,
            expectedTotalHeight
          );

          const containerRect = container.getBoundingClientRect();
          const pageRect = pageEl!.getBoundingClientRect();

          const pageOffsetLeft =
            container.scrollLeft + (pageRect.left - containerRect.left);
          const pageOffsetTop =
            container.scrollTop + (pageRect.top - containerRect.top);

          const z = zoomRef.current || qZoom;

          const rectAtZ = {
            x: rectAt1.x * z,
            y: rectAt1.y * z,
            w: rectAt1.w * z,
            h: rectAt1.h * z,
          };

          setFlashRect({ pageNumber, ...rectAtZ });
          setSelectedRect({ pageNumber, ...rectAtZ });
          setTimeout(() => setFlashRect(null), 1200);

          const markCenterX = pageOffsetLeft + rectAtZ.x + rectAtZ.w / 2;
          const markCenterY = pageOffsetTop + rectAtZ.y + rectAtZ.h / 2;

          const targetScrollLeft = markCenterX - containerW / 2;
          const targetScrollTop = markCenterY - containerH / 2;

          const { left: clampedL, top: clampedT } = clampScroll(
            container,
            targetScrollLeft,
            targetScrollTop
          );

          container.scrollTo({
            left: clampedL,
            top: clampedT,
            behavior: 'smooth',
          });
        });

        lastMarkIndexRef.current = index;
        return;
      }

      // ---------- QC FLOW: group-wise handling ----------
      const gi = groupIdx!;
      const group = gMeta!;

      const groupRectAt1: Rect = {
        x: group.nx * base.w,
        y: group.ny * base.h,
        w: group.nw * base.w,
        h: group.nh * base.h,
      };

      // Smart quadrant-style framing only in MARK mode
      const smartFrame = wantsSmartFrame;
      let smartRegionRectAt1: Rect | null = null;
      if (smartFrame) {
        smartRegionRectAt1 = computeSmartRegionWithinGroup(groupRectAt1, markRectAt1);
      }

      // Previous group index (based on last focused mark)
      const prevGroupIdx =
        prevIdx >= 0 &&
          prevIdx < marks.length &&
          markToGroupIndex[prevIdx] != null
          ? markToGroupIndex[prevIdx]
          : gi;

      let groupChanged = gi !== prevGroupIdx;

      // If navigateToGroup() explicitly told us "show overview for this group",
      // force a groupChanged=true for this navigation.
      if (
        pendingGroupOverviewRef.current != null &&
        pendingGroupOverviewRef.current === gi
      ) {
        groupChanged = true;
        pendingGroupOverviewRef.current = null;
      }

      // For smart-frame jumps, we DON'T want full-group overview behaviour.
      const effectiveGroupChanged = groupChanged && !smartFrame;

      let targetZoom = zoomRef.current || 1.0;

      if (effectiveGroupChanged) {
        // Either reuse cached zoom (when coming back to this group in mark mode),
        // or compute a fresh zoom that fits the whole group inside the *actual*
        // scroll container area. We no longer subtract HUD/InputPanel here because
        // the layout already gives the PDF only the free space above the panel.
        const cached = groupZoomCache.current.get(gi);
        const useCache = cached && panelMode !== 'group';

        if (useCache) {
          targetZoom = cached;
        } else {
          const containerRect = container.getBoundingClientRect();
          const margin = 16; // small visual margin around the group

          const usableWidth = Math.max(
            40,
            containerRect.width - margin * 2
          );
          const usableHeight = Math.max(
            40,
            containerRect.height - margin * 2
          );

          const rawZoom = computeZoomForRect(
            { w: usableWidth, h: usableHeight },
            { w: base.w, h: base.h },
            groupRectAt1,
            0.02 // 2% padding inside usable rect
          );

          targetZoom = quantize(rawZoom);
          groupZoomCache.current.set(gi, targetZoom);
        }

        setZoomQ(targetZoom, zoomRef);
        recomputePrefix();
      }

      // Smart-frame: compute zoom to fit the chosen quadrant / sub-region
      if (smartFrame && smartRegionRectAt1) {
        const containerRect = container.getBoundingClientRect();
        const margin = 16;

        const usableWidth = Math.max(40, containerRect.width - margin * 2);
        const usableHeight = Math.max(40, containerRect.height - margin * 2);

        const rawZoom = computeZoomForRect(
          { w: usableWidth, h: usableHeight },
          { w: base.w, h: base.h },
          smartRegionRectAt1,
          0.04 // a little padding around that region
        );

        targetZoom = quantize(rawZoom);
        setZoomQ(targetZoom, zoomRef);
        recomputePrefix();
      }

      requestAnimationFrame(async () => {
        const expectedW = base.w * targetZoom;
        const expectedH = base.h * targetZoom;

        if (effectiveGroupChanged || smartFrame) {
          const expectedTotalHeight = totalHeightRef.current;

          await waitForCanvasLayout(
            pageEl!,
            expectedW,
            expectedH,
            1500,
            container,
            expectedTotalHeight
          );

          // double safety: prefix ko layout-stable hone ke baad phir se recompute
          recomputePrefix();
        }

        const containerRect = container.getBoundingClientRect();
        const pageRect = pageEl!.getBoundingClientRect();
        const pageOffsetLeft =
          container.scrollLeft + (pageRect.left - containerRect.left);
        // NOTE: vertical offset hum ab DOM se nahi, apne virtual layout se lenge

        const z = zoomRef.current || targetZoom;

        const rectAtZ = {
          x: markRectAt1.x * z,
          y: markRectAt1.y * z,
          w: markRectAt1.w * z,
          h: markRectAt1.h * z,
        };

        const groupRectAtZ = {
          x: groupRectAt1.x * z,
          y: groupRectAt1.y * z,
          w: groupRectAt1.w * z,
          h: groupRectAt1.h * z,
        };

        const smartRegionRectAtZ = smartRegionRectAt1
          ? {
            x: smartRegionRectAt1.x * z,
            y: smartRegionRectAt1.y * z,
            w: smartRegionRectAt1.w * z,
            h: smartRegionRectAt1.h * z,
          }
          : null;

        // Highlight current mark box (yellow) + flash
        setFlashRect({ pageNumber, ...rectAtZ });
        setSelectedRect({ pageNumber, ...rectAtZ });
        setTimeout(() => setFlashRect(null), 1200);

        // ===== SCROLL LOGIC =====

        // 🔴 Canonical page top using prefixHeightsRef (vertical layout)
        const pref = prefixHeightsRef.current;
        const canonicalPageTop =
          pref && pref.length > pageIndex ? pref[pageIndex] : 0;

        // 🔴 Canonical page left – matches how PageCanvas centers the page
        const pageWidthZ = base.w * z;
        const canonicalPageLeft =
          containerW > 0 ? Math.max(0, (containerW - pageWidthZ) / 2) : 0;

        // Absolute group bounds in scroll coordinates
        const groupLeft = canonicalPageLeft + groupRectAtZ.x;
        const groupTopAbs = canonicalPageTop + groupRectAtZ.y;
        const groupRight = groupLeft + groupRectAtZ.w;
        const groupBottomAbs = groupTopAbs + groupRectAtZ.h;

        const effectiveViewWidth = containerW;
        const windowWidth = Math.min(groupRectAtZ.w, effectiveViewWidth);

        // Bottom-safe height: reserve some space so yellow box + mark
        // InputPanel/keyboard ke peeche na chhup jaaye.
        const rawVisibleHeight = container.clientHeight;
        const visibleHeight = Math.max(40, rawVisibleHeight - SAFE_BOTTOM);
        const windowHeight = Math.min(groupRectAtZ.h, visibleHeight);

        let targetScrollLeft: number;
        let targetScrollTop: number;

        if (effectiveGroupChanged) {
          // Group overview: center entire group
          const groupCenterX = groupLeft + groupRectAtZ.w / 2;
          const groupCenterY = groupTopAbs + groupRectAtZ.h / 2;

          targetScrollLeft = groupCenterX - effectiveViewWidth / 2;
          targetScrollTop = groupCenterY - visibleHeight / 2;
        } else if (smartFrame && smartRegionRectAtZ) {
          // Smart-frame: center chosen quadrant / sub-region
          const regionCenterX =
            canonicalPageLeft +
            smartRegionRectAtZ.x +
            smartRegionRectAtZ.w / 2;
          const regionCenterY =
            canonicalPageTop +
            smartRegionRectAtZ.y +
            smartRegionRectAtZ.h / 2;

          targetScrollLeft = regionCenterX - effectiveViewWidth / 2;
          targetScrollTop = regionCenterY - visibleHeight / 2;
        } else {
          // Mark-by-mark window sliding *inside* group
          const markCenterX =
            canonicalPageLeft + rectAtZ.x + rectAtZ.w / 2;
          let desiredLeft = markCenterX - windowWidth / 2;
          const minLeft = groupLeft;
          const maxLeft = groupRight - windowWidth;
          desiredLeft = Math.max(minLeft, Math.min(desiredLeft, maxLeft));
          targetScrollLeft = desiredLeft;

          const markCenterY =
            canonicalPageTop + rectAtZ.y + rectAtZ.h / 2;
          let desiredTop = markCenterY - windowHeight / 2;
          const minTop = groupTopAbs;
          const maxTop = groupBottomAbs - windowHeight;
          desiredTop = Math.max(minTop, Math.min(desiredTop, maxTop));
          targetScrollTop = desiredTop;
        }

        const { left: clampedL, top: clampedT } = clampScroll(
          container,
          targetScrollLeft,
          targetScrollTop
        );

        container.scrollTo({
          left: clampedL,
          top: clampedT,
          behavior: 'smooth',
        });
      });


      lastMarkIndexRef.current = index;
    },
    [
      marks,
      pdf,
      isMasterMarkSet,
      groupWindows,
      markToGroupIndex,
      currentMarkIndex,
      setCurrentMarkIndex,
      panelMode,
      isMobileInputMode,
      setZoomQ,
      groupZoomCache,
      ensureBasePageSize,
      updateVisibleRange,
      recomputePrefix,
    ]
  );

  // --- Group-aware navigation helpers ---
  const navigateToGroup = useCallback(
    async (groupIdx: number) => {
      if (!groupWindows || groupIdx < 0 || groupIdx >= groupWindows.length) return;
      const meta = groupWindows[groupIdx];

      // Update state for "current group"
      setCurrentGroupIndex(groupIdx);
      setCurrentMarkIndex(meta.startIndex);
      setPanelMode('group');

      // Clear stale per-group zoom so we recompute using latest viewport
      groupZoomCache.current.delete(groupIdx);

      // 🔹 Tell navigateToMark: the NEXT call for this group should behave
      //     as GROUP OVERVIEW (fit whole group, not individual mark).
      pendingGroupOverviewRef.current = groupIdx;

      // Small delay so React can commit state
      await new Promise((r) => setTimeout(r, 50));

      await navigateToMark(meta.startIndex);
    },
    [groupWindows, navigateToMark, groupZoomCache]
  );

  // When marks + PDF are ready *and* title is confirmed,
  // start at first group (QC) or first mark (master/legacy)
  useEffect(() => {
    if (!pdf || !marks.length) return;
    if (showReportTitle) return;

    // Only run ONCE per load
    if (hasBootstrappedViewerRef.current) return;

    // 🔹 NEW: Force re-navigation to ensure proper zoom/scroll after title dismissal
    const timer = setTimeout(() => {
      if (isMasterMarkSet === false && groupWindows && groupWindows.length) {
        hasBootstrappedViewerRef.current = true;
        // Clear any stale zoom cache from title screen
        groupZoomCache.current.clear();
        navigateToGroup(0);
        return;
      }

      if (currentMarkIndex === 0) {
        hasBootstrappedViewerRef.current = true;
        setPanelMode('mark');
        navigateToMark(0);
      }
    }, 300); // small delay to let title panel unmount cleanly

    return () => clearTimeout(timer);
  }, [
    pdf,
    marks.length,
    isMasterMarkSet,
    groupWindows,
    currentMarkIndex,
    navigateToGroup,
    navigateToMark,
    showReportTitle,
    groupZoomCache,
  ]);

  const proceedFromGroupToMarks = useCallback(() => {
    if (!marks.length) return;

    // We're leaving group overview → first mark of this group
    setPanelMode('mark');
    pendingSmartFrameRef.current = true; // use quadrant framing for this jump

    const safeIndex =
      currentMarkIndex >= 0 && currentMarkIndex < marks.length ? currentMarkIndex : 0;
    navigateToMark(safeIndex);
  }, [currentMarkIndex, marks.length, navigateToMark]);


  const jumpDirectToMark = useCallback(
    (index: number) => {
      if (index < 0 || index >= marks.length) return;

      setPanelMode('mark');
      setCurrentMarkIndex(index);

      if (markToGroupIndex.length && groupWindows && groupWindows.length) {
        const gi = markToGroupIndex[index];
        if (gi != null && gi >= 0 && gi < groupWindows.length) {
          setCurrentGroupIndex(gi);
        }
      }

      // Sidebar / review jumps should use smart quadrant framing
      pendingSmartFrameRef.current = true;
      navigateToMark(index);
    },
    [marks.length, markToGroupIndex, groupWindows, navigateToMark]
  );

  const prevMark = useCallback(() => {
    if (!marks.length) return;

    if (panelMode === 'group') {
      // From group overview, go to last mark of previous group (if any)
      if (!groupWindows || !groupWindows.length) return;
      const prevGroupIdx = currentGroupIndex - 1;
      if (prevGroupIdx < 0) return;

      const prevMeta = groupWindows[prevGroupIdx];
      const lastIndex = prevMeta.endIndex;

      setCurrentGroupIndex(prevGroupIdx);
      setPanelMode('mark');
      navigateToMark(lastIndex);
      return;
    }

    if (currentMarkIndex > 0) {
      const prevIndex = currentMarkIndex - 1;
      setCurrentMarkIndex(prevIndex);

      if (markToGroupIndex.length && groupWindows && groupWindows.length) {
        const gi = markToGroupIndex[prevIndex];
        if (gi != null && gi >= 0 && gi < groupWindows.length) {
          setCurrentGroupIndex(gi);
        }
      }

      navigateToMark(prevIndex);
    }
  }, [
    panelMode,
    marks.length,
    currentMarkIndex,
    currentGroupIndex,
    groupWindows,
    markToGroupIndex,
    navigateToMark,
  ]);

  const openReview = useCallback(() => {
    // Central place to enter review mode
    setShowReview(true);
    setHasVisitedReview(true);
  }, []);

  const nextMark = useCallback(() => {
    if (!marks.length) return;

    // In group overview, the "Next" button should behave similar to sliding
    if (panelMode === 'group') {
      proceedFromGroupToMarks();
      return;
    }

    const safeCurrentGroup = (() => {
      if (!groupWindows || !groupWindows.length || !markToGroupIndex.length) return null;
      const gi = markToGroupIndex[currentMarkIndex];
      if (gi == null || gi < 0 || gi >= groupWindows.length) return null;
      return groupWindows[gi];
    })();

    const lastIndexInGroup =
      safeCurrentGroup != null ? safeCurrentGroup.endIndex : marks.length - 1;

    // Still marks left in this group → go to next mark
    if (currentMarkIndex < lastIndexInGroup) {
      const nextIndex = currentMarkIndex + 1;
      setCurrentMarkIndex(nextIndex);
      navigateToMark(nextIndex);
      return;
    }

    // Last mark of this group → go to next group's overview
    if (groupWindows && groupWindows.length && markToGroupIndex.length) {
      const rawGi = markToGroupIndex[currentMarkIndex];
      const currentGroupIdx =
        rawGi == null || rawGi < 0 || rawGi >= groupWindows.length ? 0 : rawGi;

      const nextGroupIdx = currentGroupIdx + 1;
      if (nextGroupIdx < groupWindows.length) {
        navigateToGroup(nextGroupIdx);
        return;
      }
    }

    // Last mark of last group → show review
    openReview();
  }, [
    panelMode,
    marks.length,
    currentMarkIndex,
    groupWindows,
    markToGroupIndex,
    navigateToGroup,
    navigateToMark,
    proceedFromGroupToMarks,
    openReview,
  ]);


  const handleJumpFromReview = useCallback(
    (index: number) => {
      setShowReview(false); // close review
      setTimeout(() => {
        jumpDirectToMark(index); // jump to the chosen mark
      }, 0); // let ReviewScreen unmount first
    },
    [jumpDirectToMark]
  );


  const selectFromList = useCallback(
    (index: number) => {
      const needsDelay = window.innerWidth < 900;

      if (needsDelay) {
        if (sidebarOpen) setSidebarOpen(false);
        // Let sidebar close animation finish
        requestAnimationFrame(() => {
          setTimeout(() => jumpDirectToMark(index), 50);
        });
      } else {
        // Desktop = immediate mark jump
        requestAnimationFrame(() => jumpDirectToMark(index));
      }
    },
    [jumpDirectToMark, sidebarOpen]
  );


  const jumpToPage = useCallback(
    (pageNumber: number) => {
      if (!pdf || !containerRef.current) return;

      const container = containerRef.current;
      let pageEl = pageElsRef.current[pageNumber - 1];

      // If the page isn't currently rendered (because of windowing),
      // scroll to its top using prefixHeights so it enters the window.
      if (!pageEl) {
        const pref = prefixHeightsRef.current;
        if (pref.length >= pageNumber) {
          const targetTop = pref[pageNumber - 1];
          container.scrollTo({ top: targetTop, left: 0, behavior: 'auto' });
        }

        // Give React a frame to render the new PageCanvas
        requestAnimationFrame(() => {
          const containerNow = containerRef.current;
          const el = pageElsRef.current[pageNumber - 1];
          if (!containerNow || !el) return;

          const containerRect = containerNow.getBoundingClientRect();
          const pageRect = el.getBoundingClientRect();

          const pageLeftInScroll =
            containerNow.scrollLeft + (pageRect.left - containerRect.left);
          const pageTopInScroll =
            containerNow.scrollTop + (pageRect.top - containerRect.top);

          const targetLeft = Math.max(
            0,
            pageLeftInScroll + el.clientWidth / 2 - containerNow.clientWidth / 2
          );

          containerNow.scrollTo({
            left: targetLeft,
            top: pageTopInScroll,
            behavior: 'smooth',
          });
        });

        return;
      }

      // Normal path: page already rendered
      const containerRect = container.getBoundingClientRect();
      const pageRect = pageEl.getBoundingClientRect();

      const pageLeftInScroll =
        container.scrollLeft + (pageRect.left - containerRect.left);
      const pageTopInScroll =
        container.scrollTop + (pageRect.top - containerRect.top);

      const targetLeft = Math.max(
        0,
        pageLeftInScroll + pageEl.clientWidth / 2 - container.clientWidth / 2
      );

      container.scrollTo({
        left: targetLeft,
        top: pageTopInScroll,
        behavior: 'smooth',
      });
    },
    [pdf]
  );

  const handleEntryChange = useCallback((value: string) => {
    const currentMark = marks[currentMarkIndex];
    if (currentMark?.mark_id) {
      setEntries(prev => ({
        ...prev,
        [currentMark.mark_id!]: value
      }));
    }
  }, [currentMarkIndex, marks]);

  const handleStatusChange = useCallback(
    (status: 'PASS' | 'FAIL' | 'DOUBT') => {
      const currentMark = marks[currentMarkIndex];
      if (currentMark?.mark_id) {
        setStatuses((prev) => ({
          ...prev,
          [currentMark.mark_id!]: status,
        }));
      }
    },
    [currentMarkIndex, marks]
  );

  const handleSubmit = useCallback(async () => {
    if (!markSetId) {
      toast.error('No mark set ID provided');
      return;
    }

    // Safety: should never happen because ReportTitlePanel blocks,
    // but guard anyway so backend ALWAYS sees a title.
    if (!reportTitle.trim()) {
      toast.error('Please enter a report title before submitting.');
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

    // Build a parallel status map (default "NA" if not selected)
    const finalStatuses: Record<string, string> = {};
    marks.forEach((mark) => {
      if (!mark.mark_id) return;
      const s = statuses[mark.mark_id];
      finalStatuses[mark.mark_id] = s || 'NA';
    });

    try {
      // Use actual email from query params if present

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
          statuses: finalStatuses,   // 🔥 NEW: per-mark PASS / FAIL / DOUBT / NA
          pdf_url: rawPdfUrl,
          user_email: userEmail,     // still accepted (alias user_mail also works server-side)
          padding_pct: 0.25,
          office_variant: 'o365',

          // viewer metadata
          report_title: reportTitle.trim(),
          report_id: reportId,

          // POC CC list (comma-separated)
          poc_cc: qPocCc || undefined,
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

      // ✅ Clear any saved local draft after successful submit
      clearDraft();

      // Navigate back to the mark-set chooser (reset to generic triple)
      setTimeout(() => {
        const qs =

          sessionStorage.getItem('viewerLastSetupParams') ||
          window.location.search.slice(1);

        const sp = new URLSearchParams(qs);

        // Always keep these:
        sp.set('autoboot', '1');

        // 🔹 Clear all QC-specific viewer state from the URL
        sp.delete('pdf_url');      // already there
        sp.delete('mark_set_id');  // already there
        sp.delete('dwg_num');      // 👈 NEW: don't auto-filter to last drawing

        // (optional but nice) update the stored baseline so next run starts clean
        sessionStorage.setItem('viewerLastSetupParams', sp.toString());

        window.location.href = `${window.location.pathname}?${sp.toString()}`;
      }, 1200);


    } catch (error) {
      console.error('Submit error:', error);
      toast.error('Failed to submit. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    markSetId,
    entries,
    statuses,       // ✅ VERY IMPORTANT: include statuses
    apiBase,
    rawPdfUrl,
    searchParams,
    qUser,
    qPocCc,
    marks,
    reportTitle,
    reportId,
    clearDraft,
  ]);




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

  // While the report-title screen is visible, keep the first page nicely fit.
  // Once we start navigation (hasBootstrappedViewerRef = true), group/mark logic
  // takes over zoom control.
  useEffect(() => {
    if (!pdf || !numPages) return;
    if (showSetup) return;
    if (!showReportTitle) return;
    if (hasBootstrappedViewerRef.current) return;
    fitToWidthZoom();
  }, [pdf, numPages, showSetup, showReportTitle, fitToWidthZoom]);


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

  // Touch pan (1 finger) + pinch-zoom (2 fingers) on the PDF container (mobile only)
  usePinchZoom({
    containerRef,
    zoomRef,
    zoomAt,
    clampZoom,
    enabled: TOUCH_GESTURES_ENABLED,
  });


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

  // --- Compute all mark rects for current group on a given page (for "slide" overview) ---
  const getCurrentGroupRectsForPage = useCallback(
    (pageNum: number): { x: number; y: number; w: number; h: number }[] | null => {
      // Only in QC flow + GROUP mode we draw all marks of group
      if (panelMode !== 'group') return null;
      if (isMasterMarkSet !== false) return null;
      if (!groupWindows || !groupWindows.length) return null;
      if (!markToGroupIndex.length) return null;

      const gi = currentGroupIndex;
      const groupMeta = groupWindows[gi];
      if (!groupMeta) return null;

      const z = zoomRef.current || 1.0;
      const rects: { x: number; y: number; w: number; h: number }[] = [];

      for (let i = groupMeta.startIndex; i <= groupMeta.endIndex; i++) {
        const m = marks[i];
        if (!m) continue;

        // Use mark's own page_index if present, else group's page
        const pageIndex = (m.page_index ?? groupMeta.page_index ?? 0);
        if (pageIndex !== pageNum - 1) continue;

        const base = basePageSizeRef.current[pageIndex];
        if (!base) continue;

        rects.push({
          x: (m.nx ?? 0) * base.w * z,
          y: (m.ny ?? 0) * base.h * z,
          w: (m.nw ?? 0) * base.w * z,
          h: (m.nh ?? 0) * base.h * z,
        });
      }

      return rects.length ? rects : null;
    },
    [panelMode, isMasterMarkSet, groupWindows, markToGroupIndex, currentGroupIndex, marks]
  );

  // --- Single outline rect for the current group on a given page (for blue border) ---
  const getCurrentGroupOutlineForPage = useCallback(
    (pageNum: number): { x: number; y: number; w: number; h: number } | null => {
      // Only show outline in QC + GROUP mode
      if (panelMode !== 'group') return null;
      if (isMasterMarkSet !== false) return null;
      if (!groupWindows || !groupWindows.length) return null;

      const gi = currentGroupIndex;
      const groupMeta = groupWindows[gi];
      if (!groupMeta) return null;

      const pageIndex = groupMeta.page_index ?? 0;
      if (pageIndex !== pageNum - 1) return null;

      const base = basePageSizeRef.current[pageIndex];
      if (!base) return null;

      const z = zoomRef.current || 1.0;

      return {
        x: (groupMeta.nx ?? 0) * base.w * z,
        y: (groupMeta.ny ?? 0) * base.h * z,
        w: (groupMeta.nw ?? 0) * base.w * z,
        h: (groupMeta.nh ?? 0) * base.h * z,
      };
    },
    [panelMode, isMasterMarkSet, groupWindows, currentGroupIndex]
  );

  const pagesToRender =
    numPages === 0
      ? []
      : showReportTitle
        ? [1] // Only first page while title is shown
        : Array.from(
          { length: Math.max(0, visibleRange[1] - visibleRange[0] + 1) },
          (_, i) => visibleRange[0] + i
        );
  // --- Local draft: apply or discard ------------------------------------

  const handleResumeDraft = () => {
    if (!draft) return;

    // Restore entries + statuses
    setEntries(draft.entries || {});
    setStatuses(draft.statuses || {});

    // Restore report title
    if (typeof draft.reportTitle === 'string') {
      setReportTitle(draft.reportTitle);
    }

    // Restore whether title panel was already confirmed
    if (draft.titleConfirmed) {
      setShowReportTitle(false);
    }

    // Restore cursor index safely
    const safeIndex =
      typeof draft.currentMarkIndex === 'number' &&
        draft.currentMarkIndex >= 0 &&
        draft.currentMarkIndex < marks.length
        ? draft.currentMarkIndex
        : 0;

    setCurrentMarkIndex(safeIndex);

    // Mark initial decision done + start autosave
    setShowDraftDialog(false);
    setAutosaveEnabled(true);
    setHasHandledInitialDraft(true);

    // Jump camera to that mark (same place user left)
    if (marks.length && pdf) {
      pendingSmartFrameRef.current = true; // use smart framing for this jump
      jumpDirectToMark(safeIndex);
      // tell bootstrap effect that we've already positioned camera
      hasBootstrappedViewerRef.current = true;
    }
  };

  const handleDiscardDraft = () => {
    clearDraft();
    setShowDraftDialog(false);
    setAutosaveEnabled(true);
    setHasHandledInitialDraft(true);
    // entries/statuses stay as freshly initialised blanks from loadMarks()
  };



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



  // Mobile input mode
  if (isMobileInputMode && marks.length > 0) {
    const currentMark = marks[currentMarkIndex];
    const currentValue = currentMark?.mark_id ? entries[currentMark.mark_id] || '' : '';
    const currentStatus =
      currentMark?.mark_id ? (statuses[currentMark.mark_id] as 'PASS' | 'FAIL' | 'DOUBT' | undefined) || '' : '';

    const currentGroupMeta =
      isMasterMarkSet === false &&
        groupWindows &&
        groupWindows.length &&
        markToGroupIndex.length
        ? groupWindows[currentGroupIndex] ?? null
        : null;


    const currentGroupInstrumentSummary =
      currentGroupMeta && marks.length
        ? (() => {
          const instruments = new Set<string>();
          for (let i = currentGroupMeta.startIndex; i <= currentGroupMeta.endIndex; i++) {
            const m = marks[i] as any;
            const inst = m?.instrument?.trim();
            if (inst) instruments.add(inst);
          }
          const list = Array.from(instruments);
          return list.length ? list.join(', ') : 'No instrument mentioned';
        })()
        : '';


    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100dvh',
          overflow: 'hidden',
        }}
      >
        <Toaster position="top-center" />
        {showDraftDialog && draft && (
          <DraftResumeDialog
            updatedAt={draft.updatedAt}
            onResume={handleResumeDraft}
            onDiscard={handleDiscardDraft}
          />
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden',
          }}
        >
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
                isMasterMarkSet === false && groupWindows ? groupWindows : undefined
              }
              onSelect={(index) => {
                setSidebarOpen(false);
                // delay helps layout settle on mobile
                setTimeout(() => selectFromList(index), 60);
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
              minWidth: 0,
            }}
            {...(SWIPE_TO_STEP_ENABLED ? swipeHandlers : {})}
          >
            {/* ✅ Floating HUD (mobile) */}
            <FloatingHUD
              sidebarOpen={sidebarOpen}
              onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
              sidebarDisabled={showReportTitle}
              currentMarkIndex={currentMarkIndex}
              totalMarks={marks.length}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              // Show Review shortcut only after first visit, and not during title/review overlay
              canOpenReview={
                hasVisitedReview &&
                !showReportTitle &&
                !showReview &&
                marks.length > 0
              }
              onOpenReview={openReview}
            />



            <div
              style={{
                flex: 1,
                overflow: 'auto',
                background: '#525252',
                WebkitOverflowScrolling: 'touch',
                touchAction: pdfTouchAction,
              }}
              className="pdf-surface-wrap"
              ref={containerRef}
            >
              <div
                className="pdf-surface"
                style={{ position: 'relative', height: totalHeightRef.current }}
              >
                {pagesToRender.map((pageNum) => {
                  const top = prefixHeightsRef.current[pageNum - 1] || 0;
                  return (
                    <div
                      key={pageNum}
                      style={{ position: 'absolute', top, left: 0 }}
                      ref={(el) => {
                        pageElsRef.current[pageNum - 1] = el;
                      }}
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
                        // all mark boxes of current group in slide mode
                        groupRects={getCurrentGroupRectsForPage(pageNum)}
                        // blue group border in slide mode
                        groupOutlineRect={getCurrentGroupOutlineForPage(pageNum)}
                        showMarks={!showReportTitle}

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
                            zIndex: 100,
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
                                border: '1px solid rgba(255, 193, 7, 0.85)',
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

        <div id="mobile-input-panel">
          {showReportTitle ? (
            <ReportTitlePanel
              value={reportTitle}
              onChange={setReportTitle}
              reportId={reportId}
              onConfirm={() => {
                if (!reportTitle.trim()) return;
                setShowReportTitle(false);
              }}
            />
          ) : (
            <InputPanel
              currentMark={currentMark}
              currentIndex={currentMarkIndex}
              totalMarks={marks.length}
              value={currentValue}
              onChange={handleEntryChange}
              onNext={nextMark}
              onPrev={prevMark}
              canNext={marks.length > 0}
              canPrev={currentMarkIndex > 0 || panelMode === 'group'}
              mode={panelMode}
              groupName={currentGroupMeta?.name}
              groupInstrumentSummary={currentGroupInstrumentSummary}
              showGroupSlide={panelMode === 'group' && isMasterMarkSet === false}
              groupSlideLabel={
                currentGroupMeta
                  ? `Slide to start "${currentGroupMeta.name}"`
                  : 'Slide to start this group'
              }
              onGroupSlideComplete={proceedFromGroupToMarks}
              // 🔴 NEW: PASS / FAIL / DOUBT wiring (mobile)
              status={currentStatus}
              onStatusChange={handleStatusChange}
            />

          )}
        </div>



        {/* 🔹 Review overlay (mobile) */}
        {showReview && (
          <ReviewScreen
            marks={marks}
            entries={entries}
            onBack={() => {
              // Just hide overlay; viewer state is preserved
              setShowReview(false);
            }}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            onJumpTo={(i) => {
              setShowReview(false);
              setTimeout(() => jumpDirectToMark(i), 120);
            }}
            statusByMarkId={statuses as Record<string, 'PASS' | 'FAIL' | 'DOUBT' | ''>}
          />
        )}

      </div>
    );
  }


  // Desktop mode

  const currentGroupMetaDesktop =
    isMasterMarkSet === false &&
      groupWindows &&
      groupWindows.length &&
      markToGroupIndex.length
      ? groupWindows[currentGroupIndex] ?? null
      : null;

  const currentGroupInstrumentSummaryDesktop =
    currentGroupMetaDesktop && marks.length
      ? (() => {
        const instruments = new Set<string>();
        for (
          let i = currentGroupMetaDesktop.startIndex;
          i <= currentGroupMetaDesktop.endIndex;
          i++
        ) {
          const m = marks[i] as any;
          const inst = m?.instrument?.trim();
          if (inst) instruments.add(inst);
        }
        const list = Array.from(instruments);
        return list.length ? list.join(', ') : 'No instrument mentioned';
      })()
      : '';

  const currentStatusDesktop =
    marks[currentMarkIndex]?.mark_id
      ? (statuses[marks[currentMarkIndex]!.mark_id!] as 'PASS' | 'FAIL' | 'DOUBT' | undefined) || ''
      : '';

  return (
    <div className="viewer-container">
      <Toaster position="top-center" />

      {showDraftDialog && draft && (
        <DraftResumeDialog
          updatedAt={draft.updatedAt}
          onResume={handleResumeDraft}
          onDiscard={handleDiscardDraft}
        />
      )}

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
              setSidebarOpen(false);
              setTimeout(() => selectFromList(index), 40);
            }}

          />

        </SlideSidebar>
      )}


      {/* ✅ Floating HUD (desktop) */}
      <FloatingHUD
        sidebarOpen={sidebarOpen}
        onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
        sidebarDisabled={showReportTitle}
        currentMarkIndex={currentMarkIndex}
        totalMarks={marks.length}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        // Show Review shortcut only after first visit, and not during title/review overlay
        canOpenReview={
          hasVisitedReview &&
          !showReportTitle &&
          !showReview &&
          marks.length > 0
        }
        onOpenReview={openReview}
      />



      {/* 👇 NEW: proper scroll container for desktop, same as mobile */}
      <div
        className="pdf-surface-wrap"
        ref={containerRef}
      >
        <div
          className="pdf-surface"
          style={{ position: 'relative', height: totalHeightRef.current }}
        >
          {pagesToRender.map((pageNum) => {
            const top = prefixHeightsRef.current[pageNum - 1] || 0;
            return (
              <div
                key={pageNum}
                style={{ position: 'absolute', top, left: 0 }}
                ref={(el) => {
                  pageElsRef.current[pageNum - 1] = el;
                }}
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
                  groupRects={getCurrentGroupRectsForPage(pageNum)}
                  groupOutlineRect={getCurrentGroupOutlineForPage(pageNum)}
                  showMarks={!showReportTitle}
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
        {showReportTitle ? (
          <ReportTitlePanel
            value={reportTitle}
            onChange={setReportTitle}
            reportId={reportId}
            onConfirm={() => {
              if (!reportTitle.trim()) return;
              setShowReportTitle(false);
            }}
          />
        ) : (
          <InputPanel
            currentMark={marks[currentMarkIndex] ?? null}
            currentIndex={currentMarkIndex}
            totalMarks={marks.length}
            value={
              (marks[currentMarkIndex]?.mark_id &&
                entries[marks[currentMarkIndex]!.mark_id!]) ||
              ''
            }
            onChange={handleEntryChange}
            onNext={nextMark}
            onPrev={prevMark}
            canPrev={currentMarkIndex > 0 || panelMode === 'group'}
            canNext={marks.length > 0}
            mode={panelMode}
            groupName={currentGroupMetaDesktop?.name}
            groupInstrumentSummary={currentGroupInstrumentSummaryDesktop}
            showGroupSlide={panelMode === 'group' && isMasterMarkSet === false}
            groupSlideLabel={
              currentGroupMetaDesktop
                ? `Slide to start "${currentGroupMetaDesktop.name}"`
                : 'Slide to start this group'
            }
            onGroupSlideComplete={proceedFromGroupToMarks}
            // 🔴 NEW: PASS / FAIL / DOUBT wiring (desktop)
            status={currentStatusDesktop}
            onStatusChange={handleStatusChange}
          />

        )}
      </div>


      {/* PDFSearch should stay inside main-content, after the viewer area */}
      <PDFSearch
        pdf={pdf}
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
        onResultFound={handleSearchResult}
      />
      {/* 🔹 Review overlay (desktop) */}
      {showReview && (
        <ReviewScreen
          marks={marks}
          entries={entries}
          onBack={() => {
            setShowReview(false);
          }}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          onJumpTo={(i) => {
            setShowReview(false);
            setTimeout(() => jumpDirectToMark(i), 120);
          }}
          statusByMarkId={statuses as Record<string, 'PASS' | 'FAIL' | 'DOUBT' | ''>}
        />
      )}

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