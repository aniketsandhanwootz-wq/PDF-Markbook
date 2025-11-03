'use client';

import { ReactNode } from 'react';

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
  return (
    <>
      {/* Scrim */}
      <div
        className={`slide-scrim ${open ? 'show' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <aside
        className={`slide-sidebar ${open ? 'open' : ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="slide-sidebar__header">
          <button
            onClick={onClose}
            className="hud-btn hud-sidebar-btn"
            title="Close"
            aria-label="Close"
          >
            <span style={{ display: 'inline-block', transform: 'rotate(90deg)' }}>☰</span>
          </button>
          <h3 className="slide-sidebar__title">{title}</h3>
        </div>

        <div className="slide-sidebar__body">
          {children}
        </div>
      </aside>
    </>
  );
}
