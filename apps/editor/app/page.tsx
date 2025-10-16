'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// ... rest of the file

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const API_BASE = 'http://localhost:8000';

interface Mark {
  page_index: number;
  order_index: number;
  name: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

interface PageDim {
  idx: number;
  width_pt: number;
  height_pt: number;
  rotation_deg: number;
}

export default function EditorPage() {
  const [pdfUrl, setPdfUrl] = useState('');
  const [userId, setUserId] = useState('');
  const [docId, setDocId] = useState('');
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState('');
  const [pageDims, setPageDims] = useState<PageDim[]>([]);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // Load URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('pdf_url');
    const user = params.get('user_id') || 'anonymous';
    
    if (url) {
      setPdfUrl(url);
      setUserId(user);
    }
  }, []);

  // Initialize document
  useEffect(() => {
    if (!pdfUrl) return;

    const initDocument = async () => {
      try {
        setStatus('Creating document...');
        
        // Create document
        const createRes = await fetch(`${API_BASE}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdf_url: pdfUrl, created_by: userId })
        });
        
        if (!createRes.ok) throw new Error('Failed to create document');
        const { doc_id } = await createRes.json();
        setDocId(doc_id);
        
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
        setTotalPages(pdf.numPages);
        
        setStatus('Collecting page dimensions...');
        
        // Collect page dimensions
        const dims: PageDim[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          dims.push({
            idx: i - 1, // 0-based
            width_pt: viewport.width,
            height_pt: viewport.height,
            rotation_deg: page.rotate || 0
          });
        }
        setPageDims(dims);
        
        setStatus('Bootstrapping pages...');
        
        // Bootstrap pages
        const bootstrapRes = await fetch(`${API_BASE}/documents/${doc_id}/pages/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page_count: pdf.numPages, dims })
        });
        
        if (!bootstrapRes.ok) throw new Error('Failed to bootstrap pages');
        
        setStatus('Ready to mark regions');
        setCurrentPage(1);
      } catch (error) {
        console.error('Init error:', error);
        setStatus(`Error: ${error}`);
      }
    };

    initDocument();
  }, [pdfUrl, userId]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !currentPage) return;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const canvas = canvasRef.current;
        const overlay = overlayRef.current;
        if (!canvas || !overlay) return;

        const scale = 1.5;
        const viewport = page.getViewport({ scale });

        // Set canvas dimensions
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        overlay.width = viewport.width;
        overlay.height = viewport.height;

        // Render PDF
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (error) {
        console.error('Render error:', error);
      }
    };

    renderPage();
  }, [pdfDoc, currentPage]);

  // Handle mouse down
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    setDrawStart({ x, y });
    setDrawCurrent({ x, y });
  };

  // Handle mouse move
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;

    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setDrawCurrent({ x, y });

    // Draw rectangle on overlay
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.strokeRect(drawStart.x, drawStart.y, x - drawStart.x, y - drawStart.y);
  };

  // Handle mouse up
  const handleMouseUp = async () => {
    if (!isDrawing || !drawStart || !drawCurrent) return;

    setIsDrawing(false);

    // Clear overlay
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Get mark name
    const name = prompt('Enter mark name:');
    if (!name) return;

    // Convert to normalized coordinates
    const pageDim = pageDims[currentPage - 1];
    if (!pageDim) return;

    const scale = 1.5;
    const viewport_width = pageDim.width_pt * scale;
    const viewport_height = pageDim.height_pt * scale;

    // Get rectangle in viewport coordinates
    let x1 = Math.min(drawStart.x, drawCurrent.x);
    let y1 = Math.min(drawStart.y, drawCurrent.y);
    let x2 = Math.max(drawStart.x, drawCurrent.x);
    let y2 = Math.max(drawStart.y, drawCurrent.y);

    // Convert from viewport to page coordinates (unscaled)
    x1 = x1 / scale;
    y1 = y1 / scale;
    x2 = x2 / scale;
    y2 = y2 / scale;

    // Normalize to [0, 1] range
    const nx = x1 / pageDim.width_pt;
    const ny = y1 / pageDim.height_pt;
    const nw = (x2 - x1) / pageDim.width_pt;
    const nh = (y2 - y1) / pageDim.height_pt;

    // Add mark
    const mark: Mark = {
      page_index: currentPage - 1,
      order_index: marks.length,
      name,
      nx: Math.max(0, Math.min(1, nx)),
      ny: Math.max(0, Math.min(1, ny)),
      nw: Math.max(0.01, Math.min(1 - nx, nw)),
      nh: Math.max(0.01, Math.min(1 - ny, nh))
    };

    setMarks([...marks, mark]);
    setDrawStart(null);
    setDrawCurrent(null);
  };

  // Save mark set
  const saveMarkSet = async () => {
    if (marks.length === 0) {
      alert('No marks to save');
      return;
    }

    try {
      setStatus('Saving mark set...');
      
      const res = await fetch(`${API_BASE}/mark-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_id: docId,
          label: 'v1',
          created_by: userId,
          marks
        })
      });

      if (!res.ok) throw new Error('Failed to save mark set');
      
      const { mark_set_id } = await res.json();
      setStatus(`Saved! mark_set_id: ${mark_set_id}`);
      
      // Copy to clipboard
// Copy to clipboard
navigator.clipboard.writeText(mark_set_id);

// Create a better dialog with copyable text
const copyText = () => {
  navigator.clipboard.writeText(mark_set_id);
  alert('ID copied to clipboard!');
};

// Show the ID in the status and a more user-friendly alert
setStatus(`Saved! mark_set_id: ${mark_set_id}`);
alert(`Mark set saved!\n\nClick OK, then use the ID from the status bar to test in viewer.\n\nID has been copied to clipboard.`);

// Also log to console for easy access
console.log('Mark Set ID:', mark_set_id);
console.log('Viewer URL:', `http://localhost:3002/?pdf_url=${encodeURIComponent(pdfUrl)}&mark_set_id=${mark_set_id}`);
    } catch (error) {
      console.error('Save error:', error);
      setStatus(`Save error: ${error}`);
    }
  };

  // Delete mark
  const deleteMark = (index: number) => {
    const updated = marks.filter((_, i) => i !== index);
    // Reindex
    updated.forEach((m, i) => m.order_index = i);
    setMarks(updated);
  };

  // Move mark up
  const moveUp = (index: number) => {
    if (index === 0) return;
    const updated = [...marks];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    updated.forEach((m, i) => m.order_index = i);
    setMarks(updated);
  };

  // Move mark down
  const moveDown = (index: number) => {
    if (index === marks.length - 1) return;
    const updated = [...marks];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    updated.forEach((m, i) => m.order_index = i);
    setMarks(updated);
  };

  if (!pdfUrl) {
    return (
      <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <h1>PDF Markbook Editor</h1>
        <p>Add <code>?pdf_url=YOUR_PDF_URL&user_id=USER_ID</code> to the URL</p>
        <p><strong>Example:</strong></p>
        <code>http://localhost:3001/?pdf_url=https://example.com/document.pdf&user_id=john</code>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* Main canvas area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '1rem', backgroundColor: '#f5f5f5' }}>
        <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button 
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            style={{ padding: '0.5rem 1rem' }}
          >
            Previous
          </button>
          <span>Page {currentPage} / {totalPages}</span>
          <button 
            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            style={{ padding: '0.5rem 1rem' }}
          >
            Next
          </button>
          <span style={{ marginLeft: 'auto', fontSize: '0.9em', color: '#666' }}>{status}</span>
        </div>
        
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <canvas ref={canvasRef} style={{ display: 'block', border: '1px solid #ccc' }} />
          <canvas 
            ref={overlayRef}
            style={{ 
              position: 'absolute', 
              top: 0, 
              left: 0,
              cursor: 'crosshair'
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        </div>
        
        <div style={{ marginTop: '1rem', fontSize: '0.9em', color: '#666' }}>
          <p><strong>Instructions:</strong> Click and drag to draw a rectangle. You'll be prompted to name it.</p>
        </div>
      </div>

      {/* Sidebar */}
      <div style={{ 
        width: '300px', 
        borderLeft: '1px solid #ccc', 
        padding: '1rem',
        overflowY: 'auto',
        backgroundColor: '#fff'
      }}>
        <h3>Marks ({marks.length})</h3>
        
        {marks.length === 0 && <p style={{ color: '#999' }}>No marks yet</p>}
        
        {marks.map((mark, index) => (
          <div key={index} style={{ 
            marginBottom: '0.5rem', 
            padding: '0.5rem',
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}>
            <div><strong>{mark.name}</strong></div>
            <div style={{ fontSize: '0.8em', color: '#666' }}>
              Page {mark.page_index + 1}, Order {mark.order_index}
            </div>
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => moveUp(index)} disabled={index === 0} style={{ fontSize: '0.8em' }}>↑</button>
              <button onClick={() => moveDown(index)} disabled={index === marks.length - 1} style={{ fontSize: '0.8em' }}>↓</button>
              <button onClick={() => deleteMark(index)} style={{ fontSize: '0.8em', marginLeft: 'auto' }}>Delete</button>
            </div>
          </div>
        ))}
        
        {marks.length > 0 && (
          <button 
            onClick={saveMarkSet}
            style={{ 
              marginTop: '1rem', 
              width: '100%', 
              padding: '0.75rem',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '1em',
              fontWeight: 'bold'
            }}
          >
            Save Mark Set
          </button>
        )}
      </div>
    </div>
  );
}