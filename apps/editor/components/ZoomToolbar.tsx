'use client';

type ZoomToolbarProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
};

export default function ZoomToolbar({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
}: ZoomToolbarProps) {
  return (
    <div className="zoom-toolbar">
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