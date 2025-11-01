'use client';

import { useEffect, useRef, memo, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

type PageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onReady?: (pageHeightPx: number) => void;
  flashRect?: { x: number; y: number; w: number; h: number } | null;
};

// Canvas render cache to avoid re-rendering identical views
const renderCache = new Map<string, ImageBitmap>();
const MAX_CACHE_SIZE = 10;

function PageCanvas({
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
  const lastRenderedZoomRef = useRef<number>(0);
  const [isLoading, setIsLoading] = useState(true);

  // Generate cache key
  const getCacheKey = (page: number, zoomLevel: number) => {
    return `${page}_${zoomLevel.toFixed(2)}`;
  };

  // Clean old cache entries
  const cleanCache = () => {
    if (renderCache.size > MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      if (firstKey) {
        const bitmap = renderCache.get(firstKey);
        bitmap?.close();
        renderCache.delete(firstKey);
      }
    }
  };

  // Render PDF page with double-buffering and caching
  useEffect(() => {
    const frontCanvas = frontCanvasRef.current;
    const backCanvas = backCanvasRef.current;
    if (!frontCanvas || !backCanvas) return;

    let isCancelled = false;

const renderPage = async () => {
  try {
    // Cancel previous render
    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {}
      renderTaskRef.current = null;
    }

    setIsLoading(true);

    const page = await pdf.getPage(pageNumber);
    if (isCancelled) return;

    const viewport = page.getViewport({ scale: zoom });

    const isTouch =
      typeof window !== 'undefined' &&
      (('ontouchstart' in window) || navigator.maxTouchPoints > 0);

    // Lighter on phones, still crisp on desktop
    const dpr = isTouch ? 1.5 : Math.min(window.devicePixelRatio || 1, 2);

    // Guard: never exceed ~8MP canvas to avoid mobile GPU stalls
    const MAX_PIXELS = 8_000_000;
    let effDpr = dpr;
    const estPixels = viewport.width * viewport.height * (dpr * dpr);
    if (estPixels > MAX_PIXELS) {
      const shrink = Math.sqrt(MAX_PIXELS / estPixels);
      effDpr = Math.max(1, dpr * shrink);
    }

    // Check cache
    const cacheKey = getCacheKey(pageNumber, zoom);
    const cached = renderCache.get(cacheKey);

    const targetCanvas =
      currentCanvasRef.current === 'front' ? backCanvas : frontCanvas;

// Strongly typed 2D context (with a graceful fallback)
let ctx = targetCanvas.getContext(
  '2d',
  { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings
) as CanvasRenderingContext2D | null;

if (!ctx) {
  ctx = targetCanvas.getContext('2d') as CanvasRenderingContext2D | null;
}

if (!ctx) {
  setIsLoading(false);
  return;
}


    // Size canvas (buffer) + CSS pixels
    targetCanvas.width = Math.round(viewport.width * effDpr);
    targetCanvas.height = Math.round(viewport.height * effDpr);
    targetCanvas.style.width = `${viewport.width}px`;
    targetCanvas.style.height = `${viewport.height}px`;

  if (cached) {
  const bmp: ImageBitmap = cached; // TS: narrow explicitly
  ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0);
  ctx.drawImage(bmp, 0, 0, viewport.width, viewport.height);

  // Swap canvases
  currentCanvasRef.current =
    currentCanvasRef.current === 'front' ? 'back' : 'front';

  if (currentCanvasRef.current === 'back') {
    backCanvas!.style.display = 'block';
    frontCanvas!.style.display = 'none';
  } else {
    frontCanvas!.style.display = 'block';
    backCanvas!.style.display = 'none';
  }

  setIsLoading(false);
  lastRenderedZoomRef.current = zoom;
  onReady?.(viewport.height);
  return;
}

    // Fresh render needed
    ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0);

    const renderContext = {
      canvasContext: ctx,
      viewport,
      enableWebGL: false,
      renderInteractiveForms: false,
    };

    renderTaskRef.current = page.render(renderContext);
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;

    // Cache only on non-touch devices to avoid mobile jank
    if (!isTouch) {
      try {
        const bitmapSize = targetCanvas.width * targetCanvas.height * 4; // bytes
        const maxSize = 16_777_216; // 16MB
        if (bitmapSize < maxSize) {
          const bitmap = await createImageBitmap(targetCanvas);
          cleanCache();
          renderCache.set(cacheKey, bitmap);
        }
      } catch {
        // ignore caching errors
      }
    }

    // Swap canvases
    currentCanvasRef.current =
      currentCanvasRef.current === 'front' ? 'back' : 'front';

    if (currentCanvasRef.current === 'back') {
      backCanvas!.style.display = 'block';
      frontCanvas!.style.display = 'none';
    } else {
      frontCanvas!.style.display = 'block';
      backCanvas!.style.display = 'none';
    }

    setIsLoading(false);
    lastRenderedZoomRef.current = zoom;
    onReady?.(viewport.height);
  } catch (error: any) {
    if (error?.name !== 'RenderingCancelledException') {
      console.error('Page render error:', error);
      setIsLoading(false);
    }
  }
};

    // Only re-render if zoom changed significantly (avoid micro-renders)
    const zoomDiff = Math.abs(zoom - lastRenderedZoomRef.current);
    if (zoomDiff > 0.01 || lastRenderedZoomRef.current === 0) {
      renderPage();
    }

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

// Draw flash overlay (red fill + yellow outline with halo)
useEffect(() => {
  const overlay = overlayRef.current;
  const visibleCanvas =
    currentCanvasRef.current === 'front'
      ? frontCanvasRef.current
      : backCanvasRef.current;

  if (!overlay || !visibleCanvas || !flashRect) return;

  const ctx = overlay.getContext('2d');
  if (!ctx) return;

  // Match overlay to visible canvas
  overlay.width = visibleCanvas.width;
  overlay.height = visibleCanvas.height;
  overlay.style.width = visibleCanvas.style.width;
  overlay.style.height = visibleCanvas.style.height;

  // Use same DPR logic as renderer (kept simple and robust)
  const isTouch =
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
  const baseDpr = isTouch ? 1.5 : Math.min(window.devicePixelRatio || 1, 2);

  const MAX_PIXELS = 8_000_000;
  const vw = Number(visibleCanvas.style.width?.replace('px', '') || 0);
  const vh = Number(visibleCanvas.style.height?.replace('px', '') || 0);
  let effDpr = baseDpr;
  const estPixels = vw * vh * (baseDpr * baseDpr);
  if (estPixels > MAX_PIXELS) {
    effDpr = Math.max(1, baseDpr * Math.sqrt(MAX_PIXELS / estPixels));
  }
  ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0);

  // Clear & draw
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // RED fill (same as before)
  ctx.fillStyle = 'rgba(255, 0, 0, 0.28)';
  ctx.fillRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);

  // YELLOW HALO (bigger, semi-transparent)
  ctx.beginPath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 9; // big halo
  ctx.strokeStyle = 'rgba(255, 235, 59, 0.35)'; // soft amber
  ctx.strokeRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);

  // CRISP YELLOW OUTLINE (on top)
  ctx.beginPath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3; // crisp edge
  ctx.strokeStyle = '#FFD54F'; // amber/yellow
  ctx.strokeRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);

  const timer = setTimeout(() => {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }, 1200);

  return () => {
    clearTimeout(timer);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  };
}, [flashRect]);

  return (
  <div className="page-wrapper" style={{ position: 'relative' }}>
    {isLoading && (
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        color: '#666',
        fontSize: '14px',
        pointerEvents: 'none',
        zIndex: 1
      }}>
        Loading page {pageNumber}...
      </div>
    )}
    <canvas 
      ref={frontCanvasRef} 
      className="page-canvas" 
      data-visible={currentCanvasRef.current === 'front' ? 'true' : 'false'}
      style={{ 
        display: currentCanvasRef.current === 'front' ? 'block' : 'none',
        opacity: isLoading ? 0.5 : 1,
        transition: 'opacity 0.2s'
      }} 
    />
    <canvas 
      ref={backCanvasRef} 
      className="page-canvas" 
      data-visible={currentCanvasRef.current === 'back' ? 'true' : 'false'}
      style={{ 
        display: currentCanvasRef.current === 'back' ? 'block' : 'none',
        opacity: isLoading ? 0.5 : 1,
        transition: 'opacity 0.2s'
      }} 
    />
    <canvas
  ref={overlayRef}
  className="page-overlay"
  style={{ pointerEvents: 'none' }}
/>
  </div>
);
}

// Memoize to prevent unnecessary re-renders
export default memo(PageCanvas, (prevProps, nextProps) => {
  return (
    prevProps.pdf === nextProps.pdf &&
    prevProps.pageNumber === nextProps.pageNumber &&
    Math.abs(prevProps.zoom - nextProps.zoom) < 0.01 &&
    prevProps.flashRect === nextProps.flashRect
  );
});