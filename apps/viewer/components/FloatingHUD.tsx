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
          style={{
            background: '#D99E02',           // bright yellow pill
            border: '1px solid #D99E02',     // slightly darker yellow border
            color: '#FFFFFF',                // dark text/icon color
            fontSize: 28,
            borderRadius: 10,              // full pill shape
            boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
          }}
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
          <div className="hud-badge"
            aria-label="Current mark progress"
            style={{
              background: '#D99E02',        // same yellow as buttons
              color: '#FFFFFF',             // dark text for contrast
              borderRadius: 10,           // pill chip
              border: '1px solid #D99E02',
              fontWeight: 600,              // thoda bold digits
            }}>
            {currentMarkIndex + 1}/{totalMarks}
          </div>
        )}

        <div className="hud-zoomstack">
          <button className="hud-btn" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in"
          style={{
              background: '#D99E02',        // yellow button
              border: '1px solid #D99E02',
              color: '#FFFFFF',             // dark emoji/text
              borderRadius: 10,           // pill shape
              boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
            }}>
            🔍+
          </button>
          <button className="hud-btn" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out"
          style={{
              background: '#D99E02',        // yellow button
              border: '1px solid #D99E02',
              color: '#FFFFFF',             // dark emoji/text
              borderRadius: 10,           // pill shape
              boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
            }}>
            🔍−
          </button>
        </div>
      </div>
    </>
  );
}
