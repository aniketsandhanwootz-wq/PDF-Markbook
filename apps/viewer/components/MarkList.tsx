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
  entries: Record<string, string>;   // ✅ NEW — for filled/unfilled coloring
};


export default function MarkList({ marks, currentIndex, onSelect, entries }: MarkListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Filter marks based on search query
  const filteredMarks = useMemo(() => {
    if (!searchQuery.trim()) return marks;
    const query = searchQuery.toLowerCase();
    return marks.filter(mark =>
      mark.name.toLowerCase().includes(query) ||
      (mark.label?.toLowerCase() ?? '').includes(query) ||
      `page ${mark.page_index + 1}`.includes(query)
    );
  }, [marks, searchQuery]);

  // 🔽 Auto-scroll to the active item whenever selection changes (Task-3)
  useEffect(() => {
    const el = listRef.current?.querySelector('.mark-item.active') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIndex, filteredMarks.length]);

  const handleClearSearch = () => setSearchQuery('');

  return (
    <div className="mark-list" ref={listRef}>
      {/* Sticky search header */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        padding: '12px',
        borderBottom: '1px solid #eee',
        background: '#fafafa'
      }}>
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
              borderRadius: '4px',
              fontSize: '14px',
              outline: 'none'
            }}
            onFocus={(e) => { e.target.style.borderColor = '#1976d2'; }}
            onBlur={(e) => { e.target.style.borderColor = '#ddd'; }}
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
                justifyContent: 'center'
              }}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <div style={{
          fontSize: '12px',
          color: '#666',
          marginTop: '8px',
          fontWeight: '500'
        }}>
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
      background: entries[mark.mark_id || '']?.trim()
        ? '#f1f8e9'  // ✅ green (filled)
        : '#ffebee', // ❌ red (missing)
      border: entries[mark.mark_id || '']?.trim()
        ? '2px solid #c5e1a5'
        : '2px solid #ffcdd2',
      boxShadow: isActive ? 'inset 0 0 0 2px #1976d2' : 'none', // keep active blue
      cursor: 'pointer',
      transition: 'transform 100ms ease, box-shadow 100ms ease',
    }}
    onMouseDown={(e) => { (e.currentTarget.style.transform = 'scale(0.99)'); }}
    onMouseUp={(e) => { (e.currentTarget.style.transform = 'scale(1)'); }}
    onMouseLeave={(e) => { (e.currentTarget.style.transform = 'scale(1)'); }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
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
          {mark.name}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>
          Page {mark.page_index + 1}
        </div>
      </div>
    </div>
  </button>
);
        })}

        {filteredMarks.length === 0 && (
          <div style={{
            padding: '32px 20px',
            textAlign: 'center',
            color: '#999',
            fontSize: '14px'
          }}>
            {searchQuery ? (
              <>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔍</div>
                <div>No marks found</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>
                  Try a different search term
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📋</div>
                <div>No marks in this document</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
