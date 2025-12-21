'use client';

import { useEffect, useRef, memo, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

// ✅ Add this just below the imports
type Rect = { x: number; y: number; w: number; h: number };

type PageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onReady?: (pageHeightPx: number) => void;
    onRenderedZoom?: (pageNumber: number, zoom: number) => void;
  flashRect?: { x: number; y: number; w: number; h: number } | null;
  selectedRect?: { x: number; y: number; w: number; h: number } | null;
  // NEW: optional list of rects to show when we are in "group overview"
  groupRects?: { x: number; y: number; w: number; h: number }[] | null;
  // 👇 NEW: outline for current group in slide view
  groupOutlineRect?: Rect | null;
  // When false, suppress all mark overlays (used on report-title screen)
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
  const [isLoading, setIsLoading] = useState(true);
  const [currentCanvas, setCurrentCanvas] = useState<'front' | 'back'>('front');
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
          } catch { }
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
        const MAX_PIXELS = 6_000_000;
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
          setCurrentCanvas(currentCanvasRef.current);

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

// 🔥 Notify: this page is ready at this zoom (important for pinch handoff)
onRenderedZoom?.(pageNumber, zoom);

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
        setCurrentCanvas(currentCanvasRef.current);

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

// 🔥 Notify: this page is ready at this zoom (important for pinch handoff)
onRenderedZoom?.(pageNumber, zoom);

      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error('Page render error:', error);
          setIsLoading(false);
        }
      }
    };

    const zoomDiff = Math.abs(zoom - lastRenderedZoomRef.current);
    // Slightly more eager to re-render for smoother pinch
    if ((zoomDiff > 0.02 || lastRenderedZoomRef.current === 0) && !renderTaskRef.current) {
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

  // Draw overlay: persistent yellow outline + optional red flash
  useEffect(() => {
    const overlay = overlayRef.current;
    const visibleCanvas =
      currentCanvasRef.current === 'front'
        ? frontCanvasRef.current
        : backCanvasRef.current;

    if (!overlay || !visibleCanvas) return;

    // Use actual rendered size (don’t rely on style strings)
    const cssW = visibleCanvas.clientWidth;
    const cssH = visibleCanvas.clientHeight;
    const bufW = visibleCanvas.width;
    const bufH = visibleCanvas.height;

    // Wait until the page bitmap has real sizes
    if (!cssW || !cssH || !bufW || !bufH) return;

    // Size overlay to match the visible bitmap and its CSS size
    overlay.width = bufW;
    overlay.height = bufH;
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;

    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    // If overlays are disabled (e.g. report-title screen), just clear and bail out
    if (!showMarks) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    // Map CSS coords → buffer pixels exactly
    const sx = bufW / cssW;
    const sy = bufH / cssH;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    const drawPersistent = () => {
      // Treat "group view" as when we have a group outline
      const inGroupView = !!groupOutlineRect;

      // 1) Show ALL marks of the current group (if provided)
      if (groupRects && groupRects.length) {
        groupRects.forEach((r) => {
          ctx.beginPath();
          ctx.lineJoin = 'round';
          ctx.lineWidth = inGroupView ? 3 : 2;
          ctx.strokeStyle = inGroupView
            ? 'rgba(255, 212, 0, 0.55)' // stronger yellow in group view
            : 'rgba(255, 212, 0, 0.25)';
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        });
      }

      // --- Group outline (slide overview) ---
      if (groupOutlineRect) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 122, 255, 0.9)'; // blue border
        ctx.lineWidth = 2;
        const r = groupOutlineRect;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }

      // 2) Highlight the currently selected mark on top
      if (!selectedRect) return;

      // soft halo
      ctx.beginPath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = inGroupView ? 7 : 6;
      ctx.strokeStyle = inGroupView
        ? 'rgba(255, 212, 0, 0.65)' // stronger halo in group view
        : 'rgba(255, 212, 0, 0.35)';
      ctx.strokeRect(selectedRect.x, selectedRect.y, selectedRect.w, selectedRect.h);

      // crisp edge
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

    // initial draw
    draw(Boolean(flashRect));

    // clear flash after 1200ms but keep the outline
    let t: number | undefined;
    if (flashRect) t = window.setTimeout(() => draw(false), 1200);
    return () => { if (t) window.clearTimeout(t); };
  }, [
    flashRect,
    selectedRect,
    groupRects,
    groupOutlineRect,    // NEW: redraw when groupRects change
    currentCanvas,       // toggles when we swap front/back
    isLoading,           // re-run once the page finished rendering
    zoom,
    pageNumber,
    showMarks,
  ]);



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
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 300
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
    prevProps.groupRects === nextProps.groupRects && // reference equality is enough
    prevProps.groupOutlineRect === nextProps.groupOutlineRect &&
    prevProps.showMarks === nextProps.showMarks
  );
});
