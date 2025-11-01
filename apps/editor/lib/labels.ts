// apps/editor/lib/labels.ts
export function indexToLabel(idx: number): string {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function applyLabels<T extends { order_index: number; label?: string }>(marks: T[]): T[] {
  // Assign labels based on order_index (stable)
  const sorted = [...marks].sort((a, b) => a.order_index - b.order_index);
  const map = new Map<string | number, string>();
  sorted.forEach((m, i) => map.set(`${m.order_index}`, indexToLabel(i)));
  return marks.map(m => ({ ...m, label: map.get(`${m.order_index}`)! }));
}
