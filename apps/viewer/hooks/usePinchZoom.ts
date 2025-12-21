// apps/viewer/hooks/usePinchZoom.ts
'use client';

import { useEffect, MutableRefObject } from 'react';

export type PinchAnchor = {
  pageIndex: number; // 0-based
  xAt1: number;      // page-space at scale=1
  yAt1: number;      // page-space at scale=1
};

type UsePinchZoomOptions = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  zoomRef: MutableRefObject<number>;

  // Commit zoom ONCE at gesture end (pdf.js render happens here)
  setZoomOnly: (nextZoom: number) => void;

  clampZoom: (z: number) => number;

  getAnchorFromContentPoint: (
    contentX: number,
    contentY: number,
    baseZoom: number
  ) => PinchAnchor | null;

  getScrollFromAnchor: (
    anchor: PinchAnchor,
    zoom: number,
    centerXInEl: number,
    centerYInEl: number
  ) => { left: number; top: number } | null;

  /**
   * Page.tsx will forward PageCanvas render events into this ref.
   * We set commitReadyRef.current during pinch-end commit; when PageCanvas reports
   * a page rendered at the committed zoom, we do a seamless handoff:
   * scroll-correct + clear transform in the same tick.
   */
  commitReadyRef: MutableRefObject<((pageNumber: number, zoom: number) => void) | null>;

  enabled: boolean;
};

export default function usePinchZoom({
  containerRef,
  contentRef,
  zoomRef,
  setZoomOnly,
  clampZoom,
  getAnchorFromContentPoint,
  getScrollFromAnchor,
  commitReadyRef,
  enabled,
}: UsePinchZoomOptions) {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || !(window as any).PointerEvent) return;

    const el = containerRef.current;
    const surface = contentRef.current;
    if (!el || !surface) return;

    const prevTouchAction = el.style.touchAction;
    const prevOverflow = el.style.overflow;

    const pointers = new Map<number, { x: number; y: number }>();

    let isPinching = false;

    let baseZoom = 1;
    let baseDistance = 0;

    // Visual scale applied to surface during pinch
    let lastScale = 1;

    let lastTargetZoom = 1;

    // Pinch center (element coords) for final anchor/scroll
    let lastCenterX = 0;
    let lastCenterY = 0;

    // Pending commit bookkeeping (to avoid “shiver”)
    let pendingAnchor: PinchAnchor | null = null;
    let pendingCommitZoom = 1;
    let pendingBaseZoom = 1;
    let pendingTimeout: number | null = null;
    let pendingActive = false;

    const PINCH_START_THRESHOLD = 8;  // px
    const MIN_ZOOM_CHANGE = 0.0025;   // ~0.25%

    const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p2.x - p1.x, p2.y - p1.y);

    const center = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    });

    const applyVisualScale = (scale: number) => {
      surface.style.transformOrigin = '0 0';
      surface.style.transform = `scale(${scale})`;
    };

    const clearVisualScale = () => {
      surface.style.transformOrigin = '';
      surface.style.transform = '';
    };

    const clampScroll = (left: number, top: number) => {
      const maxL = Math.max(0, el.scrollWidth - el.clientWidth);
      const maxT = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollLeft = Math.max(0, Math.min(left, maxL));
      el.scrollTop = Math.max(0, Math.min(top, maxT));
    };

    const startPendingHandoff = () => {
      // Setup a one-shot handler that will be triggered by PageCanvas via page.tsx.
      // When a visible page finishes rendering at the committed zoom, we:
      // 1) compute correct scroll at committed zoom
      // 2) clear transform (so we stop double-scaling)
      // This eliminates the pinch-end “snap”.
      commitReadyRef.current = (_pageNumber: number, renderedZoom: number) => {
        if (!pendingActive) return;
        if (Math.abs(renderedZoom - pendingCommitZoom) > 0.0005) return;

        // Do the final scroll correction in committed-zoom space
        if (pendingAnchor) {
          const next = getScrollFromAnchor(pendingAnchor, pendingCommitZoom, lastCenterX, lastCenterY);
          if (next) {
            // IMPORTANT order:
            // - Clear transform first so scroll math matches DOM dimensions at committed zoom
            clearVisualScale();
            clampScroll(next.left, next.top);
          } else {
            clearVisualScale();
          }
        } else {
          clearVisualScale();
        }

        pendingActive = false;
        pendingAnchor = null;

        if (pendingTimeout != null) {
          window.clearTimeout(pendingTimeout);
          pendingTimeout = null;
        }

        commitReadyRef.current = null;
      };

      // Fallback: if render-ready never comes (rare), don’t get stuck scaled.
      pendingTimeout = window.setTimeout(() => {
        if (!pendingActive) return;
        clearVisualScale();
        pendingActive = false;
        pendingAnchor = null;
        commitReadyRef.current = null;
      }, 350);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      try {
        (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        baseDistance = distance(p1, p2) || 1;
        baseZoom = zoomRef.current || 1;

        lastScale = 1;
        lastTargetZoom = baseZoom;

        const rect = el.getBoundingClientRect();
        const c = center(p1, p2);
        lastCenterX = c.x - rect.left;
        lastCenterY = c.y - rect.top;

        isPinching = false;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2) return;

      const [p1, p2] = Array.from(pointers.values());
      const currDist = distance(p1, p2);

      if (!isPinching) {
        if (Math.abs(currDist - baseDistance) > PINCH_START_THRESHOLD) {
          isPinching = true;
          el.style.touchAction = 'none';
          el.style.overflow = 'hidden';
        } else {
          return;
        }
      }

      const rect = el.getBoundingClientRect();
      const c = center(p1, p2);
      const centerX = c.x - rect.left;
      const centerY = c.y - rect.top;

      lastCenterX = centerX;
      lastCenterY = centerY;

      const rawZoom = baseZoom * (currDist / (baseDistance || 1));
      const targetZoom = clampZoom(rawZoom);

      if (Math.abs(targetZoom - lastTargetZoom) < MIN_ZOOM_CHANGE) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      lastTargetZoom = targetZoom;

      const nextScale = (targetZoom / (baseZoom || 1)) || 1;

      // Keep same doc point under fingers while visual scale changes
      const docX = (el.scrollLeft + centerX) / (lastScale || 1);
      const docY = (el.scrollTop + centerY) / (lastScale || 1);

      applyVisualScale(nextScale);

      el.scrollLeft = docX * nextScale - centerX;
      el.scrollTop = docY * nextScale - centerY;

      lastScale = nextScale;

      e.preventDefault();
      e.stopPropagation();
    };

    const finishPinch = () => {
      if (!isPinching) return;

      const committedBaseZoom = baseZoom;
      const committedTargetZoom = lastTargetZoom;

      // doc point currently under center in base-layout coords
      const docX = (el.scrollLeft + lastCenterX) / (lastScale || 1);
      const docY = (el.scrollTop + lastCenterY) / (lastScale || 1);

      pendingBaseZoom = committedBaseZoom;
      pendingCommitZoom = committedTargetZoom;

      // Convert to stable anchor (page + coords at scale=1)
      pendingAnchor = getAnchorFromContentPoint(docX, docY, pendingBaseZoom);

      // IMPORTANT:
      // Do NOT clear transform here. Keep the old bitmap scaled while the new render happens.
      pendingActive = true;
      startPendingHandoff();

      // Commit zoom once (pdf.js render begins; old canvas stays visible until swap)
      setZoomOnly(committedTargetZoom);

      // Gesture cleanup (allow normal scroll again even while we keep transform temporarily)
      isPinching = false;
      pointers.clear();
      baseDistance = 0;

      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) finishPinch();
    };

    const onPointerCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) finishPinch();
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('pointercancel', onPointerCancel, { passive: true });

    return () => {
      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;

      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      pendingTimeout = null;

      pendingActive = false;
      commitReadyRef.current = null;

      clearVisualScale();

      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerUp as any);
      el.removeEventListener('pointercancel', onPointerCancel as any);
    };
  }, [
    enabled,
    containerRef,
    contentRef,
    zoomRef,
    setZoomOnly,
    clampZoom,
    getAnchorFromContentPoint,
    getScrollFromAnchor,
    commitReadyRef,
  ]);
}
