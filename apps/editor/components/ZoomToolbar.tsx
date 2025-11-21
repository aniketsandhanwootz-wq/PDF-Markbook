'use client';

import { useState, useEffect } from 'react';

type ZoomToolbarProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  currentPage?: number;
  totalPages?: number;
  onPageJump?: (page: number) => void;

  // Download PDF (Map PDF)
  onFinalize?: () => void;
  onSaveSubmit?: () => void;

  // Enter "group draw" mode (not used in toolbar UI right now)
  onCreateGroup?: () => void;
};

export default function ZoomToolbar({
  zoom,          // kept in props for compatibility (not shown in UI)
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
  onPrev,
  onNext,
  canPrev,
  canNext,
  currentPage,
  totalPages,
  onPageJump,
  onFinalize,
  onSaveSubmit,
  onCreateGroup,
}: ZoomToolbarProps) {
  const [pageInput, setPageInput] = useState('');

  useEffect(() => {
    if (currentPage) setPageInput(String(currentPage));
  }, [currentPage]);

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (/^\d*$/.test(v)) setPageInput(v);
  };

  const handlePageJump = () => {
    if (!onPageJump || !totalPages) return;
    const page = parseInt(pageInput);
    if (!isNaN(page) && page >= 1 && page <= totalPages) onPageJump(page);
    else setPageInput(currentPage?.toString() || '1');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handlePageJump();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPageInput(currentPage?.toString() || '1');
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div
      className="zoom-toolbar"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
      }}
    >
      {/* Center heading */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 14,
          fontWeight: 600,
          color: '#333',
          whiteSpace: 'nowrap',
        }}
      >
        Select a view to create group
      </div>

      {/* Right-side controls: Page nav + Fit + Map PDF */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {onPageJump && totalPages && (
          <div
            className="page-nav"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span style={{ fontSize: 14, color: '#666', fontWeight: 500 }}>
              Page
            </span>
            <input
              type="text"
              value={pageInput}
              onChange={handlePageInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handlePageJump}
              placeholder={currentPage?.toString() || '1'}
              style={{
                width: 50,
                padding: '6px 8px',
                border: '1px solid #ccc',
                borderRadius: 4,
                textAlign: 'center',
                fontSize: 14,
                fontWeight: 500,
              }}
              title="Jump to page (press Enter)"
            />
            <span style={{ fontSize: 14, color: '#666', fontWeight: 500 }}>
              / {totalPages}
            </span>
          </div>
        )}

        <button onClick={onFit} className="toolbar-btn" title="Fit to width">
          Fit
        </button>

        {onFinalize && (
          <button
            onClick={onFinalize}
            className="toolbar-btn toolbar-primary"
            title="Download mapped PDF"
            style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span style={{ fontSize: 14 }}>⬇︎</span>
            <span>Map PDF</span>
          </button>
        )}
      </div>
    </div>
  );
}
