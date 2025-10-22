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
  currentMarkIndex?: number;
  totalMarks?: number;
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
  currentMarkIndex,
  totalMarks,
}: ZoomToolbarProps) {
  const [pageInput, setPageInput] = useState('');

  useEffect(() => {
    if (currentPage) {
      setPageInput(currentPage.toString());
    }
  }, [currentPage]);

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (/^\d*$/.test(value)) {
      setPageInput(value);
    }
  };

  const handlePageJump = () => {
    if (!onPageJump || !totalPages) return;
    
    const page = parseInt(pageInput);
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
      onPageJump(page);
    } else {
      // Reset to current page if invalid
      setPageInput(currentPage?.toString() || '1');
    }
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
      {/* Mark Navigation Buttons */}
      {onPrev && onNext && (
        <div className="mark-nav">
          <button onClick={onPrev} disabled={!canPrev} className="toolbar-btn">
            ◀ Prev
          </button>
          <button onClick={onNext} disabled={!canNext} className="toolbar-btn">
            Next ▶
          </button>
        </div>
      )}

      {/* Mark Counter */}
      {totalMarks !== undefined && totalMarks > 0 && (
        <div className="mark-counter" style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 16px',
          background: '#f0f7ff',
          borderRadius: '4px',
          fontSize: '14px',
          fontWeight: '600',
          color: '#1976d2',
          border: '1px solid #bde0ff'
        }}>
          <span style={{ marginRight: '4px' }}>📍</span>
          Mark {currentMarkIndex !== undefined && currentMarkIndex >= 0 ? currentMarkIndex + 1 : 0} of {totalMarks}
        </div>
      )}

      {/* Page Navigation Input */}
      {onPageJump && totalPages && (
        <div className="page-nav" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0 12px'
        }}>
          <span style={{ fontSize: '14px', color: '#666', fontWeight: '500' }}>Page</span>
          <input
            type="text"
            value={pageInput}
            onChange={handlePageInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handlePageJump}
            placeholder={currentPage?.toString() || '1'}
            style={{
              width: '50px',
              padding: '6px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              textAlign: 'center',
              fontSize: '14px',
              fontWeight: '500'
            }}
            title="Jump to page (press Enter)"
          />
          <span style={{ fontSize: '14px', color: '#666', fontWeight: '500' }}>/ {totalPages}</span>
        </div>
      )}

      {/* Zoom Controls */}
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
      </div>
    </div>
  );
}