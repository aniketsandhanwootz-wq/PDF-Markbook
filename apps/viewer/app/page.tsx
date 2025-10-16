'use client';

import { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';

interface Mark {
  mark_id: string;
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  zoom_hint?: number;
  padding_pct: number;
  anchor: string;
}

export default function ViewerPage() {
  const [pdfUrl, setPdfUrl] = useState('');
  const [markSetId, setMarkSetId] = useState('');
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [status, setStatus] = useState('');
  const [listOpen, setListOpen] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
        
        // Fetch marks
        const res = await fetch(`${API_BASE}/mark-sets/${markSetId}/marks`);
        if (!res.ok) throw new Error('Failed to fetch marks');
        const marksData = await res.json();
        setMarks(marksData);
        
        setStatus('Loading PDF...');
        
        // Load PDF
        // Load PDF with CORS handling
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

  // Render current mark
  useEffect(() => {
    if (!pdfDoc || marks.length === 0) return;

    const renderMark = async () => {
      try {
        const mark = marks[currentIndex];
        if (!mark) return;

        const page = await pdfDoc.getPage(mark.page_index + 1);
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        // Get page dimensions at scale 1
        const baseViewport = page.getViewport({ scale: 1 });
        
        // Calculate zoom-to-fit scale
        const containerW = container.clientWidth;
        const containerH = container.clientHeight;
        
        // Account for padding
        const paddingPct = mark.padding_pct || 0.1;
        const markW = mark.nw * baseViewport.width;
        const markH = mark.nh * baseViewport.height;
        
        const paddedW = markW * (1 + paddingPct * 2);
        const paddedH = markH * (1 + paddingPct * 2);
        
        // Calculate scale to fit
        const scaleX = containerW / paddedW;
        const scaleY = containerH / paddedH;
        let autoScale = Math.min(scaleX, scaleY);
        
        // Apply zoom hint if provided
        const finalScale = mark.zoom_hint || autoScale;
        setScale(finalScale);
        
        // Render at calculated scale
        const viewport = page.getViewport({ scale: finalScale });
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        await page.render({ canvasContext: ctx, viewport }).promise;
        
        // Draw highlight rectangle
        const markX = mark.nx * viewport.width;
        const markY = mark.ny * viewport.height;
        const markWidth = mark.nw * viewport.width;
        const markHeight = mark.nh * viewport.height;
        
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.strokeRect(markX, markY, markWidth, markHeight);
        
        // Scroll to center the mark
        const scrollX = markX + markWidth / 2 - containerW / 2;
        const scrollY = markY + markHeight / 2 - containerH / 2;
        
        container.scrollTo({
          left: Math.max(0, scrollX),
          top: Math.max(0, scrollY),
          behavior: 'smooth'
        });
        
      } catch (error) {
        console.error('Render error:', error);
        setStatus(`Render error: ${error}`);
      }
    };

    renderMark();
  }, [pdfDoc, marks, currentIndex]);

  // Navigate
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

  // Zoom controls
  const zoomIn = () => setScale(s => Math.min(s * 1.2, 6));
  const zoomOut = () => setScale(s => Math.max(s / 1.2, 0.25));

  // Save zoom preference
  const saveZoom = async () => {
    const mark = marks[currentIndex];
    if (!mark) return;

    try {
      const res = await fetch(`${API_BASE}/marks/${mark.mark_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoom_hint: scale })
      });

      if (!res.ok) throw new Error('Failed to save zoom');
      
      // Update local state
      const updated = [...marks];
      updated[currentIndex].zoom_hint = scale;
      setMarks(updated);
      
      setStatus('Zoom saved');
      setTimeout(() => setStatus('Ready'), 2000);
    } catch (error) {
      console.error('Save zoom error:', error);
      setStatus(`Error: ${error}`);
    }
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{ 
        padding: '1rem', 
        borderBottom: '1px solid #ccc',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        backgroundColor: '#fff'
      }}>
        <button onClick={goPrevious} disabled={currentIndex === 0} style={{ padding: '0.5rem 1rem' }}>
          ← Previous
        </button>
        <button onClick={goNext} disabled={currentIndex === marks.length - 1} style={{ padding: '0.5rem 1rem' }}>
          Next →
        </button>
        <span style={{ fontWeight: 'bold' }}>
          {currentMark?.name} ({currentIndex + 1} / {marks.length})
        </span>
        <button onClick={() => setListOpen(!listOpen)} style={{ padding: '0.5rem 1rem', marginLeft: 'auto' }}>
          {listOpen ? '✕ Close' : '☰ List'}
        </button>
        <button onClick={zoomOut} style={{ padding: '0.5rem 1rem' }}>−</button>
        <span style={{ fontSize: '0.9em' }}>{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} style={{ padding: '0.5rem 1rem' }}>+</button>
        <button onClick={saveZoom} style={{ padding: '0.5rem 1rem', fontSize: '0.9em' }}>
          Save Zoom
        </button>
        <span style={{ fontSize: '0.9em', color: '#666' }}>{status}</span>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Canvas container */}
        <div 
          ref={containerRef}
          style={{ 
            width: '100%', 
            height: '100%', 
            overflow: 'auto',
            backgroundColor: '#f5f5f5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <canvas ref={canvasRef} style={{ display: 'block' }} />
        </div>

        {/* Marks list (collapsible) */}
        {listOpen && (
          <div style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '300px',
            height: '100%',
            backgroundColor: 'white',
            borderLeft: '1px solid #ccc',
            overflowY: 'auto',
            padding: '1rem',
            boxShadow: '-2px 0 8px rgba(0,0,0,0.1)'
          }}>
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
        )}
      </div>
    </div>
  );
}