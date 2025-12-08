'use client';

type Mark = {
  mark_id?: string;
  name: string;
  label?: string;
};

type MarkStatus = 'PASS' | 'FAIL' | 'DOUBT' | '';

const STATUS_STYLE: Record<MarkStatus, { label: string; color: string }> = {
  PASS:  { label: 'PASS',  color: '#16a34a' },  // green
  FAIL:  { label: 'FAIL',  color: '#dc2626' },  // red
  DOUBT: { label: 'DOUBT', color: '#ca8a04' },  // yellow-ish
  '':    { label: 'NA',    color: '#6b7280' },  // grey
};

function renderStatusText(status: MarkStatus | undefined) {
  const key: MarkStatus = (status ?? '') as MarkStatus;
  const s = STATUS_STYLE[key] ?? STATUS_STYLE[''];

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${s.color}`,  // thin colored outline
        color: s.color,                  // 🔴 text color carries the meaning
        background: 'transparent',       // ✅ neutral background
        letterSpacing: 0.3,
      }}
    >
      {s.label}
    </span>
  );
}

type Entry = {
  mark_id: string;
  value: string;
};

type ReviewScreenProps = {
  marks: Mark[];
  entries: Record<string, string>;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  /** called when a review row is clicked */
  onJumpTo: (index: number) => void;
  /** Optional PASS / FAIL / DOUBT status per mark_id */
  statusByMarkId?: Record<string, 'PASS' | 'FAIL' | 'DOUBT' | ''>;
};


export default function ReviewScreen({
  marks,
  entries,
  onBack,
  onSubmit,
  isSubmitting,
  onJumpTo,
  statusByMarkId,
}: ReviewScreenProps) {
  const completedCount = Object.values(entries).filter((v) => v.trim() !== '').length;
  const allFilled = marks.length > 0 && completedCount === marks.length;
  const pct = marks.length ? Math.round((completedCount / marks.length) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: '#171717',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px',
          background: '#171717',
          color: '#FFFFFF',
          boxShadow: '0 2px 4px #9D9D9D',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700 }}>Review Your Entries</h2>
        <p style={{ margin: '4px 0 0 0', fontSize: '14px', opacity: 0.9 }}>
          Check all values before submitting
        </p>
      </div>

      {/* Progress Summary */}
      <div
        style={{
          padding: '16px',
          background: allFilled ? '#1F1F1F' : '#1F1F1F',
          borderBottom: '1px solid #C9C9C9',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#9D9D9D' }}>
            Progress: {completedCount} / {marks.length} marks
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, color: allFilled ? '#4caf50' : '#D99E02' }}>
            {pct}%
          </div>
        </div>
        <div
          style={{
            height: '8px',
            background: '#1F1F1F',
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              background: allFilled ? '#4caf50' : '#D99E02',
              width: `${marks.length ? (completedCount / marks.length) * 100 : 0}%`,
              transition: 'width 0.3s',
            }}
          />
        </div>
      </div>

      {/* Entries List */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
          pointerEvents: isSubmitting ? 'none' : 'auto',
          opacity: isSubmitting ? 0.7 : 1,
        }}
        aria-busy={isSubmitting}
      >
{marks.map((mark, idx) => {
  const value = entries[mark.mark_id || ''] || '';
  const isFilled = value.trim() !== '';

  const status = (statusByMarkId?.[mark.mark_id || ''] ?? '') as MarkStatus;

          return (
            <div
              key={mark.mark_id || idx}
              onClick={() => {
                if (!isSubmitting) onJumpTo(idx);
              }}
              role="button"
              tabIndex={isSubmitting ? -1 : 0}
              aria-disabled={isSubmitting}
              onKeyDown={(e) => {
                if (!isSubmitting && (e.key === 'Enter' || e.key === ' ')) onJumpTo(idx);
              }}
              style={{
                display: 'flex',                 // <<< icon left + content
                alignItems: 'flex-start',
                gap: '10px',
                marginBottom: '12px',
                padding: '12px',
                background: '#171717',
                border: '1px solid #3B3B3B',        // <<< neutral, no red/green border
                borderRadius: '8px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                userSelect: 'none',
                transition: 'transform 120ms ease, box-shadow 120ms ease',
              }}
              onMouseDown={(e) => {
                if (!isSubmitting) e.currentTarget.style.transform = 'scale(0.995)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {/* Left status icon only (no row border color) */}
              <div
                style={{
                  minWidth: '24px',
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  border: `2px solid ${isFilled ? '#4caf50' : '#EF4345'}`,
                  background: isFilled ? '#4caf50' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 2,
                }}
                aria-hidden="true"
              >
                {isFilled ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#EF4345"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                )}
              </div>

              {/* Content */}
              {/* Content */}
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: '4px',
                  }}
                >
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: '#FFFFFF',
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                      lineHeight: '1.25',
                    }}
                  >
                    <span style={{ opacity: 0.85 }}>{mark.label ?? '–'}.</span> {mark.name}
                  </div>

                  {renderStatusText(status)}
                </div>

                {isFilled ? (
                  <div
                    style={{
                      fontSize: '14px',
                      color: '#C9C9C9',
                      padding: '8px',
                      background: '#1F1F1F',
                      borderRadius: '4px',
                      wordBreak: 'break-word',
                    }}
                  >
                    {value}
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: '13px',
                      color: '#EF4345',
                      fontStyle: 'italic',
                    }}
                  >
                    Missing - Please fill this balloon
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Warning Message */}
      {!allFilled && (
        <div
          style={{
            padding: '12px 16px',
            background: '#1F1F1F',
            borderTop: '1px solid #1F1F1F',
            color: '#FFB5B6',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          ⚠️ {Math.max(0, marks.length - completedCount)} balloon(s) are still empty.
          You can submit now or go back to fill them.
        </div>

      )}

      {/* Action Buttons */}
      <div
        style={{
          padding: '16px',
          background: '#1F1F1F',
          borderTop: '2px solid #C9C9C9',
          display: 'flex',
          gap: '12px',
        }}
      >
        <button
          onClick={onBack}
          disabled={isSubmitting}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: 600,
            border: '2px solid #3B3B3B',
            background: '#1F1F1F',
            color: '#FFFFFF',
            borderRadius: '8px',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            minHeight: '44px',
          }}
        >
          ← Go Back
        </button>
        <button
          onClick={onSubmit}
          disabled={isSubmitting}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: 600,
            border: 'none',
            background: isSubmitting ? '#d6bc74ff' : '#D99E02',
            color: '#FFFFFF',
            borderRadius: '8px',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            minHeight: '44px',
            opacity: isSubmitting ? 0.7 : 1,
            transition: 'background 0.2s, opacity 0.2s',
          }}
        >
          {isSubmitting ? '⏳ Submitting...' : '✓ Submit All'}
        </button>
      </div>
    </div>
  );
}
