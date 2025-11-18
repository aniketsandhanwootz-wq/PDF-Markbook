'use client';

import { useState, useMemo, useRef, useEffect } from 'react';

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
  instrument?: string;   // 👈 add this
};



type MarkListProps = {
  marks: Mark[];
  currentIndex: number;
  onSelect: (index: number) => void;
  entries: Record<string, string>;
  groupsMeta?: Array<{
    group_id: string;
    name: string;
    startIndex: number;
    endIndex: number;
  }>;
};

export default function MarkList({
  marks,
  currentIndex,
  onSelect,
  entries,
  groupsMeta,
}: MarkListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // index lookup to avoid findIndex on every render
  const indexById = useMemo(() => {
    const map: Record<string, number> = {};
    marks.forEach((m, idx) => {
      if (m.mark_id) map[m.mark_id] = idx;
    });
    return map;
  }, [marks]);

  // DSA-wise: build a boolean mask once
  const { filteredMask, filteredCount } = useMemo(() => {
    const mask: boolean[] = new Array(marks.length).fill(true);
    if (!searchQuery.trim()) {
      return { filteredMask: mask, filteredCount: marks.length };
    }

    const q = searchQuery.toLowerCase();
    let count = 0;
    marks.forEach((m, idx) => {
      const match =
        m.name.toLowerCase().includes(q) ||
        (m.label?.toLowerCase() ?? '').includes(q) ||
        (m.instrument?.toLowerCase() ?? '').includes(q) ||
        `page ${m.page_index + 1}`.includes(q);

      mask[idx] = match;
      if (match) count++;
    });
    return { filteredMask: mask, filteredCount: count };
  }, [marks, searchQuery]);

  // Auto-scroll to the active item
  useEffect(() => {
    const el = listRef.current?.querySelector('.mark-item.active') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIndex, marks.length, searchQuery]);

  const handleClearSearch = () => setSearchQuery('');


  return (
    <div className="mark-list" ref={listRef}>
          {/* Sticky search directly under the sidebar header (no top gap) */}
      <div
        style={{
          position: 'sticky',
          top: 0,                 // sits at the very top of the scroll area
          zIndex: 3,
          padding: '0 12px 8px',  // 👈 top padding = 0 so it touches the header
          borderBottom: '1px solid #eee',
          background: '#fff',
        }}
      >
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search marks..."
            style={{
              width: '100%',
              padding: '8px 32px 8px 12px',
              border: '1px solid #ddd',
              borderRadius: 8,
              fontSize: 14,
              outline: 'none',
              background: '#fff',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#1976d2'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#ddd'; }}
          />
          {searchQuery && (
            <button
              onClick={handleClearSearch}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 16,
                color: '#999',
                padding: 4,
                lineHeight: 1,
                width: 24,
                height: 24,
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
              <span style={{ color: '#1976d2' }}>{filteredCount}</span> of {marks.length} marks
            </>
          ) : (
            <>All Marks ({marks.length})</>
          )}
        </div>
      </div>


      {/* Mark List */}
      <div className="mark-list-items">
        {/* Helper to render a single mark button */}
        {(() => {
          const renderMarkItem = (mark: Mark, originalIndex: number) => {
            const isActive = originalIndex === currentIndex;
            const isFilled = !!entries[mark.mark_id || '']?.trim();

            return (
              <button
                key={mark.mark_id || originalIndex}
                className={`mark-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(originalIndex)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  marginBottom: 6,
                  borderRadius: 8,
                  background: isActive ? '#E3F2FD' : '#FFFFFF',
                  border: isActive
                    ? '2px solid #1976d2'
                    : (isFilled ? '1.5px solid #c5e1a5' : '1.5px solid #E0E0E0'),
                  boxShadow: 'none',
                  cursor: 'pointer',
                  transition:
                    'transform 100ms ease, border-color 100ms ease, background 100ms ease',
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = 'scale(0.99)';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Left: label bubble (A/B/…) */}
                  <div
                    style={{
                      minWidth: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: '2px solid #1976d2',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 700,
                      background: '#fff',
                      color: '#1976d2',
                      flexShrink: 0,
                    }}
                    title="Label"
                  >
                    {mark.label ?? '–'}
                  </div>

                  {/* Middle: instrument/name & page */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#333',
                        marginBottom: 4,
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.25,
                      }}
                    >
                      {mark.instrument?.trim() || mark.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      Page {mark.page_index + 1}
                    </div>
                  </div>

                  {/* Right: status circle */}
                  <div
                    title={isFilled ? 'Done' : 'Pending'}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: isFilled ? 'none' : '2px solid #BDBDBD',
                      background: isFilled ? '#43A047' : 'transparent',
                    }}
                  >
                    {isFilled ? (
                      <span style={{ color: '#fff', fontSize: 14, lineHeight: 1 }}>✓</span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          };

          // If we have group metadata -> render grouped
          if (groupsMeta && groupsMeta.length > 0) {
            let anyVisible = false;

            const groupBlocks = groupsMeta.map((g) => {
              let groupHasAny = false;
              const items: JSX.Element[] = [];

              for (let i = g.startIndex; i <= g.endIndex; i++) {
                if (!filteredMask[i]) continue; // filtered out by search
                groupHasAny = true;
                anyVisible = true;
                const mark = marks[i];
                items.push(renderMarkItem(mark, i));
              }

              if (!groupHasAny) return null;

              return (
                <div key={g.group_id} style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: 0.6,
                      color: '#555',
                      margin: '8px 2px',
                    }}
                  >
                    {g.name}
                  </div>
                  {items}
                </div>
              );
            });

            if (!anyVisible) {
              return (
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
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        Try a different search term
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                      <div>No marks in this document</div>
                    </>
                  )}
                </div>
              );
            }

            return groupBlocks;
          }

          // Fallback: flat list
          const flatItems: JSX.Element[] = [];
          marks.forEach((mark, idx) => {
            if (!filteredMask[idx]) return;
            flatItems.push(renderMarkItem(mark, idx));
          });

          if (!flatItems.length) {
            return (
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
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      Try a different search term
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                    <div>No marks in this document</div>
                  </>
                )}
              </div>
            );
          }

          return flatItems;
        })()}
      </div>
    </div>
  );
}
