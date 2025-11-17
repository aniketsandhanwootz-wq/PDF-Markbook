'use client';

import React from 'react';

type Mark = {
  mark_id: string;
  name: string;          // still in type, but not shown in UI
  label?: string;
  instrument?: string;
  page_index: number;
  order_index: number;
};

type Group = {
  group_id: string;
  name: string;
  page_index: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  mark_ids: string[];
};

type MarkListProps = {
  marks: Mark[];
  groups: Group[];
  selectedMarkId: string | null;
  selectedGroupId: string | null;
  onSelect: (mark: Mark) => void;
  onGroupSelect?: (group: Group) => void;
  onGroupEdit?: (group: Group) => void;
  onUpdate: (markId: string, updates: Partial<Mark>) => void;
  onDelete: (markId: string) => void;
  onDuplicate: (markId: string) => void;
  onReorder: (markId: string, dir: 'up' | 'down') => void;
};


const iconBtn: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 11,
  cursor: 'pointer',
  background: '#fff',
};

export default function MarkList({
  marks,
  groups,
  selectedMarkId,
  selectedGroupId,
  onSelect,
  onGroupSelect,
  onGroupEdit,
  onUpdate,
  onDelete,
  onDuplicate,
  onReorder,
}: MarkListProps) {
  // =========================
  // MASTER MODE (no groups)
  // =========================
  if (!groups || groups.length === 0) {
    const sorted = [...marks].sort((a, b) => a.order_index - b.order_index);

    return (
      <div
        className="mark-list"
        style={{ padding: '8px 10px', overflowY: 'auto', maxHeight: '100%' }}
      >
        {sorted.length === 0 && (
          <div style={{ fontSize: 13, color: '#777', padding: '8px 4px' }}>
            No marks yet. Draw on the PDF to create marks.
          </div>
        )}

        {sorted.map((m) => {
          const isSelected = selectedMarkId === m.mark_id;
          return (
            <div
              key={m.mark_id}
              className="mark-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 8px',
                marginBottom: 4,
                borderRadius: 4,
                cursor: 'pointer',
                background: isSelected ? '#e3f2fd' : 'transparent',
              }}
              onClick={() => onSelect(m)}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      minWidth: 22,
                      height: 22,
                      borderRadius: 999,
                      border: '1px solid #000',
                      fontSize: 12,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {m.label || '—'}
                  </span>
                  {/* Name is not shown in UI anymore */}
                </div>
                <div style={{ fontSize: 11, color: '#666' }}>
                  Page {m.page_index + 1}
                  {m.instrument ? ` · Instrument: ${m.instrument}` : ''}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  title="Move up"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReorder(m.mark_id, 'up');
                  }}
                  style={iconBtn}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReorder(m.mark_id, 'down');
                  }}
                  style={iconBtn}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Duplicate"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicate(m.mark_id);
                  }}
                  style={iconBtn}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(m.mark_id);
                  }}
                  style={{ ...iconBtn, color: '#c62828' }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // =========================
  // QC MODE (groups present)
  // =========================

  // Map mark_id → mark for quick lookup
  const markById = new Map(marks.map((m) => [m.mark_id, m]));

  // For each group, marks are in exact mark_ids order
  const groupsWithMarks = groups.map((g) => {
    const gmarks = (g.mark_ids || [])
      .map((id) => markById.get(id))
      .filter(Boolean) as Mark[];
    return { group: g, marks: gmarks };
  });

  return (
    <div
      className="mark-list"
      style={{ padding: '8px 10px', overflowY: 'auto', maxHeight: '100%' }}
    >
      {groupsWithMarks.length === 0 && (
        <div style={{ fontSize: 13, color: '#777', padding: '8px 4px' }}>
          No groups yet. Use “Create Group” and draw on the PDF.
        </div>
      )}

      {groupsWithMarks.map(({ group, marks: gmarks }) => {
        const isGroupSelected = selectedGroupId === group.group_id;

        return (
          <div key={group.group_id} style={{ marginBottom: 10 }}>
            {/* Group header */}
            <div
              onClick={() => onGroupSelect && onGroupSelect(group)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 4,
                background: isGroupSelected ? '#d1e9ff' : '#f5f5f5',
                cursor: onGroupSelect ? 'pointer' : 'default',
                border: isGroupSelected
                  ? '1px solid #1976d2'
                  : '1px solid #eee',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <span>{group.name || `Group p${group.page_index + 1}`}</span>
                {onGroupEdit && (
                  <button
                    type="button"
                    title="Edit group"
                    onClick={(e) => {
                      e.stopPropagation();
                      onGroupEdit(group);
                    }}
                    style={{
                      border: '1px solid #ccc',
                      borderRadius: 4,
                      padding: '0 4px',
                      fontSize: 11,
                      cursor: 'pointer',
                      background: '#fff',
                    }}
                  >
                    ✏️
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#666' }}>
                Page {group.page_index + 1} · {gmarks.length} mark
                {gmarks.length !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Marks inside this group */}
            {gmarks.length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: '#999',
                  padding: '4px 10px 2px',
                }}
              >
                No marks selected for this group yet.
              </div>
            )}

            {gmarks.map((m) => {
              const isSelected = selectedMarkId === m.mark_id;
              return (
                <div
                  key={m.mark_id}
                  className="mark-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '5px 8px 5px 18px',
                    marginTop: 2,
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: isSelected ? '#e3f2fd' : 'transparent',
                  }}
                  onClick={() => onSelect(m)}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 20,
                          height: 20,
                          borderRadius: 999,
                          border: '1px solid #000',
                          fontSize: 11,
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {m.label || '—'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#666' }}>
                      {m.instrument
                        ? `Instrument: ${m.instrument}`
                        : 'No instrument set'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 4 }}>
                    {/* No up/down here to avoid global reordering impacts */}
                    <button
                      type="button"
                      title="Duplicate"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDuplicate(m.mark_id);
                      }}
                      style={iconBtn}
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(m.mark_id);
                      }}
                      style={{ ...iconBtn, color: '#c62828' }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
