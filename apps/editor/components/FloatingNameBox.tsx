'use client';

import { useState, useEffect, useRef } from 'react';

type FloatingNameBoxProps = {
  position: { x: number; y: number };
  onSave: (name: string) => void;   // 👈 no zoom argument anymore
  onCancel: () => void;
};

export default function FloatingNameBox({
  position,
  onSave,
  onCancel,
}: FloatingNameBoxProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSave = () => {
    // allow blank names (labels will show in the UI)
    onSave(name.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className="floating-name-box"
      style={{ position: 'absolute', left: position.x, top: position.y, zIndex: 1000 }}
    >
      <div style={{ marginBottom: '12px' }}>
        <label
          style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px', color: '#666' }}
        >
          Mark Name
        </label>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter mark name (optional)..."
          className="name-input"
        />
      </div>

      <div className="name-actions">
        <button onClick={handleSave} className="btn-save">{/* 👈 not disabled anymore */}
          Save
        </button>
        <button onClick={onCancel} className="btn-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
