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

  // Commit zoom ONCE at gesture end (prevents pdf.js re-render vibration)
  setZoomOnly: (nextZoom: number) => void;

  clampZoom: (z: number) => number;

  // Convert a content point (scroll coords) to stable document anchor
  getAnchorFromContentPoint: (
    contentX: number,
    contentY: number,
    baseZoom: number
  ) => PinchAnchor | null;

  // Convert stable anchor back to scrollLeft/scrollTop for a zoom + viewport center
  getScrollFromAnchor: (
    anchor: PinchAnchor,
    zoom: number,
    centerXInEl: number,
    centerYInEl: number
  ) => { left: number; top: number } | null;

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

    // During pinch we scale the surface (visual) without committing zoom.
    // lastScale = (visualZoom / baseZoom)
    let lastScale = 1;

    let lastTargetZoom = 1;

    // We keep the pinch center in element coords for final commit.
    let lastCenterX = 0;
    let lastCenterY = 0;

    const PINCH_START_THRESHOLD = 8;  // px
    const MIN_ZOOM_CHANGE = 0.0025;   // ~0.25% (prevents jitter)

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

          // During pinch: we own the gesture.
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

      // Keep the *same document point* under the pinch center when scale changes.
      // Convert current visual scroll to "unscaled" content coords using lastScale.
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

      const container = el;
      const committedBaseZoom = baseZoom;
      const committedTargetZoom = lastTargetZoom;

      // Compute the doc point currently under the pinch center in *base layout coords*
      const docX = (container.scrollLeft + lastCenterX) / (lastScale || 1);
      const docY = (container.scrollTop + lastCenterY) / (lastScale || 1);

      // Convert to stable anchor at scale=1 (page index + coords)
      const anchor = getAnchorFromContentPoint(docX, docY, committedBaseZoom);

      // Clear visual transform BEFORE committing zoom
      clearVisualScale();

      // Commit zoom ONCE (pdf.js re-render happens here only)
      setZoomOnly(committedTargetZoom);

      // After commit, scroll so the same anchor stays under the same finger center
      requestAnimationFrame(() => {
        if (!anchor) return;
        const next = getScrollFromAnchor(anchor, committedTargetZoom, lastCenterX, lastCenterY);
        if (!next) return;

        // Clamp to container bounds
        const maxL = Math.max(0, container.scrollWidth - container.clientWidth);
        const maxT = Math.max(0, container.scrollHeight - container.clientHeight);

        container.scrollLeft = Math.max(0, Math.min(next.left, maxL));
        container.scrollTop = Math.max(0, Math.min(next.top, maxT));
      });

      isPinching = false;
      pointers.clear();
      baseDistance = 0;

      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        finishPinch();
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        finishPinch();
      }
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('pointercancel', onPointerCancel, { passive: true });

    return () => {
      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;

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
  ]);
}
