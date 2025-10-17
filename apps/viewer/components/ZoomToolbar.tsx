'use client';

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
}: ZoomToolbarProps) {
  return (
    <div className="zoom-toolbar">
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

      <div className="zoom-controls">
        <button onClick={onZoomOut} className="toolbar-btn">
          −
        </button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button onClick={onZoomIn} className="toolbar-btn">
          +
        </button>
        <button onClick={onReset} className="toolbar-btn">
          Reset
        </button>
        <button onClick={onFit} className="toolbar-btn">
          Fit
        </button>
      </div>
    </div>
  );
}