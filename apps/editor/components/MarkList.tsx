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

  const handleEditStart = (mark: Mark) => {
    setEditingId(mark.mark_id || null);
    setEditName(mark.name);
  };

  const handleEditSave = (markId: string) => {
    if (editName.trim()) {
      onUpdate(markId, { name: editName.trim() });
    }
    setEditingId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditName('');
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
                    <div className="mark-page">Page {mark.page_index + 1}</div>
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