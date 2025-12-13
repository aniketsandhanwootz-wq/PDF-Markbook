'use client';

type DraftResumeDialogProps = {
  updatedAt?: number;
  onResume: () => void;
  onDiscard: () => void;
};

export default function DraftResumeDialog({
  updatedAt,
  onResume,
  onDiscard,
}: DraftResumeDialogProps) {
  const lastSaved =
    typeof updatedAt === 'number'
      ? new Date(updatedAt).toLocaleString()
      : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          margin: '0 auto 16px',
          padding: '16px 16px 12px',
          borderRadius: 14,
          background: '#111827',
          boxShadow: '0 18px 45px rgba(0,0,0,0.7)',
          border: '1px solid #374151',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: '#F9FAFB',
              marginBottom: 4,
            }}
          >
            Resume previous inspection?
          </div>
          <div
            style={{
              fontSize: 13,
              color: '#D1D5DB',
              lineHeight: 1.4,
            }}
          >
            We found unsent QC data for this drawing on this device.
            You can continue where you left off, or start a fresh inspection.
          </div>
          {lastSaved && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: '#9CA3AF',
              }}
            >
              Last saved: {lastSaved}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 10,
          }}
        >
          <button
            type="button"
            onClick={onDiscard}
            style={{
              flex: 1,
              padding: '9px 10px',
              borderRadius: 999,
              border: '1px solid #4B5563',
              background: '#111827',
              color: '#E5E7EB',
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Start fresh
          </button>
          <button
            type="button"
            onClick={onResume}
            style={{
              flex: 1,
              padding: '9px 10px',
              borderRadius: 999,
              border: 'none',
              background: '#D99E02',
              color: '#111827',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Resume where I left
          </button>
        </div>
      </div>
    </div>
  );
}
