'use client';

import { useState, useMemo } from 'react';

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
};

export default function MarkList({ marks, currentIndex, onSelect }: MarkListProps) {
  const [searchQuery, setSearchQuery] = useState('');

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

  const handleClearSearch = () => {
    setSearchQuery('');
  };

  return (
    <div className="mark-list">
      {/* Search Input */}
      <div style={{ 
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
            onFocus={(e) => {
              e.target.style.borderColor = '#1976d2';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = '#ddd';
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
  const isActive = originalIndex === currentIndex; // ✅ add this
  return (
    <button
  key={mark.mark_id || originalIndex}
  className={`mark-item ${originalIndex === currentIndex ? 'active' : ''}`}
  onClick={() => onSelect(originalIndex)}
>
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    {/* ✅ Label badge from DB */}
    <div
  style={{
    minWidth: 22,
    height: 22,
    borderRadius: '50%',
    border: `2px solid ${isActive ? '#ffffff' : '#dddddd'}`, // ✅ white ring on blue
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    background: '#ffffff',          // ✅ keep white pill
    color: '#1976d2',               // ✅ force blue text so it shows on active row
    lineHeight: 1
  }}
  title="Label"
>
  {mark.label ?? '–'}
</div>


    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="mark-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {mark.name}
      </div>
      <div className="mark-page">Page {mark.page_index + 1}</div>
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