// apps/editor/lib/labels.ts

export function indexToLabel(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/**
 * ✅ IMPORTANT:
 * This MUST preserve ALL fields on the mark object.
 * Only label is derived from order_index.
 */
export function applyLabels<T extends { order_index: number; label?: string }>(
  marks: T[]
): T[] {
  return marks.map((m) => ({
    ...m, // ✅ preserve instrument, required_value_*, is_required, etc.
    label: m.label ?? indexToLabel(m.order_index),
  }));
}
