// apps/viewer/lib/search.worker.ts
// Build a token -> Set<pageNumber> map. No glyph geometry in worker.

type BuildMsg = { type: 'build'; page: number; text: string };
type QueryMsg = { type: 'query'; q: string };
type ClearMsg = { type: 'clear' };

const index: Map<string, Set<number>> = new Map();

function tokenize(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function addToIndex(page: number, text: string) {
  const toks = tokenize(text);
  for (const t of toks) {
    if (!index.has(t)) index.set(t, new Set<number>());
    index.get(t)!.add(page);
  }
}

self.onmessage = (ev: MessageEvent<BuildMsg | QueryMsg | ClearMsg>) => {
  const msg = ev.data;
  if (msg.type === 'build') {
    addToIndex(msg.page, msg.text || '');
    (self as any).postMessage({ type: 'built', page: msg.page });
    return;
  }

  if (msg.type === 'query') {
    const toks = tokenize(msg.q || '');
    if (toks.length === 0) {
      (self as any).postMessage({ type: 'result', pages: [] });
      return;
    }

    // AND across tokens with explicit typing (avoid TS inferring never)
    let pages: Set<number> | null = null;

    for (const t of toks) {
      const s = index.get(t);
      if (!s) { pages = new Set<number>(); break; }

      if (pages) {
        const inter = new Set<number>();
        for (const p of pages) {
          if (s.has(p)) inter.add(p);
        }
        pages = inter;
      } else {
        pages = new Set<number>(s);
      }

      if (pages.size === 0) break;
    }

    (self as any).postMessage({ type: 'result', pages: Array.from(pages ?? []) });
    return;
  }

  if (msg.type === 'clear') {
    index.clear();
    (self as any).postMessage({ type: 'cleared' });
    return;
  }
};
