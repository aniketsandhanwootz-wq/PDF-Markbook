'use client';

import { useState, useEffect, useRef } from 'react';

type FloatingNameBoxProps = {
  position: { x: number; y: number };
  onSave: (name: string, zoomLevel?: number) => void;
  onCancel: () => void;
};

export default function FloatingNameBox({
  position,
  onSave,
  onCancel,
}: FloatingNameBoxProps) {
  const [name, setName] = useState('');
  const [zoomLevel, setZoomLevel] = useState<number | null>(null); // No default zoom
  const inputRef = useRef<HTMLInputElement>(null);

  const zoomPresets = [
    { label: 'Auto', value: null },
    { label: '100%', value: 1.0 },
    { label: '125%', value: 1.25 },
    { label: '150%', value: 1.5 },
    { label: '175%', value: 1.75 },
    { label: '200%', value: 2.0 },
    { label: '250%', value: 2.5 },
    { label: '300%', value: 3.0 },
  ];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (name.trim()) {
      onSave(name.trim(), zoomLevel ?? undefined);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div
      className="floating-name-box"
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        zIndex: 1000,
      }}
    >
      <div style={{ marginBottom: '12px' }}>
        <label style={{ 
          display: 'block', 
          fontSize: '12px', 
          fontWeight: '500', 
          marginBottom: '6px',
          color: '#666'
        }}>
          Mark Name
        </label>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter mark name..."
          className="name-input"
        />
      </div>

      <div style={{ marginBottom: '12px' }}>
        <label style={{ 
          display: 'block', 
          fontSize: '12px', 
          fontWeight: '500', 
          marginBottom: '6px',
          color: '#666'
        }}>
          Zoom Level (for viewer)
        </label>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(4, 1fr)', 
          gap: '6px' 
        }}>
          {zoomPresets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => setZoomLevel(preset.value)}
              className={`zoom-preset-btn ${zoomLevel === preset.value ? 'active' : ''}`}
              style={{
                padding: '6px 8px',
                fontSize: '12px',
                border: zoomLevel === preset.value ? '2px solid #1976d2' : '1px solid #ddd',
                background: zoomLevel === preset.value ? '#e3f2fd' : 'white',
                color: zoomLevel === preset.value ? '#1976d2' : '#666',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: zoomLevel === preset.value ? '600' : '400',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (zoomLevel !== preset.value) {
                  e.currentTarget.style.background = '#f5f5f5';
                }
              }}
              onMouseLeave={(e) => {
                if (zoomLevel !== preset.value) {
                  e.currentTarget.style.background = 'white';
                }
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div style={{ 
          fontSize: '11px', 
          color: '#999', 
          marginTop: '6px',
          fontStyle: 'italic'
        }}>
          💡 "Auto" will calculate optimal zoom based on mark size
        </div>
      </div>

      <div className="name-actions">
        <button onClick={handleSave} className="btn-save" disabled={!name.trim()}>
          Save
        </button>
        <button onClick={onCancel} className="btn-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}