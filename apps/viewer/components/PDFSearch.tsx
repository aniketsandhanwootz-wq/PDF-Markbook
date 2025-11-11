'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// @ts-ignore - web worker import via bundler URL
const makeWorker = () => new Worker(new URL('../lib/search.worker.ts', import.meta.url), { type: 'module' });

type SearchResult = {
  pageNumber: number;
  index: number;
  text: string;
  items: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

type PDFSearchProps = {
  pdf: PDFDocumentProxy | null;
  isOpen: boolean;
  onClose: () => void;
  onResultFound?: (pageNumber: number, highlights: SearchResult['items']) => void;
};

export default function PDFSearch({ pdf, isOpen, onClose, onResultFound }: PDFSearchProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const [indexedPages, setIndexedPages] = useState<Set<number>>(new Set());
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Build lightweight text index (per page) when opened
useEffect(() => {
  if (!isOpen || !pdf) return;

  if (!workerRef.current) {
    workerRef.current = makeWorker();
  }

  const w = workerRef.current;
  const onMsg = (e: MessageEvent) => {
    const data = e.data;
    if (data?.type === 'built') {
      setIndexedPages(prev => new Set(prev).add(data.page));
    }
  };
  w.addEventListener('message', onMsg);

  (async () => {
    const n = pdf.numPages;
    for (let p = 1; p <= n; p++) {
      if (indexedPages.has(p)) continue;
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      // Join strings only (no glyph geometry here)
      const text = tc.items.map((it: any) => ('str' in it ? it.str : '')).join(' ');
      w.postMessage({ type: 'build', page: p, text });
      // small yield
      await new Promise(r => setTimeout(r, 0));
    }
  })();

  return () => { w.removeEventListener('message', onMsg); };
}, [isOpen, pdf]);

  const performSearch = useCallback(async () => {
  if (!pdf || !searchQuery.trim()) {
    setSearchResults([]);
    setCurrentResultIndex(-1);
    onResultFound?.(1, []);
    return;
  }

  setIsSearching(true);
  const w = workerRef.current ?? makeWorker();
  workerRef.current = w;

  const candidatePages: number[] = await new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'result') {
        w.removeEventListener('message', handler);
        resolve(e.data.pages as number[]);
      }
    };
    w.addEventListener('message', handler);
    w.postMessage({ type: 'query', q: searchQuery });
  });

  // Fallback to full scan if index not built yet
  const pagesToSearch = candidatePages.length ? candidatePages.sort((a,b)=>a-b) : [...Array(pdf.numPages)].map((_,i)=>i+1);

  const results: SearchResult[] = [];
  const q = searchQuery.toLowerCase();

  for (const pageNum of pagesToSearch) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });

    let fullText = '';
    const charPositions: Array<{ char: string; x: number; y: number; width: number; height: number; }> = [];

    for (const item of textContent.items) {
      if ('str' in item) {
        const t = item.transform;
        const fontSize = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
        const x0 = t[4];
        const y0 = viewport.height - t[5];
        const widthPerChar = item.width / Math.max(1, item.str.length);

        for (let i = 0; i < item.str.length; i++) {
          const cx = x0 + i * widthPerChar;
          charPositions.push({ char: item.str[i], x: cx, y: y0 - fontSize, width: widthPerChar, height: fontSize });
          fullText += item.str[i];
        }
        fullText += ' ';
        charPositions.push({ char: ' ', x: x0 + item.width, y: y0 - fontSize, width: 5, height: fontSize });
      }
    }

    const lowerText = fullText.toLowerCase();
    let startIndex = 0;
    while (true) {
      const idx = lowerText.indexOf(q, startIndex);
      if (idx === -1) break;

      const match = charPositions.slice(idx, idx + q.length);
      const rects: SearchResult['items'] = [];
      if (match.length > 0) {
        let cur = { x: match[0].x, y: match[0].y, width: match[0].width, height: match[0].height };
        for (let i = 1; i < match.length; i++) {
          const ch = match[i], prev = match[i - 1];
          if (Math.abs(ch.y - prev.y) < 2 && ch.x - (prev.x + prev.width) < 10) {
            cur.width = (ch.x + ch.width) - cur.x;
          } else {
            rects.push({ ...cur });
            cur = { x: ch.x, y: ch.y, width: ch.width, height: ch.height };
          }
        }
        rects.push(cur);
      }

      results.push({
        pageNumber: pageNum,
        index: idx,
        text: fullText.substring(Math.max(0, idx - 20), idx + q.length + 20),
        items: rects,
      });

      startIndex = idx + 1;
    }
  }

  setSearchResults(results);
  setCurrentResultIndex(results.length ? 0 : -1);
  if (results.length > 0) {
    onResultFound?.(results[0].pageNumber, results[0].items);
  } else {
    onResultFound?.(1, []);
  }
  setIsSearching(false);
}, [pdf, searchQuery, onResultFound]);


  // Navigate results
  const goToNextResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentResultIndex + 1) % searchResults.length;
    setCurrentResultIndex(nextIndex);
    if (onResultFound) {
      onResultFound(searchResults[nextIndex].pageNumber, searchResults[nextIndex].items);
    }
  }, [searchResults, currentResultIndex, onResultFound]);

  const goToPrevResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIndex = currentResultIndex === 0 ? searchResults.length - 1 : currentResultIndex - 1;
    setCurrentResultIndex(prevIndex);
    if (onResultFound) {
      onResultFound(searchResults[prevIndex].pageNumber, searchResults[prevIndex].items);
    }
  }, [searchResults, currentResultIndex, onResultFound]);

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevResult();
      } else if (searchQuery.trim()) {
        if (searchResults.length === 0) {
          performSearch();
        } else {
          goToNextResult();
        }
      }
    } else if (e.key === 'Escape') {
      onClose();
      if (onResultFound) {
        onResultFound(1, []); // Clear highlights
      }
    }
  };

  // Clear highlights when closing
  useEffect(() => {
    if (!isOpen && onResultFound) {
      onResultFound(1, []);
    }
  }, [isOpen, onResultFound]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: '80px',
      right: '20px',
      background: 'white',
      border: '1px solid #ddd',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
      padding: '12px',
      zIndex: 1000,
      minWidth: '320px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search in PDF..."
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '14px',
            outline: 'none',
          }}
          onFocus={(e) => e.target.style.borderColor = '#1976d2'}
          onBlur={(e) => e.target.style.borderColor = '#ccc'}
        />
        <button
          onClick={() => {
            onClose();
            if (onResultFound) {
              onResultFound(1, []);
            }
          }}
          style={{
            padding: '8px 12px',
            border: 'none',
            background: '#f0f0f0',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '16px',
          }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={performSearch}
          disabled={!searchQuery.trim() || isSearching}
          style={{
            padding: '8px 16px',
            border: '1px solid #1976d2',
            background: '#1976d2',
            color: 'white',
            borderRadius: '4px',
            cursor: searchQuery.trim() && !isSearching ? 'pointer' : 'not-allowed',
            fontSize: '14px',
            fontWeight: '500',
            opacity: searchQuery.trim() && !isSearching ? 1 : 0.5,
          }}
        >
          {isSearching ? 'Searching...' : 'Search'}
        </button>

        {searchResults.length > 0 && (
          <>
            <button
              onClick={goToPrevResult}
              style={{
                padding: '8px 12px',
                border: '1px solid #ccc',
                background: 'white',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
              title="Previous (Shift+Enter)"
            >
              ◀
            </button>
            <span style={{ fontSize: '13px', color: '#666', minWidth: '80px', textAlign: 'center' }}>
              {currentResultIndex + 1} of {searchResults.length}
            </span>
            <button
              onClick={goToNextResult}
              style={{
                padding: '8px 12px',
                border: '1px solid #ccc',
                background: 'white',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
              title="Next (Enter)"
            >
              ▶
            </button>
          </>
        )}

        {searchResults.length === 0 && searchQuery && !isSearching && (
          <span style={{ fontSize: '13px', color: '#999' }}>No results</span>
        )}
      </div>

      <div style={{ fontSize: '11px', color: '#999', marginTop: '8px' }}>
        Press Enter to find next • Shift+Enter for previous • Esc to close
      </div>
    </div>
  );
}