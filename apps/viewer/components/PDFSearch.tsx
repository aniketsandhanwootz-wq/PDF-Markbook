'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PDFSearchProps = {
  pdf: PDFDocumentProxy | null;
  isOpen: boolean;
  onClose: () => void;
  onResultFound?: (pageNumber: number, rect: { x: number; y: number; w: number; h: number }) => void;
};

export default function PDFSearch({ pdf, isOpen, onClose, onResultFound }: PDFSearchProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Perform search
  const performSearch = useCallback(async () => {
    if (!pdf || !searchQuery.trim()) {
      setSearchResults([]);
      setCurrentResultIndex(-1);
      return;
    }

    setIsSearching(true);
    const results: any[] = [];

    try {
      const numPages = pdf.numPages;

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        // Combine all text items
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(' ')
          .toLowerCase();

        const query = searchQuery.toLowerCase();
        let startIndex = 0;

        // Find all occurrences on this page
        while (true) {
          const index = pageText.indexOf(query, startIndex);
          if (index === -1) break;

          results.push({
            pageNumber: pageNum,
            index,
            text: pageText.substring(Math.max(0, index - 20), index + query.length + 20),
          });

          startIndex = index + 1;
        }
      }

      setSearchResults(results);
      setCurrentResultIndex(results.length > 0 ? 0 : -1);

      // Navigate to first result
      if (results.length > 0 && onResultFound) {
        onResultFound(results[0].pageNumber, { x: 0, y: 0, w: 0, h: 0 });
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
      onResultFound(searchResults[nextIndex].pageNumber, { x: 0, y: 0, w: 0, h: 0 });
    }
  }, [searchResults, currentResultIndex, onResultFound]);

  const goToPrevResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIndex = currentResultIndex === 0 ? searchResults.length - 1 : currentResultIndex - 1;
    setCurrentResultIndex(prevIndex);
    if (onResultFound) {
      onResultFound(searchResults[prevIndex].pageNumber, { x: 0, y: 0, w: 0, h: 0 });
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
    }
  };

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
          onClick={onClose}
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