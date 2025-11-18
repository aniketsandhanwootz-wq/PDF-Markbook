'use client';

import { useEffect, useState } from 'react';

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
  let n = idx + 1, s = '';
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
  // --- Keyboard overlap handling (mobile) ------------------------------
  const [kbOverlap, setKbOverlap] = useState(0);    // pixels to lift the panel
  const [vvSupported, setVvSupported] = useState(false);

  // NEW: float only when OUR input is focused (prevents sidebar search from triggering it)
  const [selfFocused, setSelfFocused] = useState(false);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? (window as any).visualViewport : null;
    if (!vv) return;
    setVvSupported(true);

    const update = () => {
      const hidden = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      const safe = (window as any).CSS?.supports?.('padding', 'env(safe-area-inset-bottom)') ? 0 : 8;
      setKbOverlap(hidden + safe);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Float ONLY when our own input has focus
  const floating = vvSupported && kbOverlap > 0 && selfFocused;

  if (!currentMark) {
    return (
      <div
        style={{
          height: '25vh',
          background: '#f5f5f5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: '2px solid #ddd',
        }}
      >
        <p style={{ color: '#666' }}>No marks available</p>
      </div>
    );
  }

  const headingText = currentMark.instrument?.trim() || currentMark.name;
  // 👇 FIX: define displayLabel (prefer mark.label, fallback to A/B/C… from index)
  const displayLabel = currentMark.label ?? indexToLabel(currentIndex);

  return (
    <div
      style={{
        height: 'auto',
        minHeight: 160,
        maxHeight: '32vh',
        background: 'white',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 -2px 10px rgba(0,0,0,0.08)',
        position: floating ? 'fixed' as const : 'static',
        left: floating ? 0 : undefined,
        right: floating ? 0 : undefined,
        bottom: floating ? kbOverlap : undefined,
        zIndex: floating ? 9999 : undefined,
        marginLeft: floating ? 6 : undefined,
        marginRight: floating ? 6 : undefined,
        transform: floating ? 'translateZ(0)' : undefined,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          background: '#1976d2',
          color: 'white',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          columnGap: 10,
          rowGap: 4,
          alignItems: 'center',
          flexShrink: 0,
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
        }}
      >
        <div
          style={{
            minWidth: 28,
            height: 28,
            borderRadius: '50%',
            background: 'white',
            color: '#1976d2',
            fontWeight: 700,
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}
        >
          {displayLabel}
        </div>

        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            textAlign: 'left',
          }}
        >
          {headingText}
        </div>

        <div style={{ fontSize: 12, opacity: 0.9, whiteSpace: 'nowrap', justifySelf: 'end' }}>
          {Math.round(((currentIndex + 1) / totalMarks) * 100)}%
        </div>
      </div>

      {/* Input */}
      <div style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <input
          type="text"
          inputMode="decimal"          // numeric keypad (with decimal) on mobile
          enterKeyHint="next"
          pattern="[0-9]*[.,]?[0-9]*"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type value here..."
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 16,
            border: '2px solid #ddd',
            borderRadius: 8,
            outline: 'none',
            transition: 'border-color 0.2s',
            height: 44,
          }}
          onFocus={(e) => {
            setSelfFocused(true);            // key line
            e.target.style.borderColor = '#1976d2';
          }}
          onBlur={(e) => {
            setSelfFocused(false);           // key line
            e.target.style.borderColor = '#ddd';
          }}
        />
      </div>

      {/* Nav */}
      <div
        style={{
          padding: '4px 10px',
          background: '#f9f9f9',
          borderTop: '1px solid #eee',
          display: 'flex',
          gap: 6,
          flexShrink: 0,
          paddingBottom: floating ? 6 : 'env(safe-area-inset-bottom, 6px)',
        }}
      >
        <button
          onClick={onPrev}
          disabled={!canPrev}
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: 16,
            fontWeight: 700,
            border: '2px solid #ddd',
            background: canPrev ? 'white' : '#f5f5f5',
            color: canPrev ? '#333' : '#999',
            borderRadius: 10,
            cursor: canPrev ? 'pointer' : 'not-allowed',
            minHeight: 44,
            transition: 'all 0.2s',
          }}
        >
          ← Prev
        </button>
        <button
          onClick={onNext}
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: 16,
            fontWeight: 700,
            border: 'none',
            background: '#1976d2',
            color: 'white',
            borderRadius: 10,
            cursor: 'pointer',
            minHeight: 44,
            transition: 'all 0.2s',
          }}
        >
          {currentIndex < totalMarks - 1 ? 'Next →' : '✓ Review'}
        </button>
      </div>
    </div>
  );
}
