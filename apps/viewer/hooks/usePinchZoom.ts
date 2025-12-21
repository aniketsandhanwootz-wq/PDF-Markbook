// apps/viewer/hooks/usePinchZoom.ts
'use client';

import { useEffect, MutableRefObject } from 'react';

type UsePinchZoomOptions = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  zoomRef: MutableRefObject<number>;

  /**
   * Preferred path for touch: set the zoom value only (no scroll math inside).
   * This hook will compute scrollLeft/scrollTop to keep the pinch center stable.
   * Should return the *actual* zoom after clamp/quantize.
   */
  setZoomOnly?: (nextZoomRaw: number) => number;

  /**
   * Back-compat: existing API that sets zoom and also adjusts scroll.
   * If setZoomOnly isn't provided, the hook will fall back to this.
   */
  zoomAt?: (nextZoomRaw: number, clientX: number, clientY: number) => void;

  clampZoom: (z: number) => number;
  enabled: boolean;
};

export default function usePinchZoom({
  containerRef,
  zoomRef,
  setZoomOnly,
  zoomAt,
  clampZoom,
  enabled,
}: UsePinchZoomOptions) {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || !(window as any).PointerEvent) return;

    const el = containerRef.current;
    if (!el) return;

    // ✅ Default: allow normal one-finger scroll.
    // During 2-finger gestures we temporarily switch to touch-action:none.
    const prevTouchAction = el.style.touchAction;
    const prevOverflow = el.style.overflow;
    const prevOverflowX = el.style.overflowX;
    const prevOverflowY = el.style.overflowY;
    el.style.touchAction = 'pan-x pan-y';

    const pointers = new Map<number, { x: number; y: number }>();

    // --- Pinch state (gesture-wide baseline) ---
    let isPinching = false;
    let baseZoom = 1;
    let baseDistance = 0;
    let baseContentX = 0;
    let baseContentY = 0;
    let baseCenterClientX = 0;
    let baseCenterClientY = 0;

    // Smoothing / filtering
    let lastAppliedZoom = zoomRef.current || 1;
    let smoothedCenterX = 0;
    let smoothedCenterY = 0;

    // rAF throttle so we only apply one update per frame
    let raf: number | null = null;
    let latestP1: { x: number; y: number } | null = null;
    let latestP2: { x: number; y: number } | null = null;

    const MIN_ZOOM_CHANGE = 0.004; // ~0.4% steps (prevents micro-jitter)
    const CENTER_SMOOTHING = 0.35;
    const ZOOM_SMOOTHING = 0.25;

    const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p2.x - p1.x, p2.y - p1.y);

    const center = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    });

    const getTwoPointers = () => {
      const it = pointers.values();
      const p1 = it.next().value as { x: number; y: number } | undefined;
      const p2 = it.next().value as { x: number; y: number } | undefined;
      if (!p1 || !p2) return null;
      return { p1, p2 };
    };

    const beginPinchIfReady = () => {
      if (isPinching) return;
      if (pointers.size < 2) return;

      const two = getTwoPointers();
      if (!two) return;
      const { p1, p2 } = two;

      // Gesture baseline: lock reference zoom + reference content point
      baseZoom = zoomRef.current || 1;
      baseDistance = distance(p1, p2) || 1;

      const c = center(p1, p2);
      baseCenterClientX = c.x;
      baseCenterClientY = c.y;

      const rect = el.getBoundingClientRect();
      const centerXInEl = baseCenterClientX - rect.left;
      const centerYInEl = baseCenterClientY - rect.top;

      // This is the KEY: lock the content point under the fingers at gesture-start.
      baseContentX = el.scrollLeft + centerXInEl;
      baseContentY = el.scrollTop + centerYInEl;

      lastAppliedZoom = baseZoom;
      smoothedCenterX = centerXInEl;
      smoothedCenterY = centerYInEl;

      // Own the 2-finger gesture (prevents browser scroll/zoom fights)
      isPinching = true;
      el.style.touchAction = 'none';
      // Disable direct scrolling while pinching (we will set scrollLeft/Top manually)
      el.style.overflow = 'hidden';
      el.style.overflowX = 'hidden';
      el.style.overflowY = 'hidden';
    };

    const endPinch = () => {
      if (!isPinching) return;
      isPinching = false;
      baseDistance = 0;

      // Restore styles
      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;
      el.style.overflowX = prevOverflowX;
      el.style.overflowY = prevOverflowY;
    };

    const applyPinchFrame = () => {
      raf = null;
      if (!isPinching) return;
      if (!latestP1 || !latestP2) return;
      if (!baseDistance) return;

      const p1 = latestP1;
      const p2 = latestP2;

      const currDist = distance(p1, p2);
      const c = center(p1, p2);

      const rect = el.getBoundingClientRect();
      const centerXInEl = c.x - rect.left;
      const centerYInEl = c.y - rect.top;

      // Smooth center movement (reduces jitter from natural finger micro-moves)
      smoothedCenterX = smoothedCenterX + (centerXInEl - smoothedCenterX) * CENTER_SMOOTHING;
      smoothedCenterY = smoothedCenterY + (centerYInEl - smoothedCenterY) * CENTER_SMOOTHING;

      const rawFactor = currDist / baseDistance;
      const desiredZoom = clampZoom(baseZoom * rawFactor);

      // Smooth zoom change (prevents 'snap')
      const smoothedZoom = lastAppliedZoom + (desiredZoom - lastAppliedZoom) * ZOOM_SMOOTHING;
      const nextZoom = clampZoom(smoothedZoom);

      if (Math.abs(nextZoom - lastAppliedZoom) < MIN_ZOOM_CHANGE) {
        // Still update scroll to follow center movement even if zoom doesn't change much
        const scale = lastAppliedZoom / baseZoom;
        el.scrollLeft = baseContentX * scale - smoothedCenterX;
        el.scrollTop = baseContentY * scale - smoothedCenterY;
        return;
      }

      // Update zoom (preferred) + compute scroll so the original content point stays under the current center
      const appliedZoom =
        typeof setZoomOnly === 'function'
          ? setZoomOnly(nextZoom)
          : (zoomAt ? (zoomAt(nextZoom, c.x, c.y), nextZoom) : nextZoom);

      lastAppliedZoom = appliedZoom;

      const scale = appliedZoom / baseZoom;
      el.scrollLeft = baseContentX * scale - smoothedCenterX;
      el.scrollTop = baseContentY * scale - smoothedCenterY;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      // Capture so we keep receiving events even if fingers drift off the element.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // As soon as 2 fingers are down, start pinch ownership (standard PDF/map viewer behavior)
      if (pointers.size >= 2) {
        beginPinchIfReady();
        // Stop any scroll momentum as early as possible
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size < 2) return;

      beginPinchIfReady();
      if (!isPinching) return;

      // rAF-throttle the heavy work
      const two = getTwoPointers();
      if (!two) return;

      latestP1 = two.p1;
      latestP2 = two.p2;

      if (raf == null) raf = requestAnimationFrame(applyPinchFrame);

      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      if (pointers.size < 2) {
        if (raf != null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
        latestP1 = null;
        latestP2 = null;
        endPinch();
      }
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      latestP1 = null;
      latestP2 = null;

      // Restore styles
      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;
      el.style.overflowX = prevOverflowX;
      el.style.overflowY = prevOverflowY;

      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerEnd as any);
      el.removeEventListener('pointercancel', onPointerEnd as any);
    };
  }, [enabled, setZoomOnly, zoomAt, clampZoom, containerRef, zoomRef]);
}
