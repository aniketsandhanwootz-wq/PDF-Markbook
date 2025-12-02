// apps/viewer/hooks/usePinchZoom.ts
'use client';

import { useEffect, MutableRefObject } from 'react';

type UsePinchZoomOptions = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  zoomRef: MutableRefObject<number>;
  zoomAt: (nextZoomRaw: number, clientX: number, clientY: number) => void;
  clampZoom: (z: number) => number;
  enabled: boolean;
};

export default function usePinchZoom({
  containerRef,
  zoomRef,
  zoomAt,
  clampZoom,
  enabled,
}: UsePinchZoomOptions) {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || !(window as any).PointerEvent) return;

    const el = containerRef.current;
    if (!el) return;

    // ✅ Allow vertical scroll, but still let us handle custom pinch zoom.
    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = 'pan-x pan-y';

    const pointers = new Map<number, { x: number; y: number; t: number }>();

    let isPinching = false;

    // Baseline for the WHOLE gesture (no per-frame reset)
    let baseZoom = 1;
    let baseDistance = 0;

    // Last known center (for anchoring)
    let pinchCenter = { x: 0, y: 0 };

    // Local zoom “emitter” to smooth jitter
    let lastEmittedZoom = zoomRef.current || 1;

    const PINCH_START_THRESHOLD = 8;  // px change before we consider it a real pinch
    const MIN_ZOOM_CHANGE = 0.01;     // ~1% step → less jittery than before

    const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p2.x - p1.x, p2.y - p1.y);

    const center = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
      });

      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        baseDistance = distance(p1, p2) || 1;
        baseZoom = zoomRef.current || 1;
        lastEmittedZoom = baseZoom;
        pinchCenter = center(p1, p2);
        isPinching = false; // will flip true once threshold is crossed
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
      });

      // Only care about pinch (2 fingers)
      if (pointers.size !== 2) return;

      const [p1, p2] = Array.from(pointers.values());
      const currDist = distance(p1, p2);

      if (!isPinching) {
        if (Math.abs(currDist - baseDistance) > PINCH_START_THRESHOLD) {
          isPinching = true;
          // Lock scroll during the *actual* pinch so browser doesn’t fight us
          el.style.overflowY = 'hidden';
        } else {
          return;
        }
      }

      if (!baseDistance) return;

      // Keep anchor at the current finger center
      pinchCenter = center(p1, p2);

      // Scale relative to gesture-start distance
      const rawFactor = currDist / baseDistance;
      const rawZoom = baseZoom * rawFactor;
      const targetZoom = clampZoom(rawZoom);

      // Ignore microscopic zoom changes
      if (Math.abs(targetZoom - lastEmittedZoom) < MIN_ZOOM_CHANGE) return;

      // 🔥 Smoothing: move 35% towards target each frame (low-pass filter)
      const SMOOTHING = 0.35;
      const smoothedZoom =
        lastEmittedZoom + (targetZoom - lastEmittedZoom) * SMOOTHING;
      lastEmittedZoom = smoothedZoom;

      zoomAt(smoothedZoom, pinchCenter.x, pinchCenter.y);

      // During the pinch we "own" the gesture to prevent weirdness,
      // but this only applies while two fingers are down.
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      if (isPinching && pointers.size < 2) {
        isPinching = false;
        // Restore scroll after pinch ends
        el.style.overflowY = '';
      }

      if (pointers.size === 0) {
        isPinching = false;
        baseDistance = 0;
      }
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      el.style.touchAction = prevTouchAction;
      el.style.overflowY = '';

      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerEnd as any);
      el.removeEventListener('pointercancel', onPointerEnd as any);
    };
  }, [enabled, zoomAt, clampZoom, containerRef, zoomRef]);
}
