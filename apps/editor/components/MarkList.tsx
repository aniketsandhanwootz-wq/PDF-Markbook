'use client';

import { useState } from 'react';

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

type MarkListProps = {
  marks: Mark[];
  selectedMarkId: string | null;
  onSelect: (mark: Mark) => void;
  onUpdate: (markId: string, updates: Partial<Mark>) => void;
  onDelete: (markId: string) => void;
  onDuplicate: (markId: string) => void;
  onReorder: (markId: string, direction: 'up' | 'down') => void;
};

export default function MarkList({
  marks,
  selectedMarkId,
  onSelect,
  onUpdate,
  onDelete,
  onDuplicate,
  onReorder,
}: MarkListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editZoom, setEditZoom] = useState<number>(1.5);

  const zoomPresets = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

  const handleEditStart = (mark: Mark) => {
    setEditingId(mark.mark_id || null);
    setEditName(mark.name);
    setEditZoom(mark.zoom_hint || 1.5);
  };

  const handleEditSave = (markId: string) => {
    if (editName.trim()) {
      onUpdate(markId, { name: editName.trim(), zoom_hint: editZoom });
    }
    setEditingId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditName('');
    setEditZoom(1.5);
  };

  return (
    <div className="mark-list">
      <div className="mark-list-header">All Marks ({marks.length})</div>
      <div className="mark-list-items">
        {marks.map((mark, index) => {
          const isEditing = editingId === mark.mark_id;
          const isSelected = selectedMarkId === mark.mark_id;

          return (
            <div
              key={mark.mark_id || index}
              className={`mark-item ${isSelected ? 'selected' : ''}`}
            >
              {isEditing ? (
                <div className="mark-edit">
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ 
                      fontSize: '11px', 
                      color: '#666', 
                      display: 'block',
                      marginBottom: '4px' 
                    }}>
                      Name
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleEditSave(mark.mark_id!);
                        if (e.key === 'Escape') handleEditCancel();
                      }}
                      autoFocus
                      className="mark-edit-input"
                    />
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ 
                      fontSize: '11px', 
                      color: '#666', 
                      display: 'block',
                      marginBottom: '4px' 
                    }}>
                      Zoom Level
                    </label>
                    <div style={{ 
                      display: 'flex', 
                      gap: '4px', 
                      flexWrap: 'wrap' 
                    }}>
                      {zoomPresets.map((preset) => (
                        <button
                          key={preset}
                          onClick={() => setEditZoom(preset)}
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            border: editZoom === preset ? '2px solid #1976d2' : '1px solid #ddd',
                            background: editZoom === preset ? '#e3f2fd' : 'white',
                            color: editZoom === preset ? '#1976d2' : '#666',
                            borderRadius: '3px',
                            cursor: 'pointer',
                            fontWeight: editZoom === preset ? '600' : '400',
                          }}
                        >
                          {Math.round(preset * 100)}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mark-edit-actions">
                    <button onClick={() => handleEditSave(mark.mark_id!)} className="btn-sm">
                      ✓
                    </button>
                    <button onClick={handleEditCancel} className="btn-sm">
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mark-info" onClick={() => onSelect(mark)}>
                    <div className="mark-name">{mark.name}</div>
                    <div className="mark-page">
                      Page {mark.page_index + 1}
                      {mark.zoom_hint && (
                        <span style={{ 
                          marginLeft: '8px', 
                          fontSize: '11px',
                          background: '#e3f2fd',
                          color: '#1976d2',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontWeight: '500'
                        }}>
                          🔍 {Math.round(mark.zoom_hint * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mark-actions">
                    <button
                      onClick={() => onReorder(mark.mark_id!, 'up')}
                      disabled={index === 0}
                      className="btn-icon"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => onReorder(mark.mark_id!, 'down')}
                      disabled={index === marks.length - 1}
                      className="btn-icon"
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      onClick={() => handleEditStart(mark)}
                      className="btn-icon"
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => onDuplicate(mark.mark_id!)}
                      className="btn-icon"
                      title="Duplicate"
                    >
                      ⎘
                    </button>
                    <button
                      onClick={() => onDelete(mark.mark_id!)}
                      className="btn-icon btn-danger"
                      title="Delete"
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
        {marks.length === 0 && (
          <div className="mark-list-empty">
            Draw rectangles on the PDF to create marks
          </div>
        )}
      </div>
    </div>
  );
}