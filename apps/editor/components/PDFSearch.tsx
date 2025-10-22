'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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

  // Perform search with exact position calculation
  const performSearch = useCallback(async () => {
    if (!pdf || !searchQuery.trim()) {
      setSearchResults([]);
      setCurrentResultIndex(-1);
      if (onResultFound) {
        onResultFound(1, []);
      }
      return;
    }

    setIsSearching(true);
    const results: SearchResult[] = [];
    const query = searchQuery.toLowerCase();

    try {
      const numPages = pdf.numPages;

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });

        // Build complete text string with positions
        let fullText = '';
        const charPositions: Array<{
          char: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }> = [];

        for (const item of textContent.items) {
          if ('str' in item) {
            const transform = item.transform;
            const fontSize = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            const x = transform[4];
            const y = viewport.height - transform[5]; // Flip Y coordinate

            for (let i = 0; i < item.str.length; i++) {
              const char = item.str[i];
              const charWidth = (item.width / item.str.length);
              
              charPositions.push({
                char,
                x: x + (i * charWidth),
                y: y - fontSize,
                width: charWidth,
                height: fontSize,
              });

              fullText += char;
            }

            // Add space between items
            fullText += ' ';
            charPositions.push({
              char: ' ',
              x: x + item.width,
              y: y - fontSize,
              width: 5,
              height: fontSize,
            });
          }
        }

        // Find all occurrences in this page
        const lowerText = fullText.toLowerCase();
        let startIndex = 0;

        while (true) {
          const index = lowerText.indexOf(query, startIndex);
          if (index === -1) break;

          // Get bounding boxes for this match
          const matchChars = charPositions.slice(index, index + query.length);
          
          // Group adjacent characters into rectangles
          const rects: SearchResult['items'] = [];
          
          if (matchChars.length > 0) {
            let currentRect = {
              x: matchChars[0].x,
              y: matchChars[0].y,
              width: matchChars[0].width,
              height: matchChars[0].height,
            };

            for (let i = 1; i < matchChars.length; i++) {
              const char = matchChars[i];
              const prevChar = matchChars[i - 1];

              // Check if this character is on the same line and adjacent
              if (Math.abs(char.y - prevChar.y) < 2 && 
                  char.x - (prevChar.x + prevChar.width) < 10) {
                // Extend current rectangle
                currentRect.width = (char.x + char.width) - currentRect.x;
              } else {
                // Start new rectangle
                rects.push({ ...currentRect });
                currentRect = {
                  x: char.x,
                  y: char.y,
                  width: char.width,
                  height: char.height,
                };
              }
            }

            rects.push(currentRect);
          }

          results.push({
            pageNumber: pageNum,
            index,
            text: fullText.substring(Math.max(0, index - 20), index + query.length + 20),
            items: rects,
          });

          startIndex = index + 1;
        }
      }

      setSearchResults(results);
      setCurrentResultIndex(results.length > 0 ? 0 : -1);

      // Navigate to first result with highlights
      if (results.length > 0 && onResultFound) {
        onResultFound(results[0].pageNumber, results[0].items);
      }
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
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