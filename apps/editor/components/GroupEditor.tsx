'use client';

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type Mark = {
  mark_id: string;
  label?: string;
  instrument?: string;
  is_required?: boolean;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
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
  // create vs edit existing group
  mode?: 'create' | 'edit';
  groupId?: string;
  initialName?: string;
  initialSelectedMarkIds?: string[];
  onClose: () => void;
  onSaved: () => void;
  onUpdateMark: (markId: string, updates: Partial<Mark>) => void;
  onFocusMark: (markId: string) => void;
  // Optional: create marks directly from the preview
  onCreateMarkInGroup?: (
    pageIndex: number,
    rect: { nx: number; ny: number; nw: number; nh: number }
  ) => string | void;
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

export default function GroupEditor({
  isOpen,
  pdf,
  pageIndex,
  rect,
  marksOnPage,
  ownerMarkSetId,
  mode = 'create',
  groupId,
  initialName,
  initialSelectedMarkIds,
  onClose,
  onSaved,
  onUpdateMark,
  onFocusMark,
  onCreateMarkInGroup,
}: GroupEditorProps) {
  const [name, setName] = useState<string>(
    initialName ?? `Group p${pageIndex + 1}`
  );
  const [saving, setSaving] = useState(false);


  // marks that geometrically lie inside this area
  const marksInArea = useMemo(
    () => marksOnPage.filter((m) => overlaps(rect, m)),
    [marksOnPage, rect]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  // instrument suggestions (same API as MarkList)
  const [instrumentQuery, setInstrumentQuery] = useState<string>('');
  const [instrumentSuggestions, setInstrumentSuggestions] = useState<string[]>(
    []
  );
  const suggestionsAbortRef = useRef<AbortController | null>(null);

  // hydrate selected marks whenever area or marks change
  // Initialise and keep selection stable:
  // - when dialog opens:
  //    • edit mode  → use initialSelectedMarkIds
  //    • create mode → select all marks in area
  // - when marksInArea changes:
  //    • keep existing selection if possible
  //    • don't auto-reselect marks that user unchecked
  useEffect(() => {
    if (!isOpen) return;

    setSelected((prev) => {
      const idsInArea = new Set<string>(
        marksInArea.map((m) => m.mark_id).filter(Boolean) as string[]
      );

      // first time (prev empty) → initialise from props
      let base: Set<string>;
      if (prev.size === 0) {
        if (initialSelectedMarkIds && initialSelectedMarkIds.length > 0) {
          base = new Set(
            initialSelectedMarkIds.filter((id) => idsInArea.has(id))
          );
        } else {
          // create mode default: everything in area selected
          base = new Set(idsInArea);
        }
      } else {
        // subsequent updates: keep only ids that still exist in area
        base = new Set<string>();
        prev.forEach((id) => {
          if (idsInArea.has(id)) base.add(id);
        });
      }

      return base;
    });
  }, [isOpen, marksInArea, initialSelectedMarkIds]);

  const toggleMarkSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchSuggestions = useCallback(async (q: string) => {
    try {
      if (suggestionsAbortRef.current) {
        suggestionsAbortRef.current.abort();
      }
      const ctrl = new AbortController();
      suggestionsAbortRef.current = ctrl;

      const url = q.trim()
        ? `${apiBase}/instruments/suggestions?q=${encodeURIComponent(
            q.trim()
          )}`
        : `${apiBase}/instruments/suggestions`;

      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setInstrumentSuggestions(data as string[]);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.warn('Failed to fetch instrument suggestions', e);
    }
  }, []);

  // Prefetch suggestions when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    fetchSuggestions('');
  }, [isOpen, fetchSuggestions]);

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
        // Start from the natural group size at scale=1
        let cssWidth = gw;
        let cssHeight = gh;

        // Ensure a minimum width for usability
        const MIN_WIDTH = 260;
        if (cssWidth < MIN_WIDTH) {
          const factor = MIN_WIDTH / cssWidth;
          cssWidth *= factor;
          cssHeight *= factor;
        }

        // Also make sure we don't overflow the container width
        const maxWidth = Math.max(200, container.clientWidth - 16);
        if (cssWidth > maxWidth) {
          const factor = maxWidth / cssWidth;
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


  // Mouse handlers on the HTML overlay (not the canvas) – fixes dpr misalignment
  const handleOverlayMouseDown = (e: React.MouseEvent) => {
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

    const markRect = {
      nx: rect.nx + relX * rect.nw,
      ny: rect.ny + relY * rect.nh,
      nw: rect.nw * relW,
      nh: rect.nh * relH,
    };

    const newId = onCreateMarkInGroup(pageIndex, markRect);

    // auto-select only the new mark (do NOT disturb existing selections)
    if (newId) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(newId);
        return next;
      });
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

    const groupName = name.trim() || `Group p${pageIndex + 1}`;
    const mark_ids = Array.from(selected);

    if (mark_ids.length === 0) {
      const ok = window.confirm(
        'No marks selected for this group. Create an empty group anyway?'
      );
      if (!ok) return;
    }

    try {
      setSaving(true);

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
          width: '1200px',
          maxWidth: '96vw',
          maxHeight: '90vh',
          background: '#fff',
          borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
          padding: '16px 20px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
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
              {mode === 'edit' ? 'Edit Group' : 'New Group'} – Page{' '}
              {pageIndex + 1}
            </div>
            <div
              style={{
                fontSize: 12,
                color: '#666',
                marginTop: 2,
              }}
            >
              Selected area will be auto-fit in the Viewer. Draw rectangles
              inside the preview to create marks.
            </div>
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

        {/* Group name */}
        <div>
          <label
            style={{
              fontSize: 11,
              color: '#555',
              display: 'block',
              marginBottom: 4,
              fontWeight: 500,
            }}
          >
            Group name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 4,
              border: '1px solid #ccc',
              fontSize: 13,
            }}
          />
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
              flex: '0 0 70%',
              border: '1px solid #eee',
              borderRadius: 6,
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: '#555',
              }}
            >
              Selected area (draw marks here)
            </div>
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
                >
                  {/* Existing marks inside group */}
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

                    return (
                      <div
                        key={m.mark_id}
                        style={{
                          position: 'absolute',
                          left,
                          top,
                          width,
                          height,
                          border: '2px solid rgba(76,175,80,0.9)',
                          background: 'rgba(76,175,80,0.15)',
                          boxSizing: 'border-box',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onFocusMark(m.mark_id);
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
                        <div
                          style={{
                            position: 'absolute',
                            right: -4,
                            top: -4,
                            fontSize: 16,
                            color: required ? '#f9a825' : '#ccc',
                          }}
                        >
                          ★
                        </div>
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
          <div
            style={{
              flex: '0 0 30%',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
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
              <span>Marks inside this area</span>
              <span style={{ color: '#1976d2' }}>
                {selected.size} / {marksInArea.length} selected
              </span>
            </div>

            <div
              style={{
                border: '1px solid #eee',
                borderRadius: 4,
                padding: 6,
                minHeight: 140,
                maxHeight: 300,
                overflow: 'auto',
                background: '#fafafa',
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
                  No marks currently in this area.
                  <br />
                  {onCreateMarkInGroup
                    ? 'Draw a rectangle in the preview to create a mark, then set instrument / required here.'
                    : 'Create marks on the Master mark set for this document, then come back here to group them.'}
                </div>
              )}

              {marksInArea.map((m) => {
                const required = m.is_required !== false;
                return (
                  <div
                    key={m.mark_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: selected.has(m.mark_id)
                        ? '#e3f2fd'
                        : 'transparent',
                      marginBottom: 2,
                    }}
                    onClick={() => onFocusMark(m.mark_id)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(m.mark_id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleMarkSelected(m.mark_id);
                        }}
                      />
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                          onClick={(e) => e.stopPropagation()}
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
                          <input
                            type="text"
                            list="ge-instrument-suggestions"
                            defaultValue={m.instrument || ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setInstrumentQuery(v);
                              fetchSuggestions(v);
                              onUpdateMark(m.mark_id, {
                                instrument: v || undefined,
                              });
                            }}
                            placeholder="Instrument..."
                            style={{
                              border: '1px solid #ddd',
                              borderRadius: 4,
                              fontSize: 12,
                              padding: '4px 6px',
                              minWidth: 170,
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Required star toggle */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateMark(m.mark_id, {
                          is_required: !required,
                        });
                      }}
                      title={
                        required
                          ? 'Required measurement'
                          : 'Optional measurement'
                      }
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 18,
                        color: required ? '#f9a825' : '#ccc',
                      }}
                    >
                      ★
                    </button>
                  </div>
                );
              })}

              <datalist id="ge-instrument-suggestions">
                {instrumentSuggestions.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
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
