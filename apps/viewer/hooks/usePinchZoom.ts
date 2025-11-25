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

    // ===== STATE =====
    const pointers = new Map<number, { x: number; y: number; t: number }>();

    let isPinching = false;
    let baseZoom = 1;          // Zoom when pinch started
    let baseDistance = 0;      // Distance when pinch started
    let baseCenterX = 0;       // Screen X when pinch started
    let baseCenterY = 0;       // Screen Y when pinch started

    // Velocity tracking for momentum
    let velocityQueue: Array<{ factor: number; t: number }> = [];
    let momentumRaf: number | null = null;

    // ===== TUNABLE CONSTANTS =====
    const PINCH_START_THRESHOLD = 20;    // px - how much fingers must move to start pinch
    const MIN_ZOOM_CHANGE = 0.003;        // skip micro-changes to reduce jitter
    const MOMENTUM_ENABLED = true;        // set false to disable momentum
    const MOMENTUM_DURATION_MS = 200;
    const MOMENTUM_DECAY = 0.88;
    const MOMENTUM_MIN_VELOCITY = 0.01;

    // ===== HELPERS =====
    const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p2.x - p1.x, p2.y - p1.y);

    const center = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    });

    // ===== MOMENTUM =====
    const applyMomentum = () => {
      if (!MOMENTUM_ENABLED) return;
      if (momentumRaf) cancelAnimationFrame(momentumRaf);

      const now = performance.now();
      const recent = velocityQueue.filter(v => now - v.t < 100);

      if (recent.length < 2) {
        velocityQueue = [];
        return;
      }

      // Geometric mean of factors
      let avgFactor = recent.reduce((acc, v) => acc * v.factor, 1);
      avgFactor = Math.pow(avgFactor, 1 / recent.length);

      const velocity = Math.abs(Math.log(avgFactor));
      if (velocity < MOMENTUM_MIN_VELOCITY) {
        velocityQueue = [];
        return;
      }

      const startZoom = zoomRef.current;
      const startTime = performance.now();

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = elapsed / MOMENTUM_DURATION_MS;

        if (progress >= 1) {
          momentumRaf = null;
          velocityQueue = [];
          return;
        }

        // Exponential decay
        const decayFactor = Math.pow(MOMENTUM_DECAY, elapsed / 16);
        const scaledFactor = Math.pow(avgFactor, decayFactor * 0.3);
        const nextZoom = clampZoom(startZoom * Math.pow(scaledFactor, 1 - progress));

        // Use last known center
        zoomAt(nextZoom, baseCenterX, baseCenterY);

        momentumRaf = requestAnimationFrame(tick);
      };

      momentumRaf = requestAnimationFrame(tick);
    };

    // ===== EVENT HANDLERS =====
    const onPointerDown = (e: PointerEvent) => {
      // Only handle touch/pen (not mouse)
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
      });

      // When 2nd finger lands, prepare pinch state
      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());

        baseDistance = distance(p1, p2);
        baseZoom = zoomRef.current;

        const c = center(p1, p2);
        baseCenterX = c.x;
        baseCenterY = c.y;

        isPinching = false;  // not pinching yet (wait for threshold)
        velocityQueue = [];

        // Cancel any ongoing momentum
        if (momentumRaf) {
          cancelAnimationFrame(momentumRaf);
          momentumRaf = null;
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      const now = performance.now();
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: now,
      });

      // Only process if exactly 2 fingers
      if (pointers.size !== 2) return;

      const [p1, p2] = Array.from(pointers.values());
      const currentDist = distance(p1, p2);

      // Activate pinch only after threshold movement
      if (!isPinching) {
        if (Math.abs(currentDist - baseDistance) > PINCH_START_THRESHOLD) {
          isPinching = true;
          // Temporarily disable scroll during pinch
          el.style.overflow = 'hidden';
        } else {
          return; // still waiting for threshold
        }
      }

      if (baseDistance === 0) return;

      // === CRITICAL: Use CURRENT center, not the base center ===
      // This is the key to proper anchor locking
      const currentCenter = center(p1, p2);

      // Calculate target zoom from initial state
      const scaleFactor = currentDist / baseDistance;
      const targetZoom = clampZoom(baseZoom * scaleFactor);

      // Skip micro-changes to reduce jitter
      if (Math.abs(targetZoom - zoomRef.current) < MIN_ZOOM_CHANGE) {
        return;
      }

      // Track velocity for momentum
      const prevZoom = zoomRef.current;
      if (prevZoom > 0) {
        const frameFactor = targetZoom / prevZoom;
        velocityQueue.push({ factor: frameFactor, t: now });
        if (velocityQueue.length > 6) velocityQueue.shift();
      }

      // Apply zoom anchored at CURRENT center
      zoomAt(targetZoom, currentCenter.x, currentCenter.y);

      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      // Pinch ending (went from 2+ fingers to <2)
      if (isPinching && pointers.size < 2) {
        isPinching = false;
        el.style.overflow = ''; // Re-enable scroll
        applyMomentum();
      }

      // All fingers lifted
      if (pointers.size === 0) {
        isPinching = false;
        baseDistance = 0;
        velocityQueue = [];
      }

      el.releasePointerCapture?.(e.pointerId);
    };

    // ===== ATTACH LISTENERS =====
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