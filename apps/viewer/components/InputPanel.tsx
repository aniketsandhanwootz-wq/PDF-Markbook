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
  label?: string; // ✅ add this
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
function indexToLabel(idx: number): string {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

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
  // ✅ Prefer DB label; fallback to deterministic index-based label
  const displayLabel = (currentMark.label?.trim() || indexToLabel(currentIndex));

  return (
    <div style={{
  height: 'auto',
  minHeight: '160px',
  maxHeight: '32vh',
  background: 'white',
  borderTop: '2px solid #ddd',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0
}}>
      {/* Compressed Header */}
      <div style={{
        padding: '8px 12px',
        background: '#1976d2',
        color: 'white',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        flexShrink: 0
      }}>
       <div style={{
  fontSize: '15px',
  fontWeight: '700',
  whiteSpace: 'nowrap',
  letterSpacing: '0.5px'
}}>
  {displayLabel}
</div>
<div
  style={{
    fontSize: '15px',
    fontWeight: '600',
    flex: 1,
    overflow: 'hidden',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    textAlign: 'center',
    lineHeight: '1.25',
  }}
>
  {currentMark.name}
</div>

        <div style={{ 
          fontSize: '12px', 
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
  padding: '10px 12px',
  fontSize: '16px',
  border: '2px solid #ddd',
  borderRadius: '8px',
  outline: 'none',
  transition: 'border-color 0.2s',
  height: '44px'
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
  padding: '8px 12px',
  fontSize: '16px',
  fontWeight: '700',
  border: '2px solid #ddd',
  background: canPrev ? 'white' : '#f5f5f5',
  color: canPrev ? '#333' : '#999',
  borderRadius: '10px',
  cursor: canPrev ? 'pointer' : 'not-allowed',
  minHeight: '44px',
  transition: 'all 0.2s'
}}
        >
          ← Prev
        </button>
        <button
          onClick={onNext}
          style={{
  flex: 1,
  padding: '8px 12px',
  fontSize: '16px',
  fontWeight: '700',
  border: 'none',
  background: '#1976d2',
  color: 'white',
  borderRadius: '10px',
  cursor: 'pointer',
  minHeight: '44px',
  transition: 'all 0.2s'
}}
        >
          {currentIndex < totalMarks - 1 ? 'Next →' : '✓ Review'}
        </button>
      </div>
    </div>
  );
}