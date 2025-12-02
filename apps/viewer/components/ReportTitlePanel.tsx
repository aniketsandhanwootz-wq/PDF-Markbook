// apps/viewer/components/ReportTitlePanel.tsx
'use client';

import { useEffect, useState } from 'react';

type ReportTitlePanelProps = {
  value: string;
  onChange: (next: string) => void;
  onConfirm: () => void;
  reportId: string;
};

export default function ReportTitlePanel({
  value,
  onChange,
  onConfirm,
  reportId,
}: ReportTitlePanelProps) {
  const [kbOverlap, setKbOverlap] = useState(0);
  const [vvSupported, setVvSupported] = useState(false);
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
  const trimmed = value.trim();
  const canContinue = trimmed.length > 0;

  return (
    <div
      id="report-title-panel"
      style={{
        height: 'auto',
        minHeight: 160,
        maxHeight: '32vh',
        background: '#1F1F1F',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        overflow: 'visible',  // 🔹 CHANGED: allow scroll to work while title is showing
        boxShadow: '0 -2px 10px rgba(0,0,0,0.08)',
        position: floating ? ('fixed' as const) : 'static',
        left: floating ? 0 : undefined,
        right: floating ? 0 : undefined,
        bottom: floating ? kbOverlap : undefined,
        zIndex: floating ? 9999 : undefined,
        marginLeft: floating ? 6 : undefined,
        marginRight: floating ? 6 : undefined,
        transform: floating ? 'translateZ(0)' : undefined,
        pointerEvents: 'none',  // 🔹 NEW: don't block PDF scroll behind
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          background: '#343434',
          color: '#FFFFFF',
          display: 'grid',
          gridTemplateColumns: '1fr',
          rowGap: 4,
          alignItems: 'center',
          flexShrink: 0,
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
          textAlign: 'center',
          pointerEvents: 'auto',  // 🔹 NEW: re-enable for interactive content

        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          Enter Report Title
        </div>
  {/*       <div
          style={{
            fontSize: 11,
            color: '#D0D0D0',
            marginTop: 2,
          }}
        >
          Report ID:&nbsp;
          <span style={{ fontFamily: 'monospace' }}>{reportId}</span>
        </div>  Input */}
      </div>

      {/* Input */}
      <div
        style={{
          padding: '8px 10px 4px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flexShrink: 0,
          pointerEvents: 'auto',  // 🔹 NEW
        }}
      >
        <input
          type="text"
          inputMode="text"
          enterKeyHint="done"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. FA02 REVA - QC Report #1"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 16,
            border: '2px solid #3B3B3B',
            borderRadius: 8,
            outline: 'none',
            transition: 'border-color 0.2s',
            height: 44,
            background: '#1F1F1F',
            color: '#FFFFFF',
          }}
          onFocus={(e) => {
            setSelfFocused(true);
            e.target.style.borderColor = '#D99E02';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = '#3B3B3B';
            setTimeout(() => setSelfFocused(false), 80);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canContinue) {
              e.preventDefault();
              onConfirm();
            }
          }}
        />
        <div
          style={{
            fontSize: 11,
            color: '#9D9D9D',
          }}
        >
          This title will be stored with the inspection and used in reports / Excel.
        </div>
      </div>

      {/* Action */}
      <div
        style={{
          padding: '4px 10px',
          background: '#1F1F1F',
          borderTop: '1px solid #3B3B3B',
          display: 'flex',
          gap: 6,
          flexShrink: 0,
          paddingBottom: floating ? 6 : 'env(safe-area-inset-bottom, 6px)',
          pointerEvents: 'auto',  // 🔹 NEW
        }}
      >
        <button
          onClick={onConfirm}
          disabled={!canContinue}
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: 16,
            fontWeight: 700,
            border: 'none',
            background: canContinue ? '#D99E02' : '#3B3B3B',
            color: '#FFFFFF',
            borderRadius: 10,
            cursor: canContinue ? 'pointer' : 'not-allowed',
            minHeight: 44,
            transition: 'all 0.2s',
          }}
        >
          Start Marking
        </button>
      </div>
    </div>
  );
}
