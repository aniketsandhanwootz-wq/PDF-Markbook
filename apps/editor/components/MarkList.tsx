'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';

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
  label?: string;
  instrument?: string;
  is_required?: boolean;
};

type Group = {
  group_id: string;
  name: string;
  page_index: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  mark_ids: string[];
};

type CommonProps = {
  marks: Mark[];
  groups?: Group[];
  selectedMarkId: string | null;
  selectedGroupId?: string | null;
  onSelect: (mark: Mark) => void;
  onGroupSelect?: (group: Group) => void;
  onUpdate: (markId: string, updates: Partial<Mark>) => void;
  onDelete: (markId: string) => void;
  onDuplicate: (markId: string) => void;
  onReorder: (markId: string, direction: 'up' | 'down') => void;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

/* ------------------------------------------------------------------ */
/*  1. GROUP SIDEBAR (QC / non-master)                                */
/* ------------------------------------------------------------------ */

function GroupSidebar({
  groups = [],
  selectedGroupId,
  onGroupSelect,
}: {
  groups: Group[];
  selectedGroupId?: string | null;
  onGroupSelect?: (group: Group) => void;
}) {
  return (
    <div className="mark-list">
      {/* Header */}
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #eee',
          background: '#fafafa',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#555',
            marginBottom: 4,
          }}
        >
          Groups
        </div>
        <div style={{ fontSize: 11, color: '#888' }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''} · Click a group to jump
        </div>
      </div>

      {/* List – line-by-line like Adobe / Edge */}
      <div
        style={{
          maxHeight: 'calc(100vh - 180px)',
          overflowY: 'auto',
        }}
      >
        {groups.map((g, idx) => {
          const isActive = selectedGroupId === g.group_id;
          return (
            <button
              key={g.group_id}
              type="button"
              onClick={() => onGroupSelect && onGroupSelect(g)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                border: 'none',
                borderBottom: '1px solid #eee',
                background: isActive ? '#e3f2fd' : '#fff',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                cursor: 'pointer',
              }}
              title={`Page ${g.page_index + 1}`}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#333',
                }}
              >
                {g.name || `Group ${idx + 1}`}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: '#777',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>Page {g.page_index + 1}</span>
                <span>
                  {(g.mark_ids && g.mark_ids.length) || 0} mark
                  {(g.mark_ids && g.mark_ids.length) === 1 ? '' : 's'}
                </span>
              </div>
            </button>
          );
        })}

        {groups.length === 0 && (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: '#999',
              fontSize: 14,
            }}
          >
            No groups yet
          </div>
        )}
      </div>

      {/* Tiny helper at bottom */}
      <div
        style={{
          padding: '8px 12px',
          fontSize: 11,
          color: '#777',
          borderTop: '1px solid #eee',
        }}
      >
        Draw a rectangle on the PDF to create a new group.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  2. MASTER MARK LIST (no groups)                                   */
/* ------------------------------------------------------------------ */

function MasterMarkList({
  marks,
  selectedMarkId,
  onSelect,
  onUpdate,
  onDelete,
  onDuplicate,
  onReorder,
}: {
  marks: Mark[];
  selectedMarkId: string | null;
  onSelect: (mark: Mark) => void;
  onUpdate: (markId: string, updates: Partial<Mark>) => void;
  onDelete: (markId: string) => void;
  onDuplicate: (markId: string) => void;
  onReorder: (markId: string, direction: 'up' | 'down') => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [instrumentQuery, setInstrumentQuery] = useState('');
  const [instrumentSuggestions, setInstrumentSuggestions] = useState<string[]>([]);
  const suggestionsAbortRef = useRef<AbortController | null>(null);

  const itemsRef = useRef<HTMLDivElement>(null);

  // Filter marks based on search query (also search instrument)
  const filteredMarks = useMemo(() => {
    const base = marks;
    if (!searchQuery.trim()) return base;

    const q = searchQuery.toLowerCase();
    return base.filter((m) => {
      const nameHit = m.name.toLowerCase().includes(q);
      const pageHit = `page ${m.page_index + 1}`.includes(q);
      const instrHit = (m.instrument || '').toLowerCase().includes(q);
      return nameHit || pageHit || instrHit;
    });
  }, [marks, searchQuery]);

  const handleClearSearch = () => setSearchQuery('');

  const handleEditStart = (mark: Mark) => {
    setEditingId(mark.mark_id || null);
    setEditName(mark.name);
    setInstrumentQuery(mark.instrument || '');
  };

  const fetchSuggestions = useCallback(
    async (q: string) => {
      try {
        if (suggestionsAbortRef.current) {
          suggestionsAbortRef.current.abort();
        }
        const ctrl = new AbortController();
        suggestionsAbortRef.current = ctrl;

        const url = q.trim()
          ? `${apiBase}/instruments/suggestions?q=${encodeURIComponent(q.trim())}`
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
    },
    []
  );

  // When we enter edit mode, hydrate instrument query and prefetch suggestions
  useEffect(() => {
    if (!editingId) return;
    const m = marks.find((x) => x.mark_id === editingId);
    const base = m?.instrument || '';
    setInstrumentQuery(base);
    fetchSuggestions(base);
  }, [editingId, marks, fetchSuggestions]);

  const handleEditSave = (markId: string) => {
    const updates: Partial<Mark> = {};
    if (editName.trim()) updates.name = editName.trim();
    updates.instrument = instrumentQuery.trim() || undefined;

    onUpdate(markId, updates);
    setEditingId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditName('');
    setInstrumentQuery('');
  };

  // Auto-scroll the selected mark inside the items scroller
  useEffect(() => {
    if (!selectedMarkId) return;
    const container = itemsRef.current;
    if (!container) return;

    const raf = requestAnimationFrame(() => {
      const el = container.querySelector<HTMLElement>(`[data-mark-id="${selectedMarkId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    return () => cancelAnimationFrame(raf);
  }, [selectedMarkId, filteredMarks.length, searchQuery]);

  return (
    <div className="mark-list">
      {/* Sticky head: Search */}
      <div
        className="mark-list-head"
        style={{ padding: '12px', borderBottom: '1px solid #eee', background: '#fafafa' }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#555',
            marginBottom: 6,
          }}
        >
          Marks
        </div>

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search marks or instruments..."
            style={{
              width: '100%',
              padding: '8px 32px 8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              outline: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#1976d2';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = '#ddd';
            }}
          />
          {searchQuery && (
            <button
              onClick={handleClearSearch}
              style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '16px',
                color: '#999',
                padding: '4px',
                lineHeight: '1',
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div style={{ fontSize: 12, color: '#666', marginTop: 8, fontWeight: 500 }}>
          {searchQuery ? (
            <>
              <span style={{ color: '#1976d2' }}>{filteredMarks.length}</span> of {marks.length} marks
            </>
          ) : (
            <>All Marks ({marks.length})</>
          )}
        </div>
      </div>

      {/* Items (scrollable) */}
      <div className="mark-list-items" ref={itemsRef}>
        {filteredMarks.map((mark) => {
          const originalIndex = marks.findIndex((m) => m.mark_id === mark.mark_id);
          const isEditing = editingId === mark.mark_id;
          const isSelected = selectedMarkId === mark.mark_id;
          const required = mark.is_required !== false; // default true

          return (
            <div
              key={mark.mark_id || originalIndex}
              className={`mark-item ${isSelected ? 'selected' : ''}`}
              data-mark-id={mark.mark_id || `idx-${originalIndex}`}
            >
              {isEditing ? (
                <div className="mark-edit">
                  {/* Name */}
                  <div style={{ marginBottom: 8 }}>
                    <label
                      style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}
                    >
                      Name
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleEditSave(mark.mark_id!);
                        if (e.key === 'Escape') handleEditCancel();
                      }}
                      autoFocus
                      className="mark-edit-input"
                    />
                  </div>

                  {/* Instrument */}
                  <div style={{ marginBottom: 8 }}>
                    <label
                      style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}
                    >
                      Instrument (autocomplete)
                    </label>
                    <input
                      type="text"
                      list="instrument-suggestions"
                      value={instrumentQuery}
                      onChange={(e) => {
                        const v = e.target.value;
                        setInstrumentQuery(v);
                        fetchSuggestions(v);
                      }}
                      className="mark-edit-input"
                    />
                    <datalist id="instrument-suggestions">
                      {instrumentSuggestions.map((opt) => (
                        <option key={opt} value={opt} />
                      ))}
                    </datalist>
                  </div>

                  {/* Required toggle */}
                  <div style={{ marginBottom: 8 }}>
                    <label
                      style={{
                        fontSize: 11,
                        color: '#666',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={required}
                        onChange={(e) => onUpdate(mark.mark_id!, { is_required: e.target.checked })}
                      />
                      Required measurement
                    </label>
                  </div>

                  <div className="mark-edit-actions">
                    <button onClick={() => handleEditSave(mark.mark_id!)} className="btn-sm">
                      ✓
                    </button>
                    <button onClick={handleEditCancel} className="btn-sm">
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mark-info" onClick={() => onSelect(mark)}>
                    <div className="mark-name">
                      <span className="label-chip">{mark.label ?? ''}</span>
                      <span className="mark-name-text">{mark.name}</span>
                    </div>

                    <div className="mark-page">
                      Page {mark.page_index + 1}
                      {mark.zoom_hint ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            background: '#e3f2fd',
                            color: '#1976d2',
                            padding: '2px 6px',
                            borderRadius: 3,
                            fontWeight: 500,
                          }}
                        >
                          🔍 {Math.round(mark.zoom_hint * 100)}%
                        </span>
                      ) : (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            background: '#f5f5f5',
                            color: '#666',
                            padding: '2px 6px',
                            borderRadius: 3,
                            fontWeight: 500,
                          }}
                        >
                          🔍 Auto
                        </span>
                      )}
                    </div>

                    {/* Instrument + importance star */}
                    <div
                      style={{
                        fontSize: 11,
                        color: '#555',
                        marginTop: 4,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <span>
                        Instr:&nbsp;
                        <span style={{ fontWeight: 500 }}>{mark.instrument || '—'}</span>
                      </span>
                      <button
                        type="button"
                        title={required ? 'Required measurement' : 'Optional measurement'}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'default',
                          padding: 0,
                          fontSize: 14,
                          color: required ? '#f9a825' : '#ccc',
                        }}
                      >
                        ★
                      </button>
                    </div>
                  </div>

                  <div className="mark-actions">
                    <button
                      onClick={() => onReorder(mark.mark_id!, 'up')}
                      disabled={originalIndex === 0}
                      className="btn-icon"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => onReorder(mark.mark_id!, 'down')}
                      disabled={originalIndex === marks.length - 1}
                      className="btn-icon"
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      onClick={() => handleEditStart(mark)}
                      className="btn-icon"
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => onDuplicate(mark.mark_id!)}
                      className="btn-icon"
                      title="Duplicate"
                    >
                      ⎘
                    </button>
                    <button
                      onClick={() => onDelete(mark.mark_id!)}
                      className="btn-icon btn-danger"
                      title="Delete"
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {filteredMarks.length === 0 && (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: '#999',
              fontSize: 14,
            }}
          >
            {searchQuery ? (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                <div>No marks found</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Try a different search term</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>✏️</div>
                <div>No marks yet</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  Draw rectangles on the PDF to create marks
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  3. PUBLIC WRAPPER – decides which mode to use                      */
/* ------------------------------------------------------------------ */

export default function MarkList(props: CommonProps) {
  const { groups = [] } = props;

  // QC / non-master: show only groups
  if (groups.length > 0) {
    return (
      <GroupSidebar
        groups={groups}
        selectedGroupId={props.selectedGroupId}
        onGroupSelect={props.onGroupSelect}
      />
    );
  }

  // Master mark set: full mark list
  return (
    <MasterMarkList
      marks={props.marks}
      selectedMarkId={props.selectedMarkId}
      onSelect={props.onSelect}
      onUpdate={props.onUpdate}
      onDelete={props.onDelete}
      onDuplicate={props.onDuplicate}
      onReorder={props.onReorder}
    />
  );
}
