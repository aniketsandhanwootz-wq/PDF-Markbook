'use client';

import { ReactNode, useEffect } from 'react';

type SlideSidebarProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number; // px
  children: ReactNode;
};

export default function SlideSidebar({
  open,
  onClose,
  title = 'Marks',
  width = 280,
  children,
}: SlideSidebarProps) {
  // optional: lock background scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.25)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 150ms ease',
          zIndex: 9997,
        }}
      />

      {/* Slide-over panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          top: 0,
          bottom: 0,
          left: 0,
          width,
          maxWidth: '86vw',
          background: '#171717',
          boxShadow: '2px 0 18px rgba(0,0,0,0.2)',
          transform: open ? 'translateX(0)' : 'translateX(-105%)',
          transition: 'transform 200ms ease',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 9998,
        }}
      >
        {/* Header (sticky) */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',     // header padding
            background: '#1F1F1F',
            borderBottom: '1px solid #3B3B3B',
          }}
        >
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              width: 44,
              height: 36,
              borderRadius: 10,
              border: '1px solid #D99E02',
              background: '#D99E02',
              fontSize: 20,
              lineHeight: 1,
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ display: 'inline-block', transform: 'rotate(90deg)' }}>☰</span>
          </button>
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              color: '#C9C9C9',   // <-- dark bg par off-white text
              fontWeight: 600,
            }}
          >
            {title}
          </h3>
        </div>

        {/* Body — children (e.g. MarkList) are responsible for scroll */}
        <div
          style={{
            flex: 1,
            paddingTop: 0,
            paddingBottom: 12,
            paddingLeft: 12,
            paddingRight: 12,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden', // prevent side bleed, let child manage its own scroll
          }}
        >
          {children}
        </div>


      </aside>
    </>
  );
}
