'use client';

import { useEffect, useState, useRef } from 'react';
import type { PointerEvent } from 'react';


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

type SlideToActProps = {
  label: string;
  onComplete: () => void;
};

function SlideToAct({ label, onComplete }: SlideToActProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const maxXRef = useRef(0);

  const KNOB_SIZE = 40;
  const PADDING = 4;

  const clamp = (val: number, min: number, max: number) =>
    Math.min(max, Math.max(min, val));

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    maxXRef.current = rect.width - KNOB_SIZE - PADDING * 2;
    startXRef.current = e.clientX;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const delta = e.clientX - startXRef.current;
    setDragX((prev) => clamp(prev + delta, 0, maxXRef.current));
    startXRef.current = e.clientX;
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

    const threshold = maxXRef.current * 0.7;
    if (dragX >= threshold) {
      // Snap to end, fire complete, then reset for next time
      setDragX(maxXRef.current);
      onComplete();
      // slight delay so user sees it reach the end
      setTimeout(() => setDragX(0), 220);
    } else {
      // snap back
      setDragX(0);
    }
  };

  const filledWidth = dragX + KNOB_SIZE + PADDING;

  return (
    <div
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'relative',
        width: '100%',
        height: 48,
        borderRadius: 24,
        background: '#e3f2fd',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        touchAction: 'pan-y',
        userSelect: 'none',
      }}
    >
      {/* Progress fill under text */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: filledWidth,
          background: '#1976d233',
          transition: isDragging ? 'none' : 'width 0.2s ease',
        }}
      />

      {/* Label */}
      <span
        style={{
          position: 'relative',
          zIndex: 1,
          fontSize: 14,
          fontWeight: 600,
          color: '#0d47a1',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>

      {/* Knob */}
      <div
        style={{
          position: 'absolute',
          left: PADDING + dragX,
          top: PADDING,
          width: KNOB_SIZE,
          height: KNOB_SIZE,
          borderRadius: '50%',
          background: '#ffffff',
          boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2,
          transition: isDragging ? 'none' : 'left 0.2s ease',
        }}
      >
        <span style={{ fontSize: 20, color: '#1976d2' }}>➜</span>
      </div>
    </div>
  );
}

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

  /**
   * 'mark'  – normal mark-by-mark mode (current behaviour)
   * 'group' – group overview mode (show full group, slide to enter marks)
   */
  mode?: 'mark' | 'group';

  /** Display name of the current group (for header in group mode) */
  groupName?: string;

  /** Short text like "Instrument: Vernier caliper, Depth gauge" for this group */
  groupInstrumentSummary?: string;

  /**
   * If true and mode==='group', shows the slide-to-act button
   * instead of Next/Prev.
   */
  showGroupSlide?: boolean;

  /** Custom label for slide action (defaults to "Slide to start this group") */
  groupSlideLabel?: string;

  /** Called when user successfully slides all the way (proceed to group marks) */
  onGroupSlideComplete?: () => void;
};


function indexToLabel(idx: number): string {
  let n = idx + 1,
    s = '';
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
  mode = 'mark',
  groupName,
  groupInstrumentSummary,
  showGroupSlide,
  groupSlideLabel,
  onGroupSlideComplete,
}: InputPanelProps) {

  // --- Keyboard overlap handling (mobile) ------------------------------
  const [kbOverlap, setKbOverlap] = useState(0); // pixels to lift the panel
  const [vvSupported, setVvSupported] = useState(false);

  // Float only when OUR input is focused
  const [selfFocused, setSelfFocused] = useState(false);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? (window as any).visualViewport : null;
    if (!vv) return;
    setVvSupported(true);

    const update = () => {
      const hidden = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      const safe = (window as any).CSS?.supports?.('padding', 'env(safe-area-inset-bottom)')
        ? 0
        : 8;
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

   const floating = vvSupported && kbOverlap > 0 && selfFocused;
  const isGroupMode = mode === 'group';

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

  const baseHeading = currentMark.instrument?.trim() || currentMark.name;
  const headingText = isGroupMode ? groupName || baseHeading : baseHeading;
  const displayLabel = currentMark.label ?? indexToLabel(currentIndex);

  // 👇 group vs mark specific header pieces – SAFE now
  const showMarkBadge = !isGroupMode;
  const showRequiredIcon =
    !isGroupMode && currentMark.is_required !== false;


  return (
    <div
      id="mobile-input-panel"
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
        position: floating ? ('fixed' as const) : 'static',
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
                        // 👇 hide completely in group mode but keep layout grid stable
            opacity: showMarkBadge ? 1 : 0,
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
            textAlign: 'center',
            justifySelf: 'center',
          }}
        >
          {headingText}
        </div>


               <div
          style={{
            fontSize: 18,
            whiteSpace: 'nowrap',
            justifySelf: 'end',
            color: showRequiredIcon ? '#EF4345' : 'transparent',
            opacity: showRequiredIcon ? 0.95 : 0,
            pointerEvents: 'none',
          }}
        >
          ⓘ
        </div>


      </div>

      {/* Input / Group description */}
      {isGroupMode ? (
        <div
          style={{
            padding: '8px 12px 6px',
            fontSize: 13,
            color: '#555',
            lineHeight: 1.4,
          }}
        >
          <div>
            Identify the above view and Position yourself accordingly.
          </div>
          {groupInstrumentSummary && (
            <div style={{ marginTop: 4, color: '#333' }}>
              <strong>Instrument:</strong> {groupInstrumentSummary}
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: '4px 10px',
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <input
            type="text"
            inputMode="decimal"
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
              setSelfFocused(true);
              e.target.style.borderColor = '#1976d2';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = '#ddd';
              setTimeout(() => {
                setSelfFocused(false);
              }, 80);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onNext();
              }
            }}
          />
        </div>
      )}

      {/* Nav / Slide action */}
      {isGroupMode && showGroupSlide && onGroupSlideComplete ? (
        <div
          style={{
            padding: '8px 10px',
            background: '#f9f9f9',
            borderTop: '1px solid #eee',
            flexShrink: 0,
            paddingBottom: floating ? 6 : 'env(safe-area-inset-bottom, 6px)',
          }}
        >
          <SlideToAct
            label={groupSlideLabel || 'Slide to start this group'}
            onComplete={onGroupSlideComplete}
          />
        </div>
      ) : (
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
      )}
    </div>
  );
}
