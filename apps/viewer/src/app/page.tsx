'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { 
  mapUnrotatedRectToRotation, 
  getRotatedPageSize, 
  computeAutoZoom, 
  centerScroll,
  type Mark as MarkData,
  type PageDimensions
} from '../lib/zoom';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';

interface Mark extends MarkData {
  mark_id: string;
  order_index: number;
  name: string;
}

export default function ViewerPage() {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [nextPageCache, setNextPageCache] = useState<Map<number, any>>(new Map());
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);

  // Load URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url');
    const setId = params.get('mark_set_id');
    
    if (url && setId) {
      setPdfUrl(url);
      setMarkSetId(setId);
    }
  }, []);

  // Initialize
  useEffect(() => {
    if (!pdfUrl || !markSetId) return;

    const init = async () => {
      try {
        setStatus('Loading marks...');
        
        const res = await fetch(`${API_BASE}/mark-sets/${markSetId}/marks`);
        if (!res.ok) throw new Error('Failed to fetch marks');
        const marksData = await res.json();
        setMarks(marksData);
        
        setStatus('Loading PDF...');
        
        const loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: false,
          isEvalSupported: false,
        });
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        
        setStatus('Ready');
        setCurrentIndex(0);
      } catch (error) {
        console.error('Init error:', error);
        setStatus(`Error: ${error}`);
      }
    };

    init();
  }, [pdfUrl, markSetId]);

  // Preload next mark's page for snappy navigation
  // QA: Next → render completes and centers within ~200ms on desktop PDFs (after preload)
  const preloadNextMark = useCallback(async () => {
    if (!pdfDoc || !marks.length) return;
    
    const nextIndex = currentIndex + 1;
    if (nextIndex >= marks.length) return;
    
    const nextMark = marks[nextIndex];
    const pageNum = nextMark.page_index + 1;
    
    if (!nextPageCache.has(pageNum)) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        setNextPageCache(prev => new Map(prev).set(pageNum, page));
      } catch (error) {
        console.error('Preload error:', error);
      }
    }
  }, [pdfDoc, marks, currentIndex, nextPageCache]);

  // Auto-zoom and render current mark
  // QA: Resizing the window recomputes scale and recenters the current mark automatically
  const renderCurrentMark = useCallback(async () => {
    if (!pdfDoc || !marks.length || !containerRef.current || !canvasRef.current) return;
    
    const currentToken = ++renderTokenRef.current;
    setIsRendering(true);
    
    try {
      const mark = marks[currentIndex];
      if (!mark) return;

      const pageNum = mark.page_index + 1;
      
      // Use cached page or fetch it
      let page = nextPageCache.get(pageNum);
      if (!page) {
        page = await pdfDoc.getPage(pageNum);
      }
      
      // Check if render was cancelled
      if (renderTokenRef.current !== currentToken) return;
      
      const canvas = canvasRef.current;
      const container = containerRef.current;
      
      // Get page dimensions
      const baseViewport = page.getViewport({ scale: 1 });
      const rotation = page.rotate || 0;
      const pageW = baseViewport.width;
      const pageH = baseViewport.height;
      
      // Convert mark to rotated coordinates
      const rectRotated = mapUnrotatedRectToRotation(mark, pageW, pageH, rotation);
      const rotatedPageSize = getRotatedPageSize(pageW, pageH, rotation);
      
      // Calculate padding in page coordinates
      const paddingPx = mark.padding_pct * Math.max(rectRotated.w, rectRotated.h);
      
      // Compute auto-zoom scale
      const containerW = container.clientWidth;
      const containerH = container.clientHeight;
      const targetScale = computeAutoZoom({
        rectRotated,
        containerW,
        containerH,
        paddingPx
      });
      
      // Create viewport with rotation and scale
      const viewport = page.getViewport({ scale: targetScale, rotation });
      
      // High-DPI rendering
      const dpr = window.devicePixelRatio || 1;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      
      // Render page
      await page.render({ canvasContext: ctx, viewport }).promise;
      
      // Check if render was cancelled
      if (renderTokenRef.current !== currentToken) return;
      
      // Draw highlight rectangle
      const markX = rectRotated.x * targetScale;
      const markY = rectRotated.y * targetScale;
      const markWidth = rectRotated.w * targetScale;
      const markHeight = rectRotated.h * targetScale;
      
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 3;
      ctx.strokeRect(markX / dpr, markY / dpr, markWidth / dpr, markHeight / dpr);
      
      // Center the mark in viewport
      const rectCenter = {
        x: rectRotated.x + rectRotated.w / 2,
        y: rectRotated.y + rectRotated.h / 2
      };
      
      const { scrollLeft, scrollTop } = centerScroll({
        container,
        rectCenter,
        scale: targetScale
      });
      
      container.scrollTo({
        left: scrollLeft,
        top: scrollTop,
        behavior: 'smooth'
      });
      
    } catch (error) {
      console.error('Render error:', error);
      setStatus(`Render error: ${error}`);
    } finally {
      setIsRendering(false);
    }
  }, [pdfDoc, marks, currentIndex, nextPageCache]);

  // Render when mark changes or window resizes
  useEffect(() => {
    renderCurrentMark();
    preloadNextMark();
  }, [renderCurrentMark, preloadNextMark]);

  // Debounced resize handler
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    
    const handleResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        renderCurrentMark();
      }, 150);
    };
    
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, [renderCurrentMark]);

  // Navigation
  const goNext = () => {
    if (currentIndex < marks.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const goPrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const jumpTo = (index: number) => {
    setCurrentIndex(index);
    setListOpen(false);
  };

  if (!pdfUrl || !markSetId) {
    return (
      <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <h1>PDF Markbook Viewer</h1>
        <p>Add <code>?pdf_url=YOUR_PDF_URL&mark_set_id=MARK_SET_ID</code> to the URL</p>
        <p><strong>Example:</strong></p>
        <code>http://localhost:3002/?pdf_url=https://example.com/document.pdf&mark_set_id=abc-123</code>
      </div>
    );
  }

  if (marks.length === 0) {
    return (
      <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <h1>Loading...</h1>
        <p>{status}</p>
      </div>
    );
  }

  const currentMark = marks[currentIndex];

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{ 
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        padding: '1rem', 
        borderBottom: '1px solid #ccc',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        backgroundColor: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(8px)'
      }}>
        <button onClick={() => setListOpen(!listOpen)} style={{ 
          padding: '0.5rem 1rem',
          backgroundColor: listOpen ? '#007bff' : '#f8f9fa',
          color: listOpen ? 'white' : 'black',
          border: '1px solid #ccc',
          borderRadius: '4px',
          cursor: 'pointer'
        }}>
          ☰ {listOpen ? 'Close' : 'List'}
        </button>
        
        <button onClick={goPrevious} disabled={currentIndex === 0} style={{ 
          padding: '0.5rem 1rem',
          cursor: currentIndex === 0 ? 'not-allowed' : 'pointer',
          opacity: currentIndex === 0 ? 0.5 : 1
        }}>
          ← Previous
        </button>
        <button onClick={goNext} disabled={currentIndex === marks.length - 1} style={{ 
          padding: '0.5rem 1rem',
          cursor: currentIndex === marks.length - 1 ? 'not-allowed' : 'pointer',
          opacity: currentIndex === marks.length - 1 ? 0.5 : 1
        }}>
          Next →
        </button>
        <span style={{ fontWeight: 'bold', flex: 1 }}>
          {currentMark?.name} ({currentIndex + 1} / {marks.length})
        </span>
        
        <span style={{ fontSize: '0.9em', color: '#666' }}>{status}</span>
      </div>

      {/* PDF Pane - isolated scrolling */}
      <div 
        id="pdfPane"
        ref={containerRef}
        style={{ 
          flex: 1,
          paddingTop: '80px' // Account for fixed header
        }}
      >
        <canvas 
          ref={canvasRef} 
          className="pdf-canvas"
        />
      </div>

      {/* Marks list */}
      <div 
        className={`marks-list ${listOpen ? 'open' : ''}`}
        style={{
          position: 'fixed',
          top: '80px',
          right: listOpen ? 0 : '-320px',
          width: '320px',
          height: 'calc(100vh - 80px)',
          backgroundColor: 'white',
          borderLeft: '1px solid #ccc',
          overflowY: 'auto',
          padding: '1rem',
          boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
          transition: 'right 0.3s ease',
          zIndex: 5
        }}
      >
        <h3 style={{ marginTop: 0 }}>All Marks</h3>
        {marks.map((mark, index) => (
          <div 
            key={mark.mark_id}
            onClick={() => jumpTo(index)}
            style={{
              padding: '0.75rem',
              marginBottom: '0.5rem',
              border: index === currentIndex ? '2px solid #007bff' : '1px solid #ddd',
              borderRadius: '4px',
              cursor: 'pointer',
              backgroundColor: index === currentIndex ? '#e7f3ff' : 'white'
            }}
          >
            <div style={{ fontWeight: 'bold' }}>{mark.name}</div>
            <div style={{ fontSize: '0.85em', color: '#666' }}>
              Page {mark.page_index + 1}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}