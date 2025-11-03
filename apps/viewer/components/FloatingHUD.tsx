'use client';

type FloatingHUDProps = {
  // sidebar
  sidebarOpen: boolean;
  onSidebarToggle: () => void;

  // progress (marks)
  currentMarkIndex: number;  // 0-based
  totalMarks: number;        // total marks

  // zoom
  onZoomIn: () => void;
  onZoomOut: () => void;
};

export default function FloatingHUD({
  sidebarOpen,
  onSidebarToggle,
  currentMarkIndex,
  totalMarks,
  onZoomIn,
  onZoomOut,
}: FloatingHUDProps) {
  const showProgress =
    typeof currentMarkIndex === 'number' &&
    typeof totalMarks === 'number' &&
    totalMarks > 0;

  return (
    <>
      {/* LEFT: floating sidebar toggle (same icon for open/close) */}
      <div className="hud-left">
        <button
          aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          className="hud-btn hud-sidebar-btn"
          onClick={onSidebarToggle}
        >
          <span
            style={{
              display: 'inline-block',
              transform: sidebarOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms',
            }}
          >
            ☰
          </span>
        </button>
      </div>

      {/* RIGHT: progress badge + zoom buttons */}
      <div className="hud-right">
        {showProgress && (
          <div className="hud-badge" aria-label="Current mark progress">
            {currentMarkIndex + 1}/{totalMarks}
          </div>
        )}

        <div className="hud-zoomstack">
          <button className="hud-btn" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
            🔍+
          </button>
          <button className="hud-btn" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
            🔍−
          </button>
        </div>
      </div>
    </>
  );
}
