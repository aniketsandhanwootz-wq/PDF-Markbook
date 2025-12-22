'use client';

import { useEffect, useRef, memo, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

type Rect = { x: number; y: number; w: number; h: number };

type PageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onReady?: (pageHeightPx: number) => void;
  onRenderedZoom?: (pageNumber: number, zoom: number) => void;

  flashRect?: { x: number; y: number; w: number; h: number } | null;
  selectedRect?: { x: number; y: number; w: number; h: number } | null;
  groupRects?: { x: number; y: number; w: number; h: number }[] | null;
  groupOutlineRect?: Rect | null;

  showMarks?: boolean;
};

// Canvas render cache to avoid re-rendering identical views
const renderCache = new Map<string, ImageBitmap>();
const MAX_CACHE_SIZE = 10;

function PageCanvas({
  pdf,
  pageNumber,
  zoom,
  onReady,
  onRenderedZoom,
  flashRect,
  selectedRect,
  groupRects,
  groupOutlineRect,
  showMarks = true,
}: PageCanvasProps) {
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const renderTaskRef = useRef<RenderTask | null>(null);
  const currentCanvasRef = useRef<'front' | 'back'>('front');
  const lastRenderedZoomRef = useRef<number>(0);

  // IMPORTANT: blink fix — show loader only for the very first paint
  const hasEverRenderedRef = useRef(false);
  const [isLoading, setIsLoading] = useState(true);

  // Used to re-run overlay draw exactly when we swap canvases
  const [currentCanvas, setCurrentCanvas] = useState<'front' | 'back'>('front');

  const getCacheKey = (page: number, zoomLevel: number) => {
    return `${page}_${zoomLevel.toFixed(2)}`;
  };

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

        // Blink fix: only show "loading" UI before first ever render
        if (!hasEverRenderedRef.current) setIsLoading(true);

        const page = await pdf.getPage(pageNumber);
        if (isCancelled) return;

        const viewport = page.getViewport({ scale: zoom });

        const isTouch =
          typeof window !== 'undefined' &&
          (('ontouchstart' in window) || navigator.maxTouchPoints > 0);

        // Lighter on phones, still crisp on desktop
        const dpr = isTouch ? 1.5 : Math.min(window.devicePixelRatio || 1, 2);

        // Guard: never exceed ~6MP canvas to avoid mobile GPU stalls
        const MAX_PIXELS = 6_000_000;
        let effDpr = dpr;
        const estPixels = viewport.width * viewport.height * (dpr * dpr);
        if (estPixels > MAX_PIXELS) {
          const shrink = Math.sqrt(MAX_PIXELS / estPixels);
          effDpr = Math.max(1, dpr * shrink);
        }

        const cacheKey = getCacheKey(pageNumber, zoom);
        const cached = renderCache.get(cacheKey);

        const targetCanvas =
          currentCanvasRef.current === 'front' ? backCanvas : frontCanvas;

        let ctx = targetCanvas.getContext(
          '2d',
          { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings
        ) as CanvasRenderingContext2D | null;

        if (!ctx) {
          ctx = targetCanvas.getContext('2d') as CanvasRenderingContext2D | null;
        }
        if (!ctx) {
          if (!hasEverRenderedRef.current) setIsLoading(false);
          return;
        }

        // Size canvas (buffer) + CSS pixels
        targetCanvas.width = Math.round(viewport.width * effDpr);
        targetCanvas.height = Math.round(viewport.height * effDpr);
        targetCanvas.style.width = `${viewport.width}px`;
        targetCanvas.style.height = `${viewport.height}px`;

        // If cached, just draw and swap
        if (cached) {
          const bmp: ImageBitmap = cached;
          ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0);
          ctx.drawImage(bmp, 0, 0, viewport.width, viewport.height);

          // Swap canvases (old remains visible until this moment)
          currentCanvasRef.current =
            currentCanvasRef.current === 'front' ? 'back' : 'front';
          setCurrentCanvas(currentCanvasRef.current);

          if (currentCanvasRef.current === 'back') {
            backCanvas.style.display = 'block';
            frontCanvas.style.display = 'none';
          } else {
            frontCanvas.style.display = 'block';
            backCanvas.style.display = 'none';
          }

          hasEverRenderedRef.current = true;
          setIsLoading(false);

          lastRenderedZoomRef.current = zoom;
          onReady?.(viewport.height);
          onRenderedZoom?.(pageNumber, zoom);
          return;
        }

        // Fresh render
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

        // Cache if small enough (works for both touch + desktop, guarded by size)
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

        // Swap canvases
        currentCanvasRef.current =
          currentCanvasRef.current === 'front' ? 'back' : 'front';
        setCurrentCanvas(currentCanvasRef.current);

        if (currentCanvasRef.current === 'back') {
          backCanvas.style.display = 'block';
          frontCanvas.style.display = 'none';
        } else {
          frontCanvas.style.display = 'block';
          backCanvas.style.display = 'none';
        }

        hasEverRenderedRef.current = true;
        setIsLoading(false);

        lastRenderedZoomRef.current = zoom;
        onReady?.(viewport.height);
        onRenderedZoom?.(pageNumber, zoom);
      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error('Page render error:', error);
          if (!hasEverRenderedRef.current) setIsLoading(false);
        }
      }
    };

    const zoomDiff = Math.abs(zoom - lastRenderedZoomRef.current);
    if ((zoomDiff > 0.02 || lastRenderedZoomRef.current === 0) && !renderTaskRef.current) {
      renderPage();
    }

    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
        renderTaskRef.current = null;
      }
    };
  }, [pdf, pageNumber, zoom, onReady, onRenderedZoom]);

  // Draw overlay
  useEffect(() => {
    const overlay = overlayRef.current;
    const visibleCanvas =
      currentCanvasRef.current === 'front'
        ? frontCanvasRef.current
        : backCanvasRef.current;

    if (!overlay || !visibleCanvas) return;

    const cssW = visibleCanvas.clientWidth;
    const cssH = visibleCanvas.clientHeight;
    const bufW = visibleCanvas.width;
    const bufH = visibleCanvas.height;

    if (!cssW || !cssH || !bufW || !bufH) return;

    overlay.width = bufW;
    overlay.height = bufH;
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;

    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    if (!showMarks) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    const sx = bufW / cssW;
    const sy = bufH / cssH;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    const drawPersistent = () => {
      const inGroupView = !!groupOutlineRect;

      if (groupRects && groupRects.length) {
        groupRects.forEach((r) => {
          ctx.beginPath();
          ctx.lineJoin = 'round';
          ctx.lineWidth = inGroupView ? 3 : 2;
          ctx.strokeStyle = inGroupView
            ? 'rgba(255, 212, 0, 0.55)'
            : 'rgba(255, 212, 0, 0.25)';
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        });
      }

      if (groupOutlineRect) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 122, 255, 0.9)';
        ctx.lineWidth = 2;
        const r = groupOutlineRect;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }

      if (!selectedRect) return;

      ctx.beginPath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = inGroupView ? 7 : 6;
      ctx.strokeStyle = inGroupView
        ? 'rgba(255, 212, 0, 0.65)'
        : 'rgba(255, 212, 0, 0.35)';
      ctx.strokeRect(selectedRect.x, selectedRect.y, selectedRect.w, selectedRect.h);

      ctx.beginPath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = inGroupView ? '#FFC107' : '#FFD400';
      ctx.strokeRect(selectedRect.x, selectedRect.y, selectedRect.w, selectedRect.h);
    };

    const draw = (withFlash: boolean) => {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      drawPersistent();

      if (withFlash && flashRect) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.28)';
        ctx.fillRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);
        ctx.beginPath();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#FFD54F';
        ctx.strokeRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);
      }
    };

    draw(Boolean(flashRect));

    let t: number | undefined;
    if (flashRect) t = window.setTimeout(() => draw(false), 1200);
    return () => { if (t) window.clearTimeout(t); };
  }, [
    flashRect,
    selectedRect,
    groupRects,
    groupOutlineRect,
    currentCanvas,
    zoom,
    pageNumber,
    showMarks,
  ]);

  const showInitialLoader = isLoading && !hasEverRenderedRef.current;

  return (
    <div className="page-wrapper" style={{ position: 'relative' }}>
      {showInitialLoader && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#666',
            fontSize: '14px',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          Loading page {pageNumber}...
        </div>
      )}

      <canvas
        ref={frontCanvasRef}
        className="page-canvas"
        data-visible={currentCanvasRef.current === 'front' ? 'true' : 'false'}
        style={{
          display: currentCanvasRef.current === 'front' ? 'block' : 'none',
        }}
      />
      <canvas
        ref={backCanvasRef}
        className="page-canvas"
        data-visible={currentCanvasRef.current === 'back' ? 'true' : 'false'}
        style={{
          display: currentCanvasRef.current === 'back' ? 'block' : 'none',
        }}
      />
      <canvas
        ref={overlayRef}
        className="page-overlay"
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 300,
        }}
      />
    </div>
  );
}

export default memo(PageCanvas, (prevProps, nextProps) => {
  return (
    prevProps.pdf === nextProps.pdf &&
    prevProps.pageNumber === nextProps.pageNumber &&
    Math.abs(prevProps.zoom - nextProps.zoom) < 0.01 &&
    prevProps.flashRect === nextProps.flashRect &&
    prevProps.selectedRect === nextProps.selectedRect &&
    prevProps.groupRects === nextProps.groupRects &&
    prevProps.groupOutlineRect === nextProps.groupOutlineRect &&
    prevProps.showMarks === nextProps.showMarks
  );
});
