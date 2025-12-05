'use client';

type FloatingHUDProps = {
  // sidebar
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  sidebarDisabled?: boolean;

  // progress (marks)
  currentMarkIndex: number;  // 0-based
  totalMarks: number;        // total marks

  // zoom
  onZoomIn: () => void;
  onZoomOut: () => void;

  // optional review shortcut (only shown after first visit)
  canOpenReview?: boolean;
  onOpenReview?: () => void;
};

export default function FloatingHUD({
  sidebarOpen,
  onSidebarToggle,
  sidebarDisabled = false,
  currentMarkIndex,
  totalMarks,
  onZoomIn,
  onZoomOut,
  canOpenReview,
  onOpenReview,
}: FloatingHUDProps) {
  const showProgress =
    typeof currentMarkIndex === 'number' &&
    typeof totalMarks === 'number' &&
    totalMarks > 0;

return (
  <>
    {/* LEFT: sidebar toggle */}
    <div className="hud-left">
      <button
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        className="hud-btn hud-sidebar-btn"
        onClick={sidebarDisabled ? undefined : onSidebarToggle}
        disabled={sidebarDisabled}
        style={{
          background: '#D99E02',
          border: '1px solid #D99E02',
          color: '#FFFFFF',
          fontSize: 28,
          borderRadius: 10,
          boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: sidebarDisabled ? 0.6 : 1,
          cursor: sidebarDisabled ? 'default' : 'pointer',
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

    {/* RIGHT TOP: progress badge + optional Review button */}
    <div className="hud-right">
      {showProgress && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div
            className="hud-badge"
            aria-label="Current mark progress"
            style={{
              background: '#D99E02',
              color: '#FFFFFF',
              borderRadius: 10,
              border: '1px solid #D99E02',
              fontWeight: 600,
              paddingInline: 10,
            }}
          >
            {currentMarkIndex + 1}/{totalMarks}
          </div>

          {canOpenReview && onOpenReview && (
            <button
              type="button"
              onClick={onOpenReview}
              className="hud-btn hud-review-btn"
              style={{
         //       padding: '4px 10px',
                borderRadius: 10,
                border: '1px solid #3B3B3B',
                background: '#262626',
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                opacity: sidebarDisabled ? 0.7 : 1,
                whiteSpace: 'nowrap',
              }}
              title="Go to review screen"
            >
              Review
            </button>
          )}
        </div>
      )}
    </div>


{/* BOTTOM RIGHT: zoom buttons – + on top, − below, just above input panel */}
    <div className="hud-bottom-zoom">
      <button
        className="hud-btn hud-btn-zoom"
        onClick={onZoomIn}
        aria-label="Zoom in"
        title="Zoom in"
      >
        <img
          src="/icons/icons8-zoom-in-50.png"
          alt="Zoom in"
          style={{
            width: 26,
            height: 26,
            display: 'block',
          }}
        />
      </button>

      <button
        className="hud-btn hud-btn-zoom"
        onClick={onZoomOut}
        aria-label="Zoom out"
        title="Zoom out"
      >
        <img
          src="/icons/icons8-zoom-out-50.png"
          alt="Zoom out"
          style={{
            width: 26,
            height: 26,
            display: 'block',
          }}
        />
      </button>
    </div>
  </>
);
}