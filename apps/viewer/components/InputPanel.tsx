'use client';

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
};

type InputPanelProps = {
  currentMark: Mark | null;
  currentIndex: number;
  totalMarks: number;
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  canNext: boolean;
  canPrev: boolean;
};

export default function InputPanel({
  currentMark,
  currentIndex,
  totalMarks,
  value,
  onChange,
  onNext,
  onPrev,
  canNext,
  canPrev,
}: InputPanelProps) {
  if (!currentMark) {
    return (
      <div style={{
        height: '25vh',
        background: '#f5f5f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderTop: '2px solid #ddd'
      }}>
        <p style={{ color: '#666' }}>No marks available</p>
      </div>
    );
  }

  return (
    <div style={{
  height: 'auto',
  minHeight: '120px',
  maxHeight: '25vh',
  background: 'white',
  borderTop: '2px solid #ddd',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0
}}>
      {/* Compressed Header */}
      <div style={{
        padding: '6px 10px',
        background: '#1976d2',
        color: 'white',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        flexShrink: 0
      }}>
        <div style={{ 
          fontSize: '12px', 
          fontWeight: '600',
          whiteSpace: 'nowrap'
        }}>
          {currentIndex + 1}/{totalMarks}
        </div>
        <div style={{ 
          fontSize: '13px', 
          fontWeight: '600',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'center'
        }}>
          {currentMark.name}
        </div>
        <div style={{ 
          fontSize: '11px', 
          opacity: 0.9,
          whiteSpace: 'nowrap'
        }}>
          {Math.round(((currentIndex + 1) / totalMarks) * 100)}%
        </div>
      </div>

  {/* Compact Input Field */}
      <div style={{
        padding: '4px 10px',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0
      }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type value here..."
          autoFocus
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: '16px',
            border: '2px solid #ddd',
            borderRadius: '4px',
            outline: 'none',
            transition: 'border-color 0.2s',
            height: '36px'
          }}
          onFocus={(e) => {
            e.target.style.borderColor = '#1976d2';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = '#ddd';
          }}
        />
      </div>

      {/* Navigation Buttons */}
      <div style={{
        padding: '4px 10px',
        background: '#f9f9f9',
        borderTop: '1px solid #eee',
        display: 'flex',
        gap: '6px',
        flexShrink: 0
      }}>
        <button
          onClick={onPrev}
          disabled={!canPrev}
          style={{
            flex: 1,
            padding: '4px',
            fontSize: '14px',
            fontWeight: '600',
            border: '2px solid #ddd',
            background: canPrev ? 'white' : '#f5f5f5',
            color: canPrev ? '#333' : '#999',
            borderRadius: '6px',
            cursor: canPrev ? 'pointer' : 'not-allowed',
            minHeight: '36px',
            transition: 'all 0.2s'
          }}
        >
          ← Prev
        </button>
        <button
          onClick={onNext}
          style={{
            flex: 1,
            padding: '4px',
            fontSize: '14px',
            fontWeight: '600',
            border: 'none',
            background: '#1976d2',
            color: 'white',
            borderRadius: '6px',
            cursor: 'pointer',
            minHeight: '36px',
            transition: 'all 0.2s'
          }}
        >
          {currentIndex < totalMarks - 1 ? 'Next →' : '✓ Review'}
        </button>
      </div>
    </div>
  );
}