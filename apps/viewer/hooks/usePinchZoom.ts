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

    const pointers = new Map<number, { x: number; y: number; t: number }>();

    let isPinching = false;
    let baseZoom = 1;
    let baseDistance = 0;

    const PINCH_START_THRESHOLD = 8;
    const MIN_ZOOM_CHANGE = 0.0005;

    const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p2.x - p1.x, p2.y - p1.y);

    const center = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
      });

      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        baseDistance = distance(p1, p2);
        baseZoom = zoomRef.current;
        isPinching = false;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
      });

      if (pointers.size !== 2) return;

      const [p1, p2] = Array.from(pointers.values());
      const currentDist = distance(p1, p2);

      if (!isPinching) {
        if (Math.abs(currentDist - baseDistance) > PINCH_START_THRESHOLD) {
          isPinching = true;
          el.style.overflow = 'hidden';
        } else {
          return;
        }
      }

      if (baseDistance === 0) return;

      const currentCenter = center(p1, p2);
      const factor = currentDist / baseDistance;
      const targetZoom = clampZoom(baseZoom * factor);

      if (Math.abs(targetZoom - zoomRef.current) < MIN_ZOOM_CHANGE) return;

      zoomAt(targetZoom, currentCenter.x, currentCenter.y);

      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      if (isPinching && pointers.size < 2) {
        isPinching = false;
        el.style.overflow = '';
      }

      if (pointers.size === 0) {
        isPinching = false;
        baseDistance = 0;
      }

      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerEnd as any);
      el.removeEventListener('pointercancel', onPointerEnd as any);
    };
  }, [enabled, zoomAt, clampZoom, containerRef, zoomRef]);
}