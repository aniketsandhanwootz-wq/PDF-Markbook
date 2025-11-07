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

  // 🔁 was onFinalize; keep the prop name but clarify its purpose at call-site
  onFinalize?: () => void;        // Download PDF
  onSaveSubmit?: () => void;      // Save to backend, go back, show notice
};

export default function ZoomToolbar({
  zoom,
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
    <div className="zoom-toolbar">
      {/* Page Jump */}
      {onPageJump && totalPages && (
        <div
          className="page-nav"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}
        >
          <span style={{ fontSize: 14, color: '#666', fontWeight: 500 }}>Page</span>
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
          <span style={{ fontSize: 14, color: '#666', fontWeight: 500 }}>/ {totalPages}</span>
        </div>
      )}

      {/* Zoom + Actions */}
      <div className="zoom-controls">
        <button onClick={onZoomOut} className="toolbar-btn" title="Zoom out">
          −
        </button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button onClick={onZoomIn} className="toolbar-btn" title="Zoom in">
          +
        </button>
        <button onClick={onReset} className="toolbar-btn" title="Reset zoom (100%)">
          Reset
        </button>
        <button onClick={onFit} className="toolbar-btn" title="Fit to width">
          Fit
        </button>

        {/* Primary actions on the RIGHT */}
        {onFinalize && (
          <button
            onClick={onFinalize}
            className="toolbar-btn toolbar-primary"
            title="Download PDF"
            style={{ marginLeft: 8 }}
          >
            Download PDF
          </button>
        )}

        {onSaveSubmit && (
          <button
            onClick={onSaveSubmit}
            className="toolbar-btn"
            title="Save marks, submit and go back"
            style={{ marginLeft: 8, borderColor: '#2e7d32', color: '#2e7d32', fontWeight: 700 }}
          >
            Save &amp; Submit
          </button>
        )}
      </div>
    </div>
  );
}
