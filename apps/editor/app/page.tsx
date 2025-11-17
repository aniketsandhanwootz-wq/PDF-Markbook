'use client';

import React, { useEffect, useState, useRef, useCallback, Suspense } from 'react';
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
import GroupEditor from '../components/GroupEditor';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
// Clean nested Cloudinary URLs
// Clean nested Cloudinary URLs - DEBUG VERSION
// Clean nested Cloudinary / Glide URLs into a real GCS PDF URL
function cleanPdfUrl(url: string): string {
  console.log('🔍 [cleanPdfUrl] INPUT:', url);

  if (!url) {
    console.log('❌ [cleanPdfUrl] Empty URL');
    return url;
  }

  let decoded = url;
  try {
    // Peel multiple layers of % encoding, but stop if nothing changes
    for (let i = 0; i < 5; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      console.log(`🔄 [cleanPdfUrl] decode #${i + 1}:`, decoded.slice(0, 140) + '...');
    }
  } catch (e) {
    console.warn('⚠️ [cleanPdfUrl] decode failed, using original');
    decoded = url;
  }

  // Look for the first occurrence of a storage.googleapis.com PDF
  const lower = decoded.toLowerCase();
  const needle = 'https://storage.googleapis.com/';
  const idx = lower.indexOf(needle);
  if (idx !== -1) {
    // Take chars from that index until a whitespace or delimiter
    const tail = decoded.slice(idx);
    const end = tail.search(/[\s"'<>)]/);
    const raw = (end === -1 ? tail : tail.slice(0, end)).trim();

    const cleaned = raw.replace(/ /g, '%20');
    console.log('✅ [cleanPdfUrl] OUTPUT:', cleaned);
    return cleaned;
  }

  console.log('⚠️ [cleanPdfUrl] No GCS PDF found, returning original');
  return url;
}


type Mark = {
  mark_id: string;         // ✅ always required - matches GroupEditor / MarkList types
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  zoom_hint?: number | null;
  label?: string;          // A, B, C...
  instrument?: string;     // Vernier, Micrometer, etc.
  is_required?: boolean;   // true = mandatory, false = optional
};

type Group = {
  group_id: string;
  name: string;
  page_index: number;   // 0-based
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  mark_ids: string[];
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
    description?: string;   // ✅ NEW
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
  description?: string | null;   // ✅ NEW
};


// ------- NEW Setup Screen (doc bootstrap + markset picker) -------
function SetupScreen({ onStart }: { onStart: (pdfUrl: string, markSetId: string, isMaster: boolean) => void }) {
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

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  // New markset modal-ish fields
  const [newLabel, setNewLabel] = useState('');
  const [newDescription, setNewDescription] = useState('');  // ✅ NEW
  const [creating, setCreating] = useState(false);


  // one-time notice after Save & Submit
  const [notice, setNotice] = useState<string>('');
  useEffect(() => {
    try {
      const msg = localStorage.getItem('markset_notice');
      if (msg) {
        setNotice(msg);
        localStorage.removeItem('markset_notice');
      }
    } catch { }
  }, []);

  const runBootstrap = async () => {
    setErr('');
    if (!projectName || !extId || !partNumber) {
      setErr('Please fill Project, ID and Part Number.');
      return;
    }
    // we can allow either pdf_url or assembly_drawing; the backend cleans it
    if (!assemblyDrawing) {
      setErr('Please paste the PDF/assembly_drawing URL (Cloudinary/Glide link is okay).');
      return;
    }
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

  const handleOpenMarkset = (markSetId: string, isMaster: boolean) => {
    if (!boot?.document?.pdf_url) {
      setErr('No PDF URL on document.');
      return;
    }

    // ✅ For master sets: master_for_viewer = itself
    // ✅ For QC sets: MUST point to the real master mark-set
    if (!isMaster && !boot.master_mark_set_id) {
      setErr('No master mark-set for this document. Please open or create the MASTER first.');
      return;
    }

    const masterForViewer = isMaster
      ? markSetId
      : (boot.master_mark_set_id as string);

    const finalPdfUrl = boot.document.pdf_url;

    const params = new URLSearchParams();
    params.set('pdf_url', finalPdfUrl);
    params.set('mark_set_id', markSetId);
    params.set('is_master', isMaster ? '1' : '0');
    params.set('master_mark_set_id', masterForViewer);
        if (userMail) {
      params.set('user_mail', userMail);
      // cache it so the viewer can still use it even if URL loses the param
      try {
        localStorage.setItem('markbook_user_mail', userMail);
      } catch {
        // ignore storage errors
      }
    }

    // Hard redirect so Viewer boots with correct params
    window.location.href = `${window.location.pathname}?${params.toString()}`;
  };


  const handleCreateMarkset = async () => {
    if (!boot?.document?.doc_id) {
      setErr('Document not initialized yet.');
      return;
    }
    if (!newLabel.trim()) {
      setErr('Enter a label for the new mark set.');
      return;
    }
    try {
      setCreating(true);
      const body: CreateDocMarkSetBody = {
        project_name: projectName,
        id: extId,
        part_number: partNumber,
        label: newLabel.trim(),
        created_by: userMail || undefined,
        is_master: false,
        description: newDescription.trim() || undefined,  // ✅ send description
      };
      const res = await fetch(`${apiBase}/documents/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      // Immediately open it in the editor (always non-master; only one master exists)
      handleOpenMarkset(out.mark_set_id, false);
    } catch (e: any) {
      console.error(e);
      setErr('Failed to create mark set.');
    } finally {
      setCreating(false);
    }
  };


  const handleDuplicateMarkset = async (srcId: string, srcLabel: string) => {
    try {
      const tempLabel = `${srcLabel} (copy)`;
      const res = await fetch(`${apiBase}/mark-sets/${srcId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_label: tempLabel,
          created_by: userMail || 'system',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json(); // { mark_set_id, label? }

      // ⬇️ Inject new mark set locally (no re-bootstrap)
      setBoot(prev => {
        if (!prev) return prev;
        const newMs = {
          mark_set_id: out.mark_set_id,
          label: tempLabel,
          is_master: false,
          is_active: false,
          created_by: userMail || '',
          created_at: new Date().toISOString(),
          updated_by: userMail || '',
          marks_count: 0, // safe default; true count appears on next real refresh
        };
        return { ...prev, mark_sets: [newMs, ...prev.mark_sets] };
      });

      // Inline rename the freshly added copy
      setEditingId(out.mark_set_id);
      setEditingName(tempLabel);
    } catch (e) {
      console.error(e);
      setErr('Failed to duplicate mark set.');
    }
  };


  const handleRenameMarkset = async (markSetId: string, currentLabel: string) => {
    setEditingId(markSetId);
    setEditingName(currentLabel);
  };

  const saveInlineRename = async () => {
    if (!editingId) return;
    const newLabel = editingName.trim();
    if (!newLabel) return;

    try {
      const res = await fetch(`${apiBase}/mark-sets/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newLabel,
          updated_by: userMail || 'system',
        }),
      });
      if (!res.ok) throw new Error(await res.text());

      await runBootstrap();
      setEditingId(null);
      setEditingName('');
     } catch (e) {
      console.error(e);
      setErr('Failed to rename mark set.');
    }
  };

  // ----- helper to render a single mark-set card -----
  const renderMarkSetCard = (ms: BootstrapDoc['mark_sets'][number]) => {
    // MASTER cannot be renamed, so we never go into "editing" state for it
    const isEditing = !ms.is_master && editingId === ms.mark_set_id;
    const effectiveLabel = ms.is_master ? 'MASTER' : ms.label;

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
          gap: 8,
        }}
      >
        <div>
          {isEditing ? (
            // 🔁 Inline rename only for NON-MASTER mark sets
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={editingName}
                onChange={e => setEditingName(e.target.value)}
                style={{ ...inp, padding: '6px 8px', fontSize: 13 }}
                autoFocus
              />
              <button style={btn} onClick={saveInlineRename}>
                Save
              </button>
              <button
                style={btn}
                onClick={() => {
                  setEditingId(null);
                  setEditingName('');
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ fontWeight: 600 }}>
              {effectiveLabel}
              {ms.is_master ? ' ⭐' : ''}
            </div>
          )}

          <div style={{ color: '#666', fontSize: 12 }}>
            {(ms.marks_count ?? 0)} mark{(ms.marks_count ?? 0) === 1 ? '' : 's'}
          </div>

          {ms.created_by && (
            <div style={{ color: '#777', fontSize: 11, marginTop: 2 }}>
              {ms.created_by}
            </div>
          )}

          {ms.description && (
            <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>
              {ms.description}
            </div>
          )}
        </div>

        {!isEditing && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => handleOpenMarkset(ms.mark_set_id, ms.is_master)}
              style={btn}
            >
              Open
            </button>

            {/* Duplicate + Rename only for QC / non-master mark sets */}
            {!ms.is_master && (
              <>
                <button
                  onClick={() => handleDuplicateMarkset(ms.mark_set_id, ms.label)}
                  style={btn}
                >
                  Duplicate
                </button>
                <button
                  onClick={() => handleRenameMarkset(ms.mark_set_id, ms.label)}
                  style={btn}
                >
                  Rename
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };


  // split MASTER vs QC/other mark-sets
  const masterMarkSet = boot?.mark_sets.find(ms => ms.is_master) || null;
  const nonMasterMarkSets = boot?.mark_sets.filter(ms => !ms.is_master) || [];

  // 🔁 Auto-bootstrap on first load if URL already has keys + assembly_drawing
  useEffect(() => {

    const hasKeys = projectName && extId && partNumber;
    const hasUrl = !!assemblyDrawing; // backend will clean it
    if (!boot && !loading && hasKeys && hasUrl) {
      runBootstrap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, extId, partNumber, assemblyDrawing]);

  // UI
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', width: '100%', maxWidth: 860, borderRadius: 8, boxShadow: '0 2px 12px rgba(0,0,0,0.1)', padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>PDF Mark Editor — Map Creation</h1>
        <p style={{ color: '#666', marginBottom: 18 }}>Enter keys → Bootstrap the document → Pick or create a mark set.</p>
        {notice && (
          <div
            style={{
              background: '#e8f5e9',
              color: '#2e7d32',
              padding: 10,
              borderRadius: 6,
              margin: '8px 0 12px',
              border: '1px solid #c8e6c9'
            }}
          >
            {notice}
          </div>
        )}

        {/* Keys + URL + errors are ONLY visible before bootstrap */}
        {!boot && (
          <>
            {/* Keys row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <input placeholder="Project Name" value={projectName} onChange={e => setProjectName(e.target.value)} style={inp} />
              <input placeholder="ID (Business ID)" value={extId} onChange={e => setExtId(e.target.value)} style={inp} />
              <input placeholder="Part Number" value={partNumber} onChange={e => setPartNumber(e.target.value)} style={inp} />
              <input placeholder="Your Email (optional)" value={userMail} onChange={e => setUserMail(e.target.value)} style={inp} />
            </div>

            <input
              placeholder="assembly_drawing / PDF URL (Cloudinary/Glide fine)"
              value={assemblyDrawing}
              onChange={e => setAssemblyDrawing(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 12 }}
            />

            {err && <div style={{ background: '#ffebee', color: '#c62828', padding: 10, borderRadius: 4, marginBottom: 12 }}>{err}</div>}
          </>
        )}

        {!boot ? (
          <button onClick={runBootstrap} disabled={loading} style={btnPrimary}>
            {loading ? 'Bootstrapping…' : 'Bootstrap Document'}
          </button>
        ) : (
          <>

            {/* Markset picker */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Available Mark Sets</div>

              {/* MASTER pinned at top (not in scroll) */}
              {masterMarkSet && (
                <div style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#555',
                      marginBottom: 4,
                      textTransform: 'uppercase',
                    }}
                  >
                    MASTER mark set
                  </div>
                  {renderMarkSetCard(masterMarkSet)}
                </div>
              )}

              {/* QC / other mark-sets in scrollable list */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#555',
                    margin: '4px 0 6px',
                    textTransform: 'uppercase',
                  }}
                >
                  QC / other mark sets
                </div>

                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    maxHeight: 280, // rest of the list scrolls
                    overflow: 'auto',
                    paddingRight: 4,
                  }}
                >
                  {nonMasterMarkSets.map(ms => renderMarkSetCard(ms))}

                  {nonMasterMarkSets.length === 0 && (
                    <div style={{ color: '#666', fontSize: 13, padding: '6px 2px' }}>
                      No QC mark sets yet.
                    </div>
                  )}
                </div>
              </div>
            </div>


            {/* Create new markset */}
            <div style={{ marginTop: 16, borderTop: '1px dashed #ddd', paddingTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Create New Mark Set</div>
              <div style={{ marginBottom:8 }}>
  <input
    placeholder="Label (e.g., QC – Dimensions)"
    value={newLabel}
    onChange={e => setNewLabel(e.target.value)}
    style={inp}
  />
</div>


              {/* ✅ NEW: Description field */}
              <textarea
                placeholder="Description (optional) – e.g., 'QC for first article inspection, batch #123'"
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                style={{ ...inp, width: '100%', minHeight: 60, resize: 'vertical', fontSize: 13, marginBottom: 4 }}
              />

              <button
                onClick={handleCreateMarkset}
                disabled={creating}
                style={{ ...btnPrimary, marginTop: 10 }}
              >
                {creating ? 'Creating…' : 'Create & Open'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// small styles for setup
const inp: React.CSSProperties = { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, outline: 'none' };
const btn: React.CSSProperties = { padding: '8px 14px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { ...btn, borderColor: '#1976d2', color: '#1976d2', fontWeight: 700 };


// Main Editor Component
function EditorContent() {
  const searchParams = useSearchParams();  
  const router = useRouter();
  const [showSetup, setShowSetup] = useState(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);


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

  // ✅ NEW: group creation mode + pending group rect
  const [drawMode, setDrawMode] = useState<'mark' | 'group'>('mark');
  const [pendingGroup, setPendingGroup] = useState<{
    pageIndex: number;
    rect: { nx: number; ny: number; nw: number; nh: number };
  } | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [pendingGroupMarkIds, setPendingGroupMarkIds] = useState<string[]>([]);

  // Mark editing states
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'move' | 'resize' | null>(null);
  const [editStart, setEditStart] = useState<{ x: number; y: number; rect: Rect } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightsRef = useRef<number[]>([]);
  const pdfUrl = useRef<string>('');
  const markSetId = useRef<string>('');
  const ownerMarkSetId = useRef<string>('');
  const marksSourceMarkSetId = useRef<string>('');
  const originalMarksRef = useRef<Mark[]>([]); // ✅ snapshot of universal marks at load time

  const isDemo = searchParams?.get('demo') === '1';
  const pdfUrlParam = searchParams?.get('pdf_url') || '';
  const urlMarkSetId = searchParams?.get('mark_set_id') || '';
  const isMasterMarkSet = searchParams?.get('is_master') === '1';
  const masterMarkSetIdFromUrl = searchParams?.get('master_mark_set_id') || '';
  // Prefer URL param; fall back to cached value if param is missing
  let userMail = searchParams?.get('user_mail') || '';
  if (!userMail && typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('markbook_user_mail');
      if (cached) {
        userMail = cached;
      }
    } catch {
      // ignore storage errors
    }
  }
  console.log('[Viewer] userMail used for saving:', userMail);


  // Check if we should show setup screen
  useEffect(() => {
    if (isDemo || (pdfUrlParam && urlMarkSetId)) {
      setShowSetup(false);
    }
  }, [isDemo, pdfUrlParam, urlMarkSetId]);

  const handleSetupComplete = (url: string, setId: string, isMaster: boolean) => {
    // Clean URL one more time before adding to query params
    const finalUrl = cleanPdfUrl(url);
    const newUrl = `${window.location.pathname}?pdf_url=${encodeURIComponent(finalUrl)}&mark_set_id=${setId}&is_master=${isMaster ? '1' : '0'}`;
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

  const fetchGroups = useCallback(async () => {
    // Groups always belong to the *owner* mark-set (master in QC mode)
    const ownerId = ownerMarkSetId.current;
    if (!ownerId) return;

    const apiBase =
      process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

    try {
      const res = await fetch(`${apiBase}/mark-sets/${ownerId}/groups`);
      if (res.status === 404) {
        setGroups([]);
        return;
      }
      if (!res.ok) {
        console.warn('Failed to load groups', await res.text());
        return;
      }
      const data: Group[] = await res.json();
      setGroups(data || []);
    } catch (e) {
      console.warn('Failed to load groups', e);
    }
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
      const targetPdfUrl = cleanPdfUrl(pdfUrlParam);
      const apiBase =
        process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
      const proxiedUrl = `${apiBase}/proxy-pdf?url=${encodeURIComponent(
        targetPdfUrl
      )}`;
      pdfUrl.current = proxiedUrl;

      // This mark-set is the one we are "inside" (master or QC)
      markSetId.current = urlMarkSetId;

      // ✅ Marks always come from:
      //   • Master mark set for this document (for QC)
      //   • If we're on the master itself, that's just urlMarkSetId
      marksSourceMarkSetId.current = isMasterMarkSet
        ? urlMarkSetId
        : masterMarkSetIdFromUrl; // ⚠️ no fallback to QC id

      // ✅ Groups are always stored on the *QC* mark-set itself.
      // We do NOT create groups on the master.
      ownerMarkSetId.current = urlMarkSetId;


      setLoading(true);


      pdfjsLib
        .getDocument({ url: proxiedUrl })
        .promise
        .then(async (loadedPdf) => {
          setPdf(loadedPdf);
          setNumPages(loadedPdf.numPages);

          // No mark-set ID → just load PDF, no marks
          if (!urlMarkSetId) {
            setMarks([]);
            setLoading(false);
            return;
          }

          try {
            // ✅ Master editor → marks from itself
            // ✅ QC editor → marks from master_mark_set_id
            const sourceId = marksSourceMarkSetId.current || urlMarkSetId;
            const res = await fetch(`${apiBase}/mark-sets/${sourceId}/marks`);

            // 404 = "no marks yet" → empty list
            if (res.status === 404) {
              setMarks([]);
              originalMarksRef.current = [];
            } else if (!res.ok) {
              throw new Error(`marks fetch failed: ${res.status}`);
            } else {
              const data: any = await res.json();
              const sorted = [...data].sort(
                (a: Mark, b: Mark) => a.order_index - b.order_index
              );
              const normalized = normalizeMarks(sorted);
              setMarks(normalized);

              // ✅ For QC view: remember original universal marks to forbid deletion later
              if (!isMasterMarkSet) {
                originalMarksRef.current = normalized;
              } else {
                originalMarksRef.current = [];
              }
            }
          } catch (err) {
            console.warn('Marks fetch failed, using empty list', err);
            setMarks([]);
            originalMarksRef.current = [];
          } finally {
            setLoading(false);
            if (!isMasterMarkSet) {
              fetchGroups();   // 🔹 load groups only for QC/non-master marksets
            }
          }
        })
        .catch((err) => {
          console.error('PDF load error:', err);
          setError('Failed to load PDF');
          setLoading(false);
        });
    }
  }, [showSetup, isDemo, pdfUrlParam, urlMarkSetId, fetchGroups, isMasterMarkSet]);

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


  const navigateToMark = useCallback(
    (mark: any) => {
      const container = containerRef.current;
      if (!container) return;

      const m = mark as Mark;

      setSelectedMarkId(m.mark_id);

      // In QC mode, also highlight the group that owns this mark
      if (!isMasterMarkSet) {
        const owningGroup = groups.find((g) =>
          (g.mark_ids || []).includes(m.mark_id)
        );
        setSelectedGroupId(owningGroup ? owningGroup.group_id : null);
      } else {
        setSelectedGroupId(null);
      }

      // compute where that page starts
      const targetTop = pageTopFor(m.page_index);
      const curTop = container.scrollTop;
      const pageH = pageHeightsRef.current[m.page_index] || 0;

      // robust "same page" check that does NOT rely on currentPage state
      const samePage =
        curTop > targetTop - pageH / 2 && curTop < targetTop + pageH / 2;

      if (!samePage) {
        container.scrollTo({ left: 0, top: targetTop, behavior: 'smooth' });
        setCurrentPage(m.page_index + 1); // sync toolbar right away
      }
    },
    [pageTopFor, groups, isMasterMarkSet]
  );


  const navigateToGroup = useCallback((group: Group) => {
    const container = containerRef.current;
    if (!container) return;

    setSelectedGroupId(group.group_id);
    setSelectedMarkId(null); // 🔹 no specific mark selected

    // scroll to group's page (no zoom change)
    const top = pageTopFor(group.page_index);
    container.scrollTo({ left: 0, top, behavior: 'smooth' });

    // briefly highlight group rectangle on that page
    if (pdf) {
      pdf.getPage(group.page_index + 1)
        .then((page) => {
          const vp = page.getViewport({ scale: zoom });
          setFlashRect({
            pageNumber: group.page_index + 1,
            x: group.nx * vp.width,
            y: group.ny * vp.height,
            w: group.nw * vp.width,
            h: group.nh * vp.height,
          });
        })
        .catch((e) => console.warn('Failed to compute group flash rect', e));
    }
  }, [pdf, zoom, pageTopFor]);

  // Open GroupEditor for an existing group (pencil icon)
  const handleEditGroup = useCallback(
    (group: Group) => {
      setSelectedGroupId(group.group_id);
      setSelectedMarkId(null);
      setEditingGroup(group);

      setPendingGroup({
        pageIndex: group.page_index,
        rect: {
          nx: group.nx,
          ny: group.ny,
          nw: group.nw,
          nh: group.nh,
        },
      });
      setGroupEditorOpen(true);

      // Also scroll / flash this group on the PDF
      navigateToGroup(group);
    },
    [navigateToGroup]
  );


  const saveMarks = useCallback(async () => {
    if (isDemo) {
      addToast('Demo mode - changes not saved', 'info');
      return;
    }

    if (marks.length === 0) {
      addToast('No marks to save', 'info');
      return;
    }

    const apiBase =
      process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

    // ✅ Master: save into itself
    // ✅ QC: save into MASTER (universal pool)
    const targetId = isMasterMarkSet
      ? markSetId.current
      : marksSourceMarkSetId.current; // ⚠️ never fall back to QC

    if (!targetId) {
      addToast('No master mark-set id found to save into. Please reopen this document from the setup screen.', 'error');
      return;
    }


    addToast('Saving...', 'info');

    try {
      const url = `${apiBase}/mark-sets/${targetId}/marks${userMail ? `?user_mail=${encodeURIComponent(userMail)}` : ''
        }`;

      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applyLabels(marks)),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error('Save error:', res.status, text);
        if (res.status === 403) {
          addToast(
            'You are not allowed to update master marks for this document. Ask an owner to add your email in master_editors.',
            'error'
          );
        } else {
          addToast('Failed to save marks', 'error');
        }
        return;
      }

      addToast('Saved successfully', 'success');

      // ✅ After a QC save, everything in `marks` is now part of the universal pool
      if (!isMasterMarkSet) {
        originalMarksRef.current = normalizeMarks(marks);
      }
    } catch (err) {
      console.error('Save error:', err);
      addToast('Failed to save marks', 'error');
    }
  }, [marks, isDemo, addToast, isMasterMarkSet, userMail]);

  // Save marks + close window (old "Save & Submit" behaviour)
  const saveAndSubmit = useCallback(async () => {
    await saveMarks();

    // If save failed, we already showed a toast, just don't close
    try {
      localStorage.setItem('markset_notice', '✅ Mark set created.');
    } catch {
      // ignore storage errors
    }
    window.history.back();
  }, [saveMarks]);

  // ✅ NEW: Check for duplicate names and overlapping areas (client-side only - NO API calls)
  // Allow duplicate names; only warn (optionally) on heavy overlap
  const checkDuplicates = useCallback(
    (name: string, pageIndex: number, nx: number, ny: number, nw: number, nh: number): string | null => {
      // ✅ No duplicate-name check anymore

      // (Optional) keep overlap warning; return null if you want zero popups ever
      const marksOnSamePage = marks.filter(m => m.page_index === pageIndex);

      for (const existing of marksOnSamePage) {
        const x1 = Math.max(nx, existing.nx);
        const y1 = Math.max(ny, existing.ny);
        const x2 = Math.min(nx + nw, existing.nx + existing.nw);
        const y2 = Math.min(ny + nh, existing.ny + existing.nh);
        if (x1 < x2 && y1 < y2) {
          const overlapArea = (x2 - x1) * (y2 - y1);
          const overlapPct = (overlapArea / Math.min(nw * nh, existing.nw * existing.nh)) * 100;
          if (overlapPct > 30) {
            return `⚠️ This mark overlaps ${Math.round(overlapPct)}% with "${existing.name}". Continue anyway?`;
          }
        }
      }
      return null; // no warning -> no confirm
    },
    [marks]
  );
  // If you want no popups at all (even for overlap) const checkDuplicates = useCallback(() => null, []);
  const createMarkFromGroup = useCallback(
    (pageIndex: number, rect: { nx: number; ny: number; nw: number; nh: number }) => {
      const newMark: Mark = {
        mark_id: `group-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        page_index: pageIndex,
        order_index: marks.length,
        name: '',
        nx: rect.nx,
        ny: rect.ny,
        nw: rect.nw,
        nh: rect.nh,
        zoom_hint: null,
        instrument: '',
        is_required: true,
      };

      setMarks((prev) => [...prev, newMark]);

      // remember: this mark was created inside the current GroupEditor session
      setPendingGroupMarkIds((prev) => [...prev, newMark.mark_id]);

      addToast(
        'Mark created in group. Set instrument in the right-hand list.',
        'success'
      );

      // let GroupEditor auto-select just this mark
      return newMark.mark_id;
    },
    [marks.length, addToast]
  );


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
      instrument: '',           // user will set this in MarkList
      is_required: true,        // default: required
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
  // Update an existing mark by ID
  const updateMark = useCallback((markId: string, updates: Partial<Mark>) => {
    setMarks((prev) =>
      prev.map((m) => (m.mark_id === markId ? { ...m, ...updates } : m))
    );
    addToast('Mark updated', 'success');
  }, [addToast]);
  // Delete a mark by ID
  const deleteMark = useCallback(
    (markId: string) => {
      // ❌ In QC (non-master) view, do NOT allow deleting marks
      // that were present when the doc was first loaded.
      if (!isMasterMarkSet) {
        const wasOriginal = originalMarksRef.current.some(
          (m) => m.mark_id === markId
        );
        if (wasOriginal) {
          addToast(
            'Cannot delete an existing universal mark from the QC view. You can only delete marks you created in this session.',
            'info'
          );
          return;
        }
      }

      setMarks((prev) =>
        normalizeMarks(prev.filter((m) => m.mark_id !== markId))
      );
      addToast('Mark deleted', 'success');
    },
    [addToast, isMasterMarkSet]
  );


  // Duplicate an existing mark
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

  const reorderMark = useCallback(
    (markId: string, dir: 'up' | 'down') => {
      setMarks((prev) => {
        // Work on a copy
        const sorted = [...prev].sort((a, b) => a.order_index - b.order_index);
        const idx = sorted.findIndex((m) => m.mark_id === markId);
        if (idx === -1) return prev;

        const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= sorted.length) return prev;

        // Swap only order_index; KEEP label as-is
        const current = sorted[idx];
        const target = sorted[swapIdx];

        const tmpOrder = current.order_index;
        current.order_index = target.order_index;
        target.order_index = tmpOrder;

        return [...sorted];
      });
    },
    []
  );

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
  // Finalize PDF with marks and trigger download
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

  // Mouse event handlers for drawing and editing marks
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      if (!pdf) return;

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // 👉 Non-master = hamesha GROUP mode
      // 👉 Master = normal drawMode ('mark' ya 'group')
      const effectiveMode = isMasterMarkSet ? drawMode : 'group';

      // ✅ GROUP MODE (all non-masters + master jab group mode ho)
      if (effectiveMode === 'group') {
        setIsDrawing(true);
        setDrawStart({ x, y, pageIndex });
        setCurrentRect(null);
        return;
      }

      // ⬇️ Yahan se sirf MASTER mark-set ka MARK drawing/editing
      if (showNameBox) return;

      // Check if clicking on existing mark overlay (edit / move / resize)
      const clickedOverlay = markOverlays.find((overlay) => {
        if (overlay.pageIndex !== pageIndex) return false;
        const { left, top, width, height } = overlay.style;
        return x >= left && x <= left + width && y >= top && y <= top + height;
      });

      if (clickedOverlay) {
        const mark = marks.find((m) => m.mark_id === clickedOverlay.markId);
        if (mark) {
          setEditingMarkId(clickedOverlay.markId);
          const { left, top, width, height } = clickedOverlay.style;

          const isNearEdge =
            x < left + 10 ||
            x > left + width - 10 ||
            y < top + 10 ||
            y > top + height - 10;

          setEditMode(isNearEdge ? 'resize' : 'move');
          setEditStart({
            x,
            y,
            rect: { x: left, y: top, w: width, h: height },
          });
          e.stopPropagation();
          return;
        }
      }

      // Normal MARK drawing (MASTER only)
      setIsDrawing(true);
      setDrawStart({ x, y, pageIndex });
      setCurrentRect(null);
    },
    [pdf, drawMode, showNameBox, markOverlays, marks, isMasterMarkSet]
  );


  // Mouse move handler
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

  // Mouse up handler
  const handleMouseUp = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      // 1) Finish editing (move / resize)
      if (editingMarkId && editMode) {
        const overlay = markOverlays.find((o) => o.markId === editingMarkId);
        if (overlay) {
          const target = e.currentTarget as HTMLElement;
          const pageWidth = target.clientWidth;
          const pageHeight = target.clientHeight;

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

      // 2) No drawing? clean up and exit
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

      const nx = currentRect.x / pageWidth;
      const ny = currentRect.y / pageHeight;
      const nw = currentRect.w / pageWidth;
      const nh = currentRect.h / pageHeight;

      // Same effective mode logic as mousedown
      const effectiveMode = isMasterMarkSet ? drawMode : 'group';

      // 3) GROUP MODE ⇒ GroupEditor kholna (master + non-master dono)
      if (effectiveMode === 'group') {
        setPendingGroup({
          pageIndex,
          rect: { nx, ny, nw, nh },
        });
        setGroupEditorOpen(true);
        setIsDrawing(false);
        setCurrentRect(null);
        return;
      }

      // 4) Agar yahan tak aaye, to MARK MODE hai ⇒ sirf MASTER pe allowed
      if (!isMasterMarkSet) {
        // safety: non-master pe kabhi mark create mat karo
        setIsDrawing(false);
        setCurrentRect(null);
        return;
      }

      // MARK MODE (FLOATING NAME BOX) – MASTER ONLY
      const normalizedMark: Partial<Mark> = {
        page_index: pageIndex,
        nx,
        ny,
        nw,
        nh,
      };

      setPendingMark(normalizedMark);

      const container = containerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const absoluteX =
          targetRect.left - containerRect.left + container.scrollLeft + currentRect.x;
        const absoluteY =
          targetRect.top - containerRect.top + container.scrollTop + currentRect.y;

        setNameBoxPosition({ x: absoluteX, y: absoluteY });
      }

      setShowNameBox(true);
      setIsDrawing(false);
    },
    [
      isDrawing,
      drawStart,
      currentRect,
      editingMarkId,
      editMode,
      markOverlays,
      updateMark,
      drawMode,
      isMasterMarkSet,
    ]
  );


  // Track page heights as they load
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
            groups={isMasterMarkSet ? [] : groups}
            selectedMarkId={selectedMarkId}
            selectedGroupId={isMasterMarkSet ? null : selectedGroupId}
            onSelect={navigateToMark}
            onGroupSelect={isMasterMarkSet ? undefined : navigateToGroup}
            onGroupEdit={isMasterMarkSet ? undefined : handleEditGroup}
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
              onClick={saveAndSubmit}
              disabled={marks.length === 0}
            >
              Save &amp; Submit ({marks.length})
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
          // ✅ NEW: enter group mode (disabled on master markset)
          onCreateGroup={() => {
            if (isMasterMarkSet) {
              addToast(
                'Groups are only available on QC (non-master) mark sets.',
                'info'
              );
              return;
            }
            setDrawMode('group');
            setPendingGroup(null);
            setCurrentRect(null);
            addToast(
              'Group mode: draw a rectangle on the PDF to define a group area.',
              'info'
            );
          }}
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
                  .filter((overlay) => {
                    // In QC mode, if a group is selected, only show that group's marks
                    if (isMasterMarkSet || !selectedGroupId) return true;
                    const g = groups.find(
                      (gg) => gg.group_id === selectedGroupId
                    );
                    if (!g) return true;
                    return (g.mark_ids || []).includes(overlay.markId);
                  })
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

        {/* ✅ Group Editor overlay (QC/non-master only) */}
        {pendingGroup && !isMasterMarkSet && (
          <GroupEditor
            isOpen={groupEditorOpen}
            pdf={pdf}
            pageIndex={pendingGroup.pageIndex}
            rect={pendingGroup.rect}
            mode={editingGroup ? 'edit' : 'create'}
            groupId={editingGroup?.group_id || undefined}
            initialName={editingGroup?.name}
            initialSelectedMarkIds={editingGroup?.mark_ids}
            // ✅ marks come from the master mark set (loaded earlier)
            marksOnPage={marks.filter(
              (m) => m.page_index === pendingGroup.pageIndex
            )}
            // ✅ groups belong to this QC mark-set
            ownerMarkSetId={ownerMarkSetId.current}
            onUpdateMark={updateMark}
            onFocusMark={(markId) => {
              const m = marks.find((mm) => mm.mark_id === markId);
              if (m) navigateToMark(m);
            }}
            // ✅ QC can create new marks inside this group area
            onCreateMarkInGroup={createMarkFromGroup}
            onClose={() => {
              // ❌ User cancelled – drop any marks that were created
              // inside this GroupEditor session and never saved.
              if (pendingGroupMarkIds.length) {
                setMarks((prev) =>
                  prev.filter((m) => !pendingGroupMarkIds.includes(m.mark_id))
                );
                setPendingGroupMarkIds([]);
              }
              setGroupEditorOpen(false);
              setPendingGroup(null);
              setEditingGroup(null);
              setDrawMode('mark');
            }}
            onSaved={() => {
              // ✅ User clicked "Save Group" – marks created in this session
              // become part of the normal mark pool; just clear the tracking list.
              setGroupEditorOpen(false);
              setPendingGroup(null);
              setEditingGroup(null);
              setDrawMode('mark');
              setPendingGroupMarkIds([]);
              addToast('Group saved', 'success');
              // 🔹 refresh sidebar groups for this QC mark-set
              fetchGroups();
            }}
          />
        )}

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