'use client';

import { useState, useEffect } from 'react';

type Mark = {
  mark_id?: string;
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  zoom_hint?: number | null;
};

type InputPanelProps = {
  currentMark: Mark | null;
  currentIndex: number;
  totalMarks: number;
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  canNext: boolean;
  canPrev: boolean;
};

export default function InputPanel({
  currentMark,
  currentIndex,
  totalMarks,
  value,
  onChange,
  onNext,
  onPrev,
  canNext,
  canPrev,
}: InputPanelProps) {
  if (!currentMark) {
    return (
      <div style={{
        height: '25vh',
        background: '#f5f5f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderTop: '2px solid #ddd'
      }}>
        <p style={{ color: '#666' }}>No marks available</p>
      </div>
    );
  }

  return (
    <div style={{
      height: '25vh',
      background: 'white',
      borderTop: '2px solid #ddd',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      {/* Progress Header */}
      <div style={{
        padding: '12px 16px',
        background: '#1976d2',
        color: 'white',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ fontSize: '14px', fontWeight: '600' }}>
          Mark {currentIndex + 1} of {totalMarks}
        </div>
        <div style={{ fontSize: '12px', opacity: 0.9 }}>
          {Math.round(((currentIndex + 1) / totalMarks) * 100)}% Complete
        </div>
      </div>

      {/* Mark Name */}
      <div style={{
        padding: '12px 16px',
        background: '#f9f9f9',
        borderBottom: '1px solid #eee'
      }}>
        <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
          Mark Name:
        </div>
        <div style={{ fontSize: '16px', fontWeight: '600', color: '#333' }}>
          {currentMark.name}
        </div>
      </div>

      {/* Input Field */}
      <div style={{
        flex: 1,
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}>
        <label style={{
          fontSize: '14px',
          fontWeight: '500',
          color: '#333'
        }}>
          Enter Value:
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type value here..."
          autoFocus
          style={{
            width: '100%',
            padding: '12px',
            fontSize: '16px',
            border: '2px solid #ddd',
            borderRadius: '8px',
            outline: 'none',
            transition: 'border-color 0.2s'
          }}
          onFocus={(e) => {
            e.target.style.borderColor = '#1976d2';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = '#ddd';
          }}
        />
        <div style={{ fontSize: '12px', color: '#999' }}>
          💡 Tip: You can skip and come back later
        </div>
      </div>

      {/* Navigation Buttons */}
      <div style={{
        padding: '12px 16px',
        background: '#f9f9f9',
        borderTop: '1px solid #eee',
        display: 'flex',
        gap: '12px'
      }}>
        <button
          onClick={onPrev}
          disabled={!canPrev}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: '600',
            border: '2px solid #ddd',
            background: canPrev ? 'white' : '#f5f5f5',
            color: canPrev ? '#333' : '#999',
            borderRadius: '8px',
            cursor: canPrev ? 'pointer' : 'not-allowed',
            minHeight: '44px',
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            if (canPrev) {
              e.currentTarget.style.background = '#f0f0f0';
            }
          }}
          onMouseLeave={(e) => {
            if (canPrev) {
              e.currentTarget.style.background = 'white';
            }
          }}
        >
          ← Previous
        </button>
        <button
          onClick={onNext}
          style={{
            flex: 1,
            padding: '14px',
            fontSize: '16px',
            fontWeight: '600',
            border: 'none',
            background: '#1976d2',
            color: 'white',
            borderRadius: '8px',
            cursor: 'pointer',
            minHeight: '44px',
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#1565c0';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#1976d2';
          }}
        >
          {currentIndex < totalMarks - 1 ? 'Next →' : '✓ Review & Submit'}
        </button>
      </div>
    </div>
  );
}