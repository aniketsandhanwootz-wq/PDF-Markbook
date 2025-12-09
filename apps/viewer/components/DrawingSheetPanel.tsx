// apps/viewer/components/DrawingSheetPanel.tsx
'use client';

import type { CSSProperties } from 'react';

type SheetMarkset = {
  mark_set_id: string;
  label: string;
  created_by?: string;
  created_at?: string;
  dwg_num?: string | null;
  pdf_url?: string | null;
};

type DrawingSheetPanelProps = {
  dwgLabel: string;
  marksets: SheetMarkset[];
  onClose: () => void;
  onOpenMarkset: (ms: SheetMarkset) => void;
};

const startBtn: CSSProperties = {
  padding: '8px 18px',
  borderRadius: 7,
  border: '1px solid #3B3B3B',
  background: 'transparent',
  color: '#FFFFFF',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};

export default function DrawingSheetPanel({
  dwgLabel,
  marksets,
  onClose,
  onOpenMarkset,
}: DrawingSheetPanelProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      {/* Dark backdrop – click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          pointerEvents: 'auto',
        }}
      />

      {/* Bottom sheet wrapper */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 860,
            maxHeight: '70vh',
            background: '#1F1F1F',
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            boxShadow: '0 -12px 32px rgba(0,0,0,0.75)',
            padding: 16,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* Header row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
<div>
  <div
    style={{
      fontSize: 16,
      fontWeight: 600,
      color: '#FFFFFF',
      marginTop: 2,
      wordBreak: 'break-word',
    }}
  >
    {dwgLabel}
  </div>
</div>

            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                border: '1px solid #3B3B3B',
                background: '#262626',
                color: '#FFFFFF',
                fontSize: 18,
                lineHeight: 1,
                cursor: 'pointer',
              }}
            >
              ×
            </button>
          </div>

          {/* List of marksets for this drawing */}
          <div
            style={{
              marginTop: 4,
              flex: 1,
              overflowY: 'auto',
              paddingRight: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {marksets.map((ms) => (
              <div
                key={ms.mark_set_id}
                style={{
                  border: '1px solid #3B3B3B',
                  borderRadius: 10,
                  padding: '12px 16px',
                  background: '#262626',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div
                    style={{
                      fontWeight: 600,
                      color: '#FFFFFF',
                      fontSize: 14,
                    }}
                  >
                    {ms.label}
                  </div>
<div
  style={{
    marginTop: 6,
    fontWeight: 400,
    fontSize: 12,
    color: '#C9C9C9',
  }}
>
  {ms.created_by || ''}
</div>

                </div>

                <button
                  style={startBtn}
                  onClick={() => {
                    onOpenMarkset(ms);
                  }}
                >
                  Start
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
