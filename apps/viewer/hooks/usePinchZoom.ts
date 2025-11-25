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

    // Pointer tracking
    const pointers = new Map<number, { x: number; y: number; t: number }>();

    // Pinch state
    let isPinching = false;
    let initialDistance = 0;
    let initialZoom = 1;
    let lastCenter = { x: 0, y: 0 };

    // Smoothing / filtering
    const PINCH_THRESHOLD = 15; // Higher threshold = less accidental pinch
    const MIN_ZOOM_DELTA = 0.002; // Skip tiny zoom changes to reduce jitter

    // Momentum (conservative)
    let velocityHistory: Array<{ factor: number; t: number }> = [];
    let momentumRaf: number | null = null;
    const MOMENTUM_DURATION = 250;
    const MOMENTUM_DECAY = 0.90;

    const getDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      return Math.hypot(p2.x - p1.x, p2.y - p1.y);
    };

    const getCenter = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2,
      };
    };

    const applyMomentum = () => {
      if (momentumRaf) cancelAnimationFrame(momentumRaf);

      const now = performance.now();
      const recent = velocityHistory.filter(v => now - v.t < 120);

      if (recent.length < 2) {
        velocityHistory = [];
        return;
      }

      // Geometric mean of zoom factors
      let avgFactor = recent.reduce((acc, v) => acc * v.factor, 1);
      avgFactor = Math.pow(avgFactor, 1 / recent.length);

      const velocityMagnitude = Math.abs(Math.log(avgFactor));
      if (velocityMagnitude < 0.008) {
        velocityHistory = [];
        return;
      }

      const startZoom = zoomRef.current;
      const startTime = performance.now();

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = elapsed / MOMENTUM_DURATION;

        if (progress >= 1) {
          momentumRaf = null;
          velocityHistory = [];
          return;
        }

        const decay = Math.pow(MOMENTUM_DECAY, elapsed / 16);
        const factor = Math.pow(avgFactor, decay * 0.4);
        const nextZoom = clampZoom(startZoom * Math.pow(factor, 1 - progress));

        zoomAt(nextZoom, lastCenter.x, lastCenter.y);

        momentumRaf = requestAnimationFrame(tick);
      };

      momentumRaf = requestAnimationFrame(tick);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });

      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        initialDistance = getDistance(p1, p2);
        initialZoom = zoomRef.current;

        const center = getCenter(p1, p2);
        lastCenter = center;

        isPinching = false;
        velocityHistory = [];

        if (momentumRaf) {
          cancelAnimationFrame(momentumRaf);
          momentumRaf = null;
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      const now = performance.now();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });

      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        const currentDistance = getDistance(p1, p2);

        // Start pinching only after threshold
        if (!isPinching && Math.abs(currentDistance - initialDistance) > PINCH_THRESHOLD) {
          isPinching = true;
          el.style.overflow = 'hidden';
        }

        if (isPinching && initialDistance > 0) {
          const center = getCenter(p1, p2);
          lastCenter = center;

          const factor = currentDistance / initialDistance;
          const targetZoom = clampZoom(initialZoom * factor);

          // Skip tiny changes to reduce jitter
          const zoomDelta = Math.abs(targetZoom - zoomRef.current);
          if (zoomDelta < MIN_ZOOM_DELTA) return;

          // Track velocity
          const prevZoom = zoomRef.current;
          if (prevZoom > 0) {
            const frameFactor = targetZoom / prevZoom;
            velocityHistory.push({ factor: frameFactor, t: now });
            if (velocityHistory.length > 8) velocityHistory.shift();
          }

          // Apply zoom immediately
          zoomAt(targetZoom, center.x, center.y);

          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      if (isPinching && pointers.size < 2) {
        isPinching = false;
        el.style.overflow = '';
        applyMomentum();
      }

      if (pointers.size === 0) {
        isPinching = false;
        initialDistance = 0;
        velocityHistory = [];
      }

      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      if (momentumRaf) cancelAnimationFrame(momentumRaf);

      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerEnd as any);
      el.removeEventListener('pointercancel', onPointerEnd as any);
    };
  }, [enabled, containerRef.current, zoomAt, clampZoom]);
}