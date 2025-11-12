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
};

type MarkListProps = {
  marks: Mark[];
  currentIndex: number;
  onSelect: (index: number) => void;
  entries: Record<string, string>;   // for filled/unfilled status
};

export default function MarkList({ marks, currentIndex, onSelect, entries }: MarkListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const filteredMarks = useMemo(() => {
    if (!searchQuery.trim()) return marks;
    const q = searchQuery.toLowerCase();
    return marks.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.label?.toLowerCase() ?? '').includes(q) ||
      `page ${m.page_index + 1}`.includes(q)
    );
  }, [marks, searchQuery]);

  // Auto-scroll to the active item
  useEffect(() => {
    const el = listRef.current?.querySelector('.mark-item.active') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIndex, filteredMarks.length]);

  const handleClearSearch = () => setSearchQuery('');

  return (
    <div className="mark-list" ref={listRef}>
          {/* Fixed search header inside the sidebar body */}
      <div
        style={{
          position: 'sticky',
          top: 0,                 // stick to the very top of the scroll area
          zIndex: 3,              // above list items
          padding: '10px 12px 8px',
          borderBottom: '1px solid #eee',
          background: '#fff',     // solid background so the list doesn't bleed behind
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
              <span style={{ color: '#1976d2' }}>{filteredMarks.length}</span> of {marks.length} marks
            </>
          ) : (
            <>All Marks ({marks.length})</>
          )}
        </div>
      </div>

      {/* Mark List */}
      <div className="mark-list-items">
        {filteredMarks.map((mark) => {
          const originalIndex = marks.findIndex(m => m.mark_id === mark.mark_id);
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
                background: isActive ? '#E3F2FD' : '#FFFFFF',              // 🔵 keep soft blue for selected, white otherwise
                border: isActive
                  ? '2px solid #1976d2'                                   // 🔵 strong blue ring when active
                  : (isFilled ? '1.5px solid #c5e1a5' : '1.5px solid #E0E0E0'), // ✅ green border if filled, neutral gray if pending
                boxShadow: 'none',
                cursor: 'pointer',
                transition: 'transform 100ms ease, border-color 100ms ease, background 100ms ease'
              }}
              onMouseDown={(e) => { (e.currentTarget.style.transform = 'scale(0.99)'); }}
              onMouseUp={(e) => { (e.currentTarget.style.transform = 'scale(1)'); }}
              onMouseLeave={(e) => { (e.currentTarget.style.transform = 'scale(1)'); }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Left: label bubble (A/B/…) */}
                <div
                  style={{
                    minWidth: 24, height: 24, borderRadius: '50%',
                    border: '2px solid #1976d2', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, background: '#fff', color: '#1976d2', flexShrink: 0
                  }}
                  title="Label"
                >
                  {mark.label ?? '–'}
                </div>

                {/* Middle: name & page */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 4, whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere', lineHeight: 1.25 }}>
                    {mark.name}
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
                    background: isFilled ? '#43A047' : 'transparent'   // ✅ solid green when done
                  }}
                >
                  {isFilled ? (
                    <span style={{ color: '#fff', fontSize: 14, lineHeight: 1 }}>✓</span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}

        {filteredMarks.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: '#999', fontSize: 14 }}>
            {searchQuery ? (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                <div>No marks found</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Try a different search term</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                <div>No marks in this document</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
