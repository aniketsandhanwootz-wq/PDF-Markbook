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
  // Sidebar toggle props
  showSidebarToggle?: boolean;
  sidebarOpen?: boolean;
  onSidebarToggle?: () => void;
    /** make bar transparent/floating when true (viewer will pass this) */
  transparent?: boolean;              // <-- add this line
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
  showSidebarToggle,
  sidebarOpen,
  onSidebarToggle,
  transparent,  
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
    const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    background: '#fff',
    borderBottom: '1px solid #ddd',
    gap: '8px',
    flexWrap: 'nowrap',
    minHeight: '36px'
  };

  const rootStyle: React.CSSProperties = transparent
    ? {
        ...baseStyle,
        background: 'transparent',
        borderBottom: 'none',
        boxShadow: 'none',
        padding: '6px 10px',
      }
    : baseStyle;
  return (
    <div style={rootStyle}>

      {/* Left Section: Sidebar Toggle + Mark Navigation */}
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
        {/* Sidebar Toggle - Only show when closed */}
        {showSidebarToggle && !sidebarOpen && onSidebarToggle && (
          <button
            onClick={onSidebarToggle}
            style={{
              padding: '4px 8px',
              border: '1px solid #ccc',
              background: '#fff',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px',
              minHeight: '28px',
              minWidth: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title="Open sidebar"
          >
            ☰
          </button>
        )}
        
        {/* Mark Navigation Buttons */}
        {onPrev && onNext && (
          <>
            <button 
              onClick={onPrev} 
              disabled={!canPrev} 
              style={{
                padding: '4px 10px',
                border: '1px solid #ccc',
                background: '#fff',
                borderRadius: '4px',
                cursor: canPrev ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                minHeight: '28px',
                opacity: canPrev ? 1 : 0.4
              }}
            >
              ◀ Prev
            </button>
            <button 
              onClick={onNext} 
              disabled={!canNext}
              style={{
                padding: '4px 10px',
                border: '1px solid #ccc',
                background: '#fff',
                borderRadius: '4px',
                cursor: canNext ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                minHeight: '28px',
                opacity: canNext ? 1 : 0.4
              }}
            >
              Next ▶
            </button>
          </>
        )}
      </div>

      {/* Center Section: Page Navigation */}
      {onPageJump && totalPages && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '12px',
          flexShrink: 0
        }}>
          <span style={{ color: '#666' }}>Page</span>
          <input
            type="text"
            value={pageInput}
            onChange={handlePageInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handlePageJump}
            style={{
              width: '35px',
              padding: '2px 4px',
              border: '1px solid #ccc',
              borderRadius: '3px',
              textAlign: 'center',
              fontSize: '12px'
            }}
          />
          <span style={{ color: '#666' }}>/ {totalPages}</span>
        </div>
      )}

      {/* Right Section: Zoom Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
        <button 
          onClick={onZoomOut}
          style={{
            padding: '2px 8px',
            border: '1px solid #ccc',
            background: '#fff',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '14px',
            minHeight: '26px'
          }}
        >
          −
        </button>
        <span style={{ 
          fontSize: '12px', 
          fontWeight: '500', 
          minWidth: '45px', 
          textAlign: 'center' 
        }}>
          {Math.round(zoom * 100)}%
        </span>
        <button 
          onClick={onZoomIn}
          style={{
            padding: '2px 8px',
            border: '1px solid #ccc',
            background: '#fff',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '14px',
            minHeight: '26px'
          }}
        >
          +
        </button>
        <button 
          onClick={onReset}
          style={{
            padding: '2px 8px',
            border: '1px solid #ccc',
            background: '#fff',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            minHeight: '26px'
          }}
        >
          Reset
        </button>
        <button 
          onClick={onFit}
          style={{
            padding: '2px 8px',
            border: '1px solid #ccc',
            background: '#fff',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            minHeight: '26px'
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}