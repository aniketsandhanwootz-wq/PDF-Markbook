'use client';

import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

type PageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onReady?: (pageHeightPx: number) => void;
  flashRect?: { x: number; y: number; w: number; h: number } | null;
};

export default function PageCanvas({
  pdf,
  pageNumber,
  zoom,
  onReady,
  flashRect,
}: PageCanvasProps) {
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const currentCanvasRef = useRef<'front' | 'back'>('front');

  // Render PDF page with double-buffering
  useEffect(() => {
    const frontCanvas = frontCanvasRef.current;
    const backCanvas = backCanvasRef.current;
    if (!frontCanvas || !backCanvas) return;

    let isCancelled = false;

    const renderPage = async () => {
      try {
        // Cancel previous render if still running
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch (e) {
            // Ignore
          }
          renderTaskRef.current = null;
        }

        const page = await pdf.getPage(pageNumber);
        if (isCancelled) return;

        const viewport = page.getViewport({ scale: zoom });
        const dpr = window.devicePixelRatio || 1;

        // Render to the back canvas
        const targetCanvas = currentCanvasRef.current === 'front' ? backCanvas : frontCanvas;
        const ctx = targetCanvas.getContext('2d');
        if (!ctx) return;

        targetCanvas.width = viewport.width * dpr;
        targetCanvas.height = viewport.height * dpr;
        targetCanvas.style.width = `${viewport.width}px`;
        targetCanvas.style.height = `${viewport.height}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderContext = {
          canvasContext: ctx,
          viewport: viewport,
        };

        renderTaskRef.current = page.render(renderContext);
        await renderTaskRef.current.promise;
        renderTaskRef.current = null;

        if (!isCancelled) {
          // Swap canvases
          currentCanvasRef.current = currentCanvasRef.current === 'front' ? 'back' : 'front';
          
          // Update visibility
          if (currentCanvasRef.current === 'back') {
            backCanvas.style.display = 'block';
            frontCanvas.style.display = 'none';
          } else {
            frontCanvas.style.display = 'block';
            backCanvas.style.display = 'none';
          }

          if (onReady) {
            onReady(viewport.height);
          }
        }
      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error('Page render error:', error);
        }
      }
    };

    renderPage();

    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (e) {
          // Ignore
        }
        renderTaskRef.current = null;
      }
    };
  }, [pdf, pageNumber, zoom, onReady]);

  // Draw flash overlay
  useEffect(() => {
    const overlay = overlayRef.current;
    const visibleCanvas = currentCanvasRef.current === 'front' ? frontCanvasRef.current : backCanvasRef.current;
    if (!overlay || !visibleCanvas || !flashRect) return;

    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    overlay.width = visibleCanvas.width;
    overlay.height = visibleCanvas.height;
    overlay.style.width = visibleCanvas.style.width;
    overlay.style.height = visibleCanvas.style.height;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = 'rgba(255, 0, 0, 0.28)';
    ctx.fillRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);

    const timer = setTimeout(() => {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }, 1200);

    return () => {
      clearTimeout(timer);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    };
  }, [flashRect]);

  return (
    <div className="page-wrapper">
      <canvas ref={frontCanvasRef} className="page-canvas" style={{ display: 'block' }} />
      <canvas ref={backCanvasRef} className="page-canvas" style={{ display: 'none' }} />
      <canvas ref={overlayRef} className="page-overlay" />
    </div>
  );
}