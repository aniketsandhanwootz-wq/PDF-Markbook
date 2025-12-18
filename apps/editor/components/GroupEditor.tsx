'use client';

import React, {
    useEffect,
    useMemo,
    useRef,
    useState,
    useCallback,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { runRequiredValueOCR } from '../lib/pagesApi'; // 👈 NEW

// Simple in-memory cache for instrument suggestions so we only hit
// /instruments/suggestions once per browser session.
let globalInstrumentCache: string[] | null = null;

// --- fuzzy / subsequence match helpers for instrument search ---

function isSubsequence(query: string, target: string): boolean {
    let i = 0;
    let j = 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    while (i < q.length && j < t.length) {
        if (q[i] === t[j]) {
            i++;
        }
        j++;
    }
    return i === q.length;
}

function scoreInstrument(query: string, candidate: string): number {
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();
    if (!q) return 0;

    const idx = c.indexOf(q);
    if (idx !== -1) {
        // direct substring match, earlier index is better
        return idx;
    }
    if (isSubsequence(q, c)) {
        // subsequence match but not contiguous; push slightly later
        return 100 + c.length;
    }
    return Number.POSITIVE_INFINITY; // no match
}

type Mark = {
    mark_id: string;
    label?: string;
    instrument?: string;
    is_required?: boolean;

    // Normalized bbox (existing)
    nx: number;
    ny: number;
    nw: number;
    nh: number;

    // 🔢 OCR fields (NEW)
    required_value_ocr?: string | null;
    required_value_conf?: number | null;
    required_value_final?: string | null;
};


type GroupEditorProps = {
    isOpen: boolean;
    pdf: PDFDocumentProxy;
    pageIndex: number; // 0-based
    rect: {
        nx: number;
        ny: number;
        nw: number;
        nh: number;
    };
    marksOnPage: Mark[];
    // 👉 This is the mark-set that actually OWNS the groups (QC mark-set)
    ownerMarkSetId: string;
    // used to auto-name new groups: "Group 1", "Group 2", ...
    nextGroupNumber?: number;
    // create vs edit existing group
    mode?: 'create' | 'edit';
    groupId?: string;
    initialName?: string;
    initialSelectedMarkIds?: string[];
    originalMarkIds?: string[];
    onClose: () => void;
    onSaved: () => void;
onPersistMarks?: () => Promise<void>; // 👈 NEW: persist master marks
 
    onUpdateMark: (markId: string, updates: Partial<Mark>) => void;
    onFocusMark: (markId: string) => void;
    // Optional: create marks directly from the preview
    onCreateMarkInGroup?: (
        pageIndex: number,
        rect: { nx: number; ny: number; nw: number; nh: number }
    ) => string | void;
    // Optional: mark ids that can be deleted (newly created balloons)
    deletableMarkIds?: string[];
    // Optional: delete mark (used for newly created balloons)
    onDeleteMark?: (markId: string) => void;
};

const apiBase =
    process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

function overlaps(
    groupRect: { nx: number; ny: number; nw: number; nh: number },
    m: Mark
) {
    const gx1 = groupRect.nx;
    const gy1 = groupRect.ny;
    const gx2 = groupRect.nx + groupRect.nw;
    const gy2 = groupRect.ny + groupRect.nh;

    const mx1 = m.nx;
    const my1 = m.ny;
    const mx2 = m.nx + m.nw;
    const my2 = m.ny + m.nh;

    const ix1 = Math.max(gx1, mx1);
    const iy1 = Math.max(gy1, my1);
    const ix2 = Math.min(gx2, mx2);
    const iy2 = Math.min(gy2, my2);

    return ix1 < ix2 && iy1 < iy2;
}

type DrawRect = { x: number; y: number; w: number; h: number } | null;

// Simple 3×3 sharpen filter (similar to OpenCV kernel)
// kernel = [[0, -1, 0],
//           [-1, 5, -1],
//           [0, -1, 0]]
function applySharpenFilter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);

  const w = width;
  const h = height;
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  const kSize = 3;
  const half = 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        b = 0;

      for (let ky = -half; ky <= half; ky++) {
        const yy = Math.min(h - 1, Math.max(0, y + ky));
        for (let kx = -half; kx <= half; kx++) {
          const xx = Math.min(w - 1, Math.max(0, x + kx));
          const weight = kernel[(ky + half) * kSize + (kx + half)];
          const idx = (yy * w + xx) * 4;

          r += src[idx] * weight;
          g += src[idx + 1] * weight;
          b += src[idx + 2] * weight;
        }
      }

      const outIdx = (y * w + x) * 4;
      out[outIdx] = Math.min(255, Math.max(0, r));
      out[outIdx + 1] = Math.min(255, Math.max(0, g));
      out[outIdx + 2] = Math.min(255, Math.max(0, b));
      out[outIdx + 3] = src[outIdx + 3]; // keep alpha
    }
  }

  imageData.data.set(out);
  ctx.putImageData(imageData, 0, 0);
}

type InstrumentComboProps = {
    value: string;
    allInstruments: string[];
    onChange: (next: string) => void;
    onAddNewLocal: (next: string) => void;
};

function InstrumentCombo({
    value,
    allInstruments,
    onChange,
    onAddNewLocal,
}: InstrumentComboProps) {
    const [inputValue, setInputValue] = useState<string>(value || '');
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Keep local input in sync if mark.instrument changes from outside
    useEffect(() => {
        setInputValue(value || '');
    }, [value]);

    const matches = useMemo(() => {
        const q = inputValue.trim();
        if (!q) {
            // Show top instruments when empty
            return allInstruments
                .slice(0, 20)
                .map((name) => ({ name, score: 0 }));
        }
        return allInstruments
            .map((name) => ({ name, score: scoreInstrument(q, name) }))
            .filter((x) => x.score !== Number.POSITIVE_INFINITY)
            .sort((a, b) => a.score - b.score)
            .slice(0, 20);
    }, [inputValue, allInstruments]);

    const hasExact = useMemo(() => {
        const q = inputValue.trim().toLowerCase();
        if (!q) return false;
        return allInstruments.some(
            (name) => name.toLowerCase() === q,
        );
    }, [inputValue, allInstruments]);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;

        function handleClickOutside(e: MouseEvent) {
            if (!containerRef.current) return;
            if (!containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        }

        window.addEventListener('mousedown', handleClickOutside);
        return () => window.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleSelect = (name: string) => {
        setInputValue(name);
        onChange(name);
        setIsOpen(false);
    };

    const handleAddNew = () => {
        const trimmed = inputValue.trim();
        if (!trimmed) return;
        onAddNewLocal(trimmed);
        handleSelect(trimmed);
    };

    return (
        <div
            ref={containerRef}
            style={{ position: 'relative', flex: 1, minWidth: 115, maxWidth: 190 }}
        >
            <input
                type="text"
                value={inputValue}
                onFocus={() => setIsOpen(true)}
                onChange={(e) => {
                    const v = e.target.value;
                    setInputValue(v);
                    setIsOpen(true);
                    onChange(v);
                }}
                placeholder="Instrument..."
                style={{
                    border: '1px solid #ddd',
                    borderRadius: 4,
                    fontSize: 12,
                    padding: '4px 6px',
                    width: '100%',
                    boxSizing: 'border-box',
                }}
            />

            {isOpen &&
                (matches.length > 0 ||
                    (!hasExact && inputValue.trim())) && (
                    <div
                        style={{
                            position: 'absolute',
                            zIndex: 10,
                            top: '100%',
                            left: 0,
                            right: 0,
                            marginTop: 2,
                            maxHeight: 180,
                            overflowY: 'auto',
                            background: '#fff',
                            border: '1px solid #ddd',
                            borderRadius: 4,
                            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                            fontSize: 12,
                        }}
                    >
                        {matches.map((m) => (
                            <div
                                key={m.name}
                                onMouseDown={(e) => {
                                    e.preventDefault(); // don't blur input
                                    handleSelect(m.name);
                                }}
                                style={{
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    textOverflow: 'ellipsis',
                                    overflow: 'hidden',
                                }}
                            >
                                {m.name}
                            </div>
                        ))}

                        {!hasExact && inputValue.trim() && (
                            <div
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    handleAddNew();
                                }}
                                style={{
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    borderTop: matches.length
                                        ? '1px solid #eee'
                                        : 'none',
                                    fontStyle: 'italic',
                                    background: '#f5f5f5',
                                }}
                            >
                                Add “{inputValue.trim()}” Instrument
                            </div>
                        )}
                    </div>
                )}
        </div>
    );
}

export default function GroupEditor({
    isOpen,
    pdf,
    pageIndex,
    rect,
    marksOnPage,
    ownerMarkSetId,
    nextGroupNumber,
    mode = 'create',
    groupId,
    initialName,
    initialSelectedMarkIds,
    originalMarkIds,
    onClose, 
    onSaved,
    onPersistMarks,
    onUpdateMark,
    onFocusMark,
    onCreateMarkInGroup,
    deletableMarkIds,
    onDeleteMark,
}: GroupEditorProps) {


    const [saving, setSaving] = useState(false);

    // which mark is currently "highlighted" in yellow (list or preview click)
    const [highlightedMarkId, setHighlightedMarkId] = useState<string | null>(null);


    // marks that geometrically lie inside this area
    const marksInArea = useMemo(
        () => marksOnPage.filter((m) => overlaps(rect, m)),
        [marksOnPage, rect]
    );

    const [selected, setSelected] = useState<Set<string>>(new Set());
    // once user manually changes selection, stop auto-initialising it
    const userSelectionTouchedRef = useRef(false);


    const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const previewContainerRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);

    const [overlaySize, setOverlaySize] = useState<{ w: number; h: number }>({
        w: 0,
        h: 0,
    });

    // Drawing state for creating marks directly on preview
    const [isDrawing, setIsDrawing] = useState(false);
    const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(
        null
    );
    const [currentRect, setCurrentRect] = useState<DrawRect>(null);

    // All known instruments for autocomplete (fetched once then cached)
    const [allInstruments, setAllInstruments] = useState<string[]>([]);


const runOcrForMark = useCallback(
    async (
        markId: string,
        normRect: { nx: number; ny: number; nw: number; nh: number }
    ) => {
        if (!ownerMarkSetId) {
            return;
        }

        try {
            const resp = await runRequiredValueOCR(apiBase, {
                mark_set_id: ownerMarkSetId,
                page_index: pageIndex,
                nx: normRect.nx,
                ny: normRect.ny,
                nw: normRect.nw,
                nh: normRect.nh,
            });
// Always store something in state so it survives until PUT save.
// If OCR returns nothing, keep empty string and 0 confidence.
const requiredValue = (resp.required_value_ocr ?? "").toString();
const conf = Number(resp.required_value_conf ?? 0);

onUpdateMark(markId, {
    required_value_ocr: requiredValue,
    required_value_conf: conf,               // <-- keep 0, don't make it undefined
    required_value_final: requiredValue,     // <-- user can edit later
});

        } catch (e) {
            console.warn('OCR for required value failed', e);
            // If OCR fails, we simply leave it blank and user can type manually
        }
    },
    [ownerMarkSetId, pageIndex, onUpdateMark]
);

    useEffect(() => {
        if (!isOpen) return;

        setSelected((prev) => {
            const idsInArea = new Set<string>(
                marksInArea.map((m) => m.mark_id).filter(Boolean) as string[]
            );

            // After user has changed selection once, never auto-add marks again.
            // Only keep those that still exist in this area.
            if (userSelectionTouchedRef.current) {
                const next = new Set<string>();
                prev.forEach((id) => {
                    if (idsInArea.has(id)) next.add(id);
                });
                return next;
            }

// Before user interaction → initial selection
if (mode === 'edit') {
    // Edit mode:
    // 1) If backend provided initialSelectedMarkIds -> trust it
    if (initialSelectedMarkIds && initialSelectedMarkIds.length > 0) {
        return new Set(initialSelectedMarkIds.filter((id) => idsInArea.has(id)));
    }

    // 2) If not provided, do NOT auto-select everything.
    // Keep whatever selection we already had (prev), but drop ids not in this area.
    const next = new Set<string>();
    prev.forEach((id) => {
        if (idsInArea.has(id)) next.add(id);
    });
    return next;
}

// Create mode default: everything in area selected
return new Set(idsInArea);

        });
    }, [isOpen, marksInArea, initialSelectedMarkIds]);

    const toggleMarkSelected = (id: string) => {
        // user has manually changed selection at least once
        userSelectionTouchedRef.current = true;

        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const loadInstrumentSuggestions = useCallback(async () => {
        // If we already have a cached list, reuse it and avoid a network call
        if (globalInstrumentCache && globalInstrumentCache.length > 0) {
            setAllInstruments(globalInstrumentCache);
            return;
        }

        try {
            const res = await fetch(`${apiBase}/instruments/suggestions`);
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data)) {
                globalInstrumentCache = data as string[];
                setAllInstruments(globalInstrumentCache);
            }
        } catch (e) {
            console.warn('Failed to fetch instrument suggestions', e);
        }
    }, []);

    // Prefetch suggestions when dialog opens (only first time hits backend)
    useEffect(() => {
        if (!isOpen) return;
        loadInstrumentSuggestions();
    }, [isOpen, loadInstrumentSuggestions]);

    // When user adds a brand-new instrument, keep it in local + global cache
    const rememberInstrumentLocally = useCallback((name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        setAllInstruments((prev) => {
            if (
                prev.some(
                    (i) => i.toLowerCase() === trimmed.toLowerCase(),
                )
            ) {
                return prev;
            }
            const next = [...prev, trimmed];
            globalInstrumentCache = next;
            return next;
        });
    }, []);

    /**
    * High-res preview of ONLY the selected area.
    * Strategy:
    *  1. Render the whole page once at scale = 1 onto an offscreen canvas.
    *  2. Crop the group rect from that page.
    *  3. Scale the cropped image up/down to a nice preview size.
    *
    * Because the crop uses the same base viewport (scale 1) as our normalized
    * rect coords, the preview matches the blue selection exactly.
    */
    useEffect(() => {
        if (!isOpen) return;
        const canvas = previewCanvasRef.current;
        const container = previewContainerRef.current;
        if (!canvas || !container) return;

        let cancelled = false;

        (async () => {
            try {
                const page = await pdf.getPage(pageIndex + 1);
                if (cancelled) return;

                // --- 1) Render full page at scale = 1 ---
                const baseViewport = page.getViewport({ scale: 1 });
                const dpr = window.devicePixelRatio || 1;

                const offCanvas = document.createElement('canvas');
                offCanvas.width = baseViewport.width * dpr;
                offCanvas.height = baseViewport.height * dpr;
                const offCtx = offCanvas.getContext('2d');
                if (!offCtx) return;

                offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                offCtx.clearRect(0, 0, baseViewport.width, baseViewport.height);

                await page
                    .render({
                        canvasContext: offCtx,
                        viewport: baseViewport,
                    })
                    .promise;
                if (cancelled) return;

                // --- 2) Group rect in page pixels (scale = 1) ---
                const gx = rect.nx * baseViewport.width;
                const gy = rect.ny * baseViewport.height;
                const gw = rect.nw * baseViewport.width;
                const gh = rect.nh * baseViewport.height;

                // --- 3) Decide preview size (scale cropped region) ---
                // Use as much of the preview box as we can, while
                // keeping aspect ratio of the cropped group.
                const containerWidth = container.clientWidth || gw;
                const containerHeight = container.clientHeight || gh;

                // leave some padding inside the container
                const maxWidth = Math.max(320, containerWidth - 32);
                const maxHeight = Math.max(260, containerHeight - 32);

                const MIN_WIDTH = 420;

                let scale = 1;
                if (gw > 0 && gh > 0) {
                    scale = Math.min(
                        maxWidth / gw,
                        maxHeight / gh,
                        3 // hard cap zoom if group is extremely tiny
                    );
                }

                let cssWidth = gw * scale;
                let cssHeight = gh * scale;

                // still ensure a minimum width for very thin groups
                if (cssWidth < MIN_WIDTH) {
                    const factor = MIN_WIDTH / cssWidth;
                    cssWidth *= factor;
                    cssHeight *= factor;
                }

                // --- 4) Configure visible canvas ---
                canvas.width = cssWidth * dpr;
                canvas.height = cssHeight * dpr;
                canvas.style.width = `${cssWidth}px`;
                canvas.style.height = `${cssHeight}px`;

                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, cssWidth, cssHeight);

// --- 5) Crop from offscreen page → visible preview ---
ctx.drawImage(
  offCanvas,
  gx * dpr,
  gy * dpr,
  gw * dpr,
  gh * dpr,
  0,
  0,
  cssWidth,
  cssHeight
);

// 🔍 Apply a light sharpen filter to make the preview crisper
// Use the real canvas buffer size (already scaled by dpr)
applySharpenFilter(ctx, canvas.width, canvas.height);

// Overlay (green mark boxes) uses this size
setOverlaySize({ w: cssWidth, h: cssHeight });

            } catch (e) {
                if (!cancelled) {
                    console.warn('Failed to render group preview', e);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isOpen, pdf, pageIndex, rect]);


    const handleOverlayMouseDown = (e: React.MouseEvent) => {
        // Clicking anywhere on the preview background should clear current highlight
        setHighlightedMarkId(null);

        if (!onCreateMarkInGroup) return; // nothing to do if mark creation disabled

        const overlay = overlayRef.current;
        if (!overlay) return;
        const bounds = overlay.getBoundingClientRect();

        const x = e.clientX - bounds.left;
        const y = e.clientY - bounds.top;

        setIsDrawing(true);
        setDrawStart({ x, y });
        setCurrentRect({ x, y, w: 0, h: 0 });
    };


    const handleOverlayMouseMove = (e: React.MouseEvent) => {
        if (!isDrawing || !drawStart) return;
        const overlay = overlayRef.current;
        if (!overlay) return;
        const bounds = overlay.getBoundingClientRect();

        const x = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left));
        const y = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top));

        const left = Math.min(drawStart.x, x);
        const top = Math.min(drawStart.y, y);
        const width = Math.abs(x - drawStart.x);
        const height = Math.abs(y - drawStart.y);

        setCurrentRect({ x: left, y: top, w: width, h: height });
    };

    const handleOverlayMouseUp = () => {
        if (!isDrawing || !drawStart || !currentRect || !onCreateMarkInGroup) {
            setIsDrawing(false);
            setCurrentRect(null);
            setDrawStart(null);
            return;
        }

        const overlay = overlayRef.current;
        if (!overlay) {
            setIsDrawing(false);
            setCurrentRect(null);
            setDrawStart(null);
            return;
        }
        const bounds = overlay.getBoundingClientRect();

        if (currentRect.w < 8 || currentRect.h < 8) {
            // Ignore tiny accidental clicks
            setIsDrawing(false);
            setCurrentRect(null);
            setDrawStart(null);
            return;
        }

        // Convert overlay rect (inside group preview) → page-normalized coords
        const relX = currentRect.x / bounds.width;
        const relY = currentRect.y / bounds.height;
        const relW = currentRect.w / bounds.width;
        const relH = currentRect.h / bounds.height;

        let markRect = {
            nx: rect.nx + relX * rect.nw,
            ny: rect.ny + relY * rect.nh,
            nw: rect.nw * relW,
            nh: rect.nh * relH,
        };

        // Clamp the mark so it never escapes the group area
        const gx1 = rect.nx;
        const gy1 = rect.ny;
        const gx2 = rect.nx + rect.nw;
        const gy2 = rect.ny + rect.nh;

        let mx1 = markRect.nx;
        let my1 = markRect.ny;
        let mx2 = markRect.nx + markRect.nw;
        let my2 = markRect.ny + markRect.nh;

        mx1 = Math.max(mx1, gx1);
        my1 = Math.max(my1, gy1);
        mx2 = Math.min(mx2, gx2);
        my2 = Math.min(my2, gy2);

        markRect = {
            nx: mx1,
            ny: my1,
            nw: Math.max(0, mx2 - mx1),
            nh: Math.max(0, my2 - my1),
        };

        // If it collapsed completely, just abort this draw
        if (markRect.nw === 0 || markRect.nh === 0) {
            setIsDrawing(false);
            setCurrentRect(null);
            setDrawStart(null);
            return;
        }

        const newId = onCreateMarkInGroup(pageIndex, markRect);

        if (newId) {
            // Newly created balloons should start as NON-critical.
            // Existing DB marks keep their original is_required state.
            if (onUpdateMark) {
                onUpdateMark(newId, { is_required: false });
            }

            // 🔍 Immediately trigger OCR for required value
            runOcrForMark(newId, markRect);

            // user interacted with selection
            userSelectionTouchedRef.current = true;

            // auto-select the new mark (keep any existing ones)
            setSelected((prev) => {
                const next = new Set(prev);
                next.add(newId);
                return next;
            });

            // and focus it visually (yellow border + list highlight)
            setHighlightedMarkId(newId);
        }



        setIsDrawing(false);
        setCurrentRect(null);
        setDrawStart(null);
    };


    const handleSave = async () => {
        if (!ownerMarkSetId) {
            window.alert('Missing owner mark_set_id – cannot save group.');
            return;
        }

        const groupName =
            mode === 'edit'
                ? (initialName && initialName.trim()) || `Group ${pageIndex + 1}`
                : `Group ${nextGroupNumber ?? 1}`;

        const mark_ids = Array.from(selected);


        if (mark_ids.length === 0) {
            const ok = window.confirm(
                'No marks selected for this group. Create an empty group anyway?'
            );
            if (!ok) return;
        }

        try {
            setSaving(true);
// 1) Persist marks first (so instrument/required_value changes survive refresh)
if (onPersistMarks) {
    try {
        await onPersistMarks();
    } catch (e) {
        console.error('Persist marks failed', e);
        window.alert('Failed to save mark changes (instrument / required value). Group not saved.');
        return;
    }
} else {
    console.warn('onPersistMarks not provided — mark edits will not persist on refresh.');
}

            const payload: any = {
                page_index: pageIndex,
                name: groupName,
                nx: rect.nx,
                ny: rect.ny,
                nw: rect.nw,
                nh: rect.nh,
                mark_ids,
            };

            let res: Response;

            if (mode === 'edit' && groupId) {
                // Update existing group
                res = await fetch(`${apiBase}/groups/${groupId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            } else {
                // Create new group
                res = await fetch(`${apiBase}/mark-sets/${ownerMarkSetId}/groups`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            }

            if (!res.ok) {
                const txt = await res.text();
                console.error('Group save failed', txt);
                window.alert('Failed to save group.');
                return;
            }

            onSaved();
        } catch (e) {
            console.error(e);
            window.alert('Failed to save group.');
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    // Helper to position marks inside overlay space
    const overlayW = overlaySize.w || 1;
    const overlayH = overlaySize.h || 1;

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
            }}
        >
            <div
                style={{
                    width: '1500px',
                    maxWidth: '99vw',
                    maxHeight: '97vh',
                    background: '#fff',
                    borderRadius: 10,
                    boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
                    padding: '12px 20px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                }}
                onMouseDown={(e) => {
                    // only clear when clicking the empty background, not children
                    if (e.target === e.currentTarget) {
                        setHighlightedMarkId(null);
                    }
                }}
            >

                {/* Header */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                    }}
                >
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>
  {mode === 'edit' ? (
    <>
      <span style={{ color: '#1976d2' }}>Edit Group</span>
      <span>{' - Select/Deselect balloons'}</span>
    </>
  ) : (
    <>
      <span style={{ color: '#1976d2' }}>Select dimensions</span>
      <span>{' to create balloons for'}</span>
    </>
  )}
  {/* – Page{' '} */}
  {/* {pageIndex + 1} */}
</div>

                        {/* <div
              style={{
                fontSize: 12,
                color: '#666',
                marginTop: 2,
              }}
            >
              Selected area will be auto-fit in the Viewer. Draw rectangles
              inside the preview to create marks.
            </div> */}
                    </div>
                    <button
                        onClick={onClose}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            fontSize: 20,
                            cursor: 'pointer',
                            padding: 4,
                        }}
                        title="Close"
                    >
                        ✕
                    </button>
                </div>



                {/* Body: left preview + right marks */}
                <div
                    style={{
                        flex: 1,
                        minHeight: 0,
                        display: 'flex',
                        gap: 16,
                        marginTop: 4,
                    }}
                >
                    {/* Left: preview (70%) */}
                    <div
                        ref={previewContainerRef}
                        style={{
                            flex: '0 0 74%',
                            border: '1px solid #ddd',
                            borderRadius: 6,
                            padding: 3,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            overflow: 'auto',
                            minHeight: 380,
                        }}

                    >

                        {/* <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: '#555',
              }}
            >
              Selected area (draw marks here)
            </div> */}
                        <div
                            style={{
                                flex: 1,
                                minHeight: 260,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                overflow: 'auto',
                            }}
                        >
                            <div
                                style={{
                                    position: 'relative',
                                    display: 'inline-block',
                                }}
                            >
                                <canvas
                                    ref={previewCanvasRef}
                                    style={{
                                        borderRadius: 4,
                                        background: '#f7f7f7',
                                        maxWidth: '100%',
                                        height: 'auto',
                                        display: 'block',
                                        border: '2px solid #ccc',      // 👈 clear border of the selectable area
                                        boxSizing: 'border-box',
                                    }}
                                />

                                {/* HTML overlay for marks + drawing */}
                                <div
                                    ref={overlayRef}
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        cursor: onCreateMarkInGroup ? 'crosshair' : 'default',
                                    }}
                                    onMouseDown={handleOverlayMouseDown}
                                    onMouseMove={handleOverlayMouseMove}
                                    onMouseUp={handleOverlayMouseUp}
                                    onMouseLeave={handleOverlayMouseUp}   // 👈 NEW: finalize when leaving
                                >

                                    {marksInArea.map((m) => {
                                        const relX = (m.nx - rect.nx) / rect.nw;
                                        const relY = (m.ny - rect.ny) / rect.nh;
                                        const relW = m.nw / rect.nw;
                                        const relH = m.nh / rect.nh;

                                        const left = relX * overlayW;
                                        const top = relY * overlayH;
                                        const width = relW * overlayW;
                                        const height = relH * overlayH;

                                        const required = m.is_required !== false;
                                        const isSelected = selected.has(m.mark_id);
                                        const isHighlighted = highlightedMarkId === m.mark_id;

                                        const baseBorder = isSelected
                                            ? '2px solid rgba(76,175,80,0.95)' // green when in group
                                            : '2px solid rgba(25,118,210,0.95)'; // blue when NOT selected

                                        const border = isHighlighted
                                            ? '3px solid #FFD400' // yellow border when focused
                                            : baseBorder;

                                        const baseBg = isSelected
                                            ? 'rgba(76,175,80,0.15)'
                                            : 'rgba(25,118,210,0.10)';


                                        return (
                                            <div
                                                key={m.mark_id}
                                                style={{
                                                    position: 'absolute',
                                                    left,
                                                    top,
                                                    width,
                                                    height,
                                                    border,
                                                    background: baseBg,
                                                    boxSizing: 'border-box',
                                                    transition: 'border 0.15s ease',
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onFocusMark(m.mark_id);
                                                    setHighlightedMarkId(m.mark_id);
                                                }}
                                            >
                                                {/* top-left label circle */}
                                                {m.label && (
                                                    <div
                                                        style={{
                                                            position: 'absolute',
                                                            left: -16,
                                                            top: -16,
                                                            width: 24,
                                                            height: 24,
                                                            borderRadius: '999px',
                                                            border: '2px solid #000',
                                                            background: '#fff',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            fontSize: 12,
                                                            fontWeight: 700,
                                                            boxSizing: 'border-box',
                                                        }}
                                                    >
                                                        {m.label}
                                                    </div>
                                                )}
                                                {/* required star */}
                                                {/* <div
                                                    style={{
                                                        position: 'absolute',
                                                        right: -4,
                                                        top: -4,
                                                        fontSize: 16,
                                                        color: required ? '#f9a825' : '#ccc',
                                                    }}
                                                >
                                                    ★
                                                </div> */}
                                            </div>
                                        );
                                    })}

                                    {/* Drawing rectangle */}
                                    {isDrawing && currentRect && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                left: currentRect.x,
                                                top: currentRect.y,
                                                width: currentRect.w,
                                                height: currentRect.h,
                                                border: '2px dashed #1976d2',
                                                background: 'rgba(25,118,210,0.15)',
                                                boxSizing: 'border-box',
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right: marks in area (30%) */}
                    {/* Right: marks in area (30%) */}
                    <div
                        style={{
                            flex: '0 0 24%',
                            maxWidth: 320,
                            display: 'flex',
                            flexDirection: 'column',
                            minHeight: 0,
                        }}
                    >



                        <div
                            style={{
                                fontSize: 14,
                                color: '#555',
                                marginBottom: 6,
                                fontWeight: 500,
                                display: 'flex',
                                justifyContent: 'space-between',
                            }}
                        >
                            Inspection Balloons
                        </div>

                        <div
                            style={{
                                fontSize: 11,
                                color: '#555',
                                marginBottom: 6,
                                fontWeight: 500,
                                display: 'flex',
                                justifyContent: 'space-between',
                            }}
                        >

                            <span>Preexisting balloons are also shown</span>
                            <span style={{ color: '#1976d2' }}>
                                {selected.size} / {marksInArea.length} selected
                            </span>
                        </div>
                        <div
                            style={{
                                border: '1px solid #eee',
                                borderRadius: 4,
                                padding: 6,
                                flex: 1,          // 👈 take all remaining height
                                minHeight: 0,     // 👈 allow flexbox to shrink properly
                                overflow: 'auto', // 👈 still scroll when content is taller
                                background: '#fafafa',
                                width: '100%',
                                boxSizing: 'border-box',
                            }}
                        >


                            {marksInArea.length === 0 && (
                                <div
                                    style={{
                                        fontSize: 12,
                                        color: '#999',
                                        padding: '18px 12px',
                                        textAlign: 'center',
                                    }}
                                >
                                    No balloons in group, select dimensions to create.
                                    <br />
                                    {onCreateMarkInGroup
                                        ? ''
                                        : 'Select dimensions to create balloons for'}
                                </div>
                            )}

                            {marksInArea.map((m) => {
                                const required = m.is_required !== false;
                                const isSelected = selected.has(m.mark_id);
                                const isHighlighted = highlightedMarkId === m.mark_id;

                                // mark is "new" if it's NOT in the original DB mark list
                                // Delete icon should ONLY show for marks that are explicitly deletable.
// This prevents "stale edit-mode state" from showing cross even after saving.
const isDeletable =
    Array.isArray(deletableMarkIds) && deletableMarkIds.includes(m.mark_id);


                                // 🔢 OCR helpers (NEW)
                                const conf = m.required_value_conf ?? null;
                                const lowConfidence =
                                    conf !== null && conf < 95; // threshold
                                const initialRequiredValue =
                                    m.required_value_final ??
                                    m.required_value_ocr ??
                                    '';


                                return (
                                    <div
                                        key={m.mark_id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            padding: '4px 6px',
                                            borderRadius: 4,
                                            cursor: 'pointer',
                                            background: isHighlighted
                                                ? '#fff9c4' // yellow when focused
                                                : isSelected
                                                    ? '#e3f2fd'
                                                    : 'transparent',
                                            marginBottom: 2,
                                        }}
                                        onClick={() => {
                                            onFocusMark(m.mark_id);
                                            setHighlightedMarkId(m.mark_id);
                                        }}
                                    >
                                        {/* Checkbox */}
                                        {/* Select toggle (Eye icon) */}
<button
  type="button"
  onClick={(e) => {
    e.stopPropagation();
    toggleMarkSelected(m.mark_id);
  }}
  title={isSelected ? 'Selected' : 'Not selected'}
  style={{
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }}
>
  <img
    src="/icons/eye.png"
    alt="Select"
    style={{
      width: 18,
      height: 18,
      filter: isSelected
    ? 'invert(33%) sepia(93%) saturate(1770%) hue-rotate(189deg) brightness(93%) contrast(92%)' // blue-ish (#1976d2 feel)
    : 'grayscale(100%) opacity(0.55)',
    }}
  />
</button>


        {/* Label + required value + instrument + actions all on one line */}
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
    minWidth: 0,  
        }}
    >
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 20,
                height: 20,
                borderRadius: '999px',
                border: '1px solid #000',
                fontSize: 12,
                fontWeight: 700,
            }}
        >
            {m.label || '—'}
        </span>

        {/* 🔢 Required Value input (left of instrument) */}
        <input
            type="text"
            value={initialRequiredValue}
            onChange={(e) => {
                const v = e.target.value;
                onUpdateMark(m.mark_id, {
                    required_value_final: v,
                });

            }}
            placeholder="Req. value"
            style={{
                border: '1px solid',
                borderColor: lowConfidence
                    ? '#ff9800' // orange for low confidence
                    : '#ddd',
                borderRadius: 4,
                fontSize: 12,
                padding: '4px 6px',
                minWidth: 50,
                flex: '0 0 30%',
                maxWidth: '30%',
                boxSizing: 'border-box',
            }}
            title={
                conf !== null
                    ? `OCR confidence: ${conf.toFixed(1)}%`
                    : 'Required value'
            }
        />

         <InstrumentCombo
            value={m.instrument || ''}
            allInstruments={allInstruments}
            onChange={(val) => {
                onUpdateMark(m.mark_id, {
                    instrument: val || undefined,
                });
            }}
            onAddNewLocal={rememberInstrumentLocally}
        />


                                            {/* Cross immediately after instrument box, only for NEW balloons */}
                                            {onDeleteMark && isDeletable && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDeleteMark(m.mark_id);
                                                    }}
                                                    title="Delete this balloon"
                                                    style={{
                                                        border: 'none',
                                                        background: 'transparent',
                                                        cursor: 'pointer',
                                                        fontSize: 18,
                                                        color: '#b71c1c',
                                                        lineHeight: 1,
                                                        marginLeft: 2,
                                                    }}
                                                >
                                                    ×
                                                </button>
                                            )}

                                            {/* Spacer to push critical icon to the right end */}
                                            <div style={{ flex: 1 }} />

                                            {/* Required toggle at far right of the line */}
                                            <button
  type="button"
  onClick={(e) => {
    e.stopPropagation();
    onUpdateMark(m.mark_id, {
      is_required: !required,
    });
  }}
  title={required ? 'Required measurement' : 'Optional measurement'}
  style={{
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }}
>
  <img
    src="/icons/hash.png"
    alt="Critical"
    style={{
      width: 16,
      height: 16,
      filter: required
        ? 'invert(14%) sepia(98%) saturate(5000%) hue-rotate(350deg) brightness(90%) contrast(95%)'
        : 'grayscale(100%) opacity(0.45)',
    }}
  />
</button>

                                        </div>
                                    </div>
                                );
                            })}

                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: 8,
                        marginTop: 2,
                    }}
                >
                    <button
                        onClick={onClose}
                        disabled={saving}
                        style={{
                            padding: '6px 12px',
                            borderRadius: 4,
                            border: '1px solid #ccc',
                            background: '#fff',
                            fontSize: 13,
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        style={{
                            padding: '6px 14px',
                            borderRadius: 4,
                            border: '1px solid #1976d2',
                            background: '#1976d2',
                            color: '#fff',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer',
                        }}
                    >
                        {saving ? 'Saving…' : 'Save Group'}
                    </button>
                </div>
            </div>
        </div>
    );
}
