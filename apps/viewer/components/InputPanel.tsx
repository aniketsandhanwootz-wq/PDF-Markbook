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
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  borderTopLeftRadius: '12px',
  borderTopRightRadius: '12px',
  overflow: 'hidden',                             // ⬅️ clips inner square edges
  boxShadow: '0 -2px 10px rgba(0,0,0,0.08)'      // subtle elevation
}}>

      {/* Compressed Header */}
 {/* Header with circle label + wrapping title + progress */}
<div style={{
  padding: '10px 14px',
  background: '#1976d2',
  color: 'white',
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',  // label | title | progress
  columnGap: '10px',
  rowGap: '4px',
  alignItems: 'center',
  flexShrink: 0,
  borderTopLeftRadius: '12px',
  borderTopRightRadius: '12px',
}}>
  {/* Label Circle */}
  <div style={{
    minWidth: '28px',
    height: '28px',
    borderRadius: '50%',
    background: 'white',
    color: '#1976d2',
    fontWeight: '700',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
  }}>
    {displayLabel}
  </div>

  {/* Mark Name (wraps over multiple lines) */}
  <div style={{
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: 1.25,
    whiteSpace: 'normal',         // ✅ allow wrapping
    overflowWrap: 'anywhere',     // ✅ break long tokens
    wordBreak: 'break-word',      // ✅ fallback
    textAlign: 'left',
  }}>
    {currentMark.name}
  </div>

  {/* Progress */}
  <div style={{
    fontSize: '12px',
    opacity: 0.9,
    whiteSpace: 'nowrap',
    justifySelf: 'end',
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
  // ❌ remove: autoFocus
  ref={(el) => {
    // only focus if user has interacted (clicked manually)
    if (el && document.activeElement === el) return;
  }}
  style={{
    width: '100%',
    padding: '10px 12px',
    fontSize: '16px',
    border: '2px solid #ddd',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.2s',
    height: '44px',
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