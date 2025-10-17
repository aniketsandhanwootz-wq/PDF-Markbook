'use client';

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
  currentIndex: number;
  onSelect: (index: number) => void;
};

export default function MarkList({ marks, currentIndex, onSelect }: MarkListProps) {
  return (
    <div className="mark-list">
      <div className="mark-list-header">
        All Marks ({marks.length})
      </div>
      <div className="mark-list-items">
        {marks.map((mark, index) => (
          <button
            key={mark.mark_id || index}
            className={`mark-item ${index === currentIndex ? 'active' : ''}`}
            onClick={() => onSelect(index)}
          >
            <div className="mark-name">{mark.name}</div>
            <div className="mark-page">Page {mark.page_index + 1}</div>
          </button>
        ))}
      </div>
    </div>
  );
}