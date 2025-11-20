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
          background: '#fff',
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
            background: '#fff',
            borderBottom: '1px solid #eee',
          }}
        >
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              width: 44,
              height: 36,
              borderRadius: 12,
              border: '1px solid #e5e5e5',
              background: '#f8f8f8',
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            <span style={{ display: 'inline-block', transform: 'rotate(90deg)' }}>☰</span>
          </button>
          <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
        </div>

         {/* Body — dedicated scroll area so search stays, list scrolls */}
        <div
          style={{
            flex: 1,
            overflow: 'hidden',          // outer body doesn't scroll
            paddingTop: 0,
            paddingBottom: 12,
            paddingLeft: 12,
            paddingRight: 12,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* This inner div is the scroll container */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              marginTop: 0,
            }}
          >
            {children}
          </div>
        </div>

      </aside>
    </>
  );
}
