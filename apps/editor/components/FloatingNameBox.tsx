'use client';

import { useState, useEffect, useRef } from 'react';

type FloatingNameBoxProps = {
  position: { x: number; y: number };
  onSave: (name: string) => void;
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
    inputRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (name.trim()) {
      onSave(name.trim());
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
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Mark name..."
        className="name-input"
      />
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