'use client';

import { useState } from 'react';

type Mark = {
  mark_id?: string;
  name: string;
};

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
};

export default function ReviewScreen({
  marks,
  entries,
  onBack,
  onSubmit,
  isSubmitting,
}: ReviewScreenProps) {
  const completedCount = Object.values(entries).filter(v => v.trim() !== '').length;
  const allFilled = completedCount === marks.length;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'white',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        background: '#1976d2',
        color: 'white',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: '600' }}>
          📋 Review Your Entries
        </h2>
        <p style={{ margin: '4px 0 0 0', fontSize: '14px', opacity: 0.9 }}>
          Check all values before submitting
        </p>
      </div>

      {/* Progress Summary */}
      <div style={{
        padding: '16px',
        background: allFilled ? '#e8f5e9' : '#fff3e0',
        borderBottom: '1px solid #ddd'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px'
        }}>
          <div style={{ fontSize: '16px', fontWeight: '600', color: '#333' }}>
            Progress: {completedCount} / {marks.length} marks
          </div>
          <div style={{
            fontSize: '24px',
            fontWeight: '700',
            color: allFilled ? '#4caf50' : '#ff9800'
          }}>
            {Math.round((completedCount / marks.length) * 100)}%
          </div>
        </div>
        <div style={{
          height: '8px',
          background: '#e0e0e0',
          borderRadius: '4px',
          overflow: 'hidden'
        }}>
          <div style={{
            height: '100%',
            background: allFilled ? '#4caf50' : '#ff9800',
            width: `${(completedCount / marks.length) * 100}%`,
            transition: 'width 0.3s'
          }} />
        </div>
      </div>

      {/* Entries List */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px'
      }}>
        {marks.map((mark, idx) => {
          const value = entries[mark.mark_id || ''] || '';
          const isFilled = value.trim() !== '';

          return (
            <div
              key={mark.mark_id || idx}
              style={{
                marginBottom: '12px',
                padding: '12px',
                background: isFilled ? '#f1f8e9' : '#ffebee',
                border: `2px solid ${isFilled ? '#c5e1a5' : '#ffcdd2'}`,
                borderRadius: '8px'
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px'
              }}>
                <div style={{
                  fontSize: '20px',
                  minWidth: '24px'
                }}>
                  {isFilled ? '✓' : '⚠️'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    color: '#333',
                    marginBottom: '4px'
                  }}>
                    {idx + 1}. {mark.name}
                  </div>
                  {isFilled ? (
                    <div style={{
                      fontSize: '14px',
                      color: '#666',
                      padding: '8px',
                      background: 'white',
                      borderRadius: '4px',
                      wordBreak: 'break-word'
                    }}>
                      {value}
                    </div>
                  ) : (
                    <div style={{
                      fontSize: '13px',
                      color: '#d32f2f',
                      fontStyle: 'italic'
                    }}>
                      Missing - Please fill this mark
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Warning Message */}
      {!allFilled && (
        <div style={{
          padding: '12px 16px',
          background: '#fff3e0',
          borderTop: '1px solid #ffb74d',
          color: '#e65100',
          fontSize: '14px',
          fontWeight: '500'
        }}>
          ⚠️ Please fill all {marks.length - completedCount} missing mark(s) before submitting
        </div>
      )}

      {/* Action Buttons */}
      <div style={{
        padding: '16px',
        background: '#f9f9f9',
        borderTop: '2px solid #ddd',
        display: 'flex',
        gap: '12px'
      }}>
        <button
          onClick={onBack}
          disabled={isSubmitting}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: '600',
            border: '2px solid #ddd',
            background: 'white',
            color: '#333',
            borderRadius: '8px',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            minHeight: '44px'
          }}
        >
          ← Go Back
        </button>
        <button
          onClick={onSubmit}
          disabled={!allFilled || isSubmitting}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: '600',
            border: 'none',
            background: !allFilled || isSubmitting ? '#ccc' : '#4caf50',
            color: 'white',
            borderRadius: '8px',
            cursor: !allFilled || isSubmitting ? 'not-allowed' : 'pointer',
            minHeight: '44px'
          }}
        >
          {isSubmitting ? '⏳ Submitting...' : '✓ Submit All'}
        </button>
      </div>
    </div>
  );
}