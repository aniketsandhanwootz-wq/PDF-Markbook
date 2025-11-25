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
    let pinchCenterX = 0;
    let pinchCenterY = 0;

    // Thresholds
    const PINCH_THRESHOLD = 10; // pixels - must change by this much to start pinch
    const MOMENTUM_DURATION = 300;
    const MOMENTUM_DECAY = 0.92;

    // Momentum state
    let velocityHistory: Array<{ factor: number; t: number }> = [];
    let momentumRaf: number | null = null;

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
      const recent = velocityHistory.filter(v => now - v.t < 150);
      
      if (recent.length < 2) {
        velocityHistory = [];
        return;
      }

      // Calculate average zoom factor
      let avgFactor = recent.reduce((acc, v) => acc * v.factor, 1);
      avgFactor = Math.pow(avgFactor, 1 / recent.length);
      
      // Only apply if there's meaningful velocity
      const velocityMagnitude = Math.abs(Math.log(avgFactor));
      if (velocityMagnitude < 0.005) {
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

        // Exponential decay
        const decay = Math.pow(MOMENTUM_DECAY, elapsed / 16);
        const factor = Math.pow(avgFactor, decay * 0.5);
        const nextZoom = clampZoom(startZoom * Math.pow(factor, 1 - progress));

        zoomAt(nextZoom, pinchCenterX, pinchCenterY);

        momentumRaf = requestAnimationFrame(tick);
      };

      momentumRaf = requestAnimationFrame(tick);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only handle touch/pen, not mouse (let mouse wheel handle zoom)
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });

      // Check if this starts a pinch (2 fingers)
      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        initialDistance = getDistance(p1, p2);
        initialZoom = zoomRef.current;
        
        const center = getCenter(p1, p2);
        pinchCenterX = center.x;
        pinchCenterY = center.y;
        
        // Don't mark as pinching yet - wait for movement threshold
        isPinching = false;
        velocityHistory = [];
        
        // Cancel any momentum
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

      // Only handle pinch if we have exactly 2 pointers
      if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        const currentDistance = getDistance(p1, p2);
        
        // Start pinching if we've moved past threshold
        if (!isPinching && Math.abs(currentDistance - initialDistance) > PINCH_THRESHOLD) {
          isPinching = true;
          
          // Disable scroll during pinch
          el.style.overflow = 'hidden';
        }

        if (isPinching && initialDistance > 0) {
          const center = getCenter(p1, p2);
          
          // Calculate zoom factor
          const factor = currentDistance / initialDistance;
          const targetZoom = clampZoom(initialZoom * factor);
          
          // Track velocity for momentum
          const prevZoom = zoomRef.current;
          if (prevZoom > 0) {
            const frameFactor = targetZoom / prevZoom;
            velocityHistory.push({ factor: frameFactor, t: now });
            
            // Keep only recent history
            if (velocityHistory.length > 10) velocityHistory.shift();
          }

          // Apply zoom around the pinch center
          zoomAt(targetZoom, center.x, center.y);
          
          // Update center for momentum
          pinchCenterX = center.x;
          pinchCenterY = center.y;

          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      // If we were pinching and now have < 2 fingers, end pinch
      if (isPinching && pointers.size < 2) {
        isPinching = false;
        
        // Re-enable scroll
        el.style.overflow = '';
        
        // Apply momentum if we have velocity
        applyMomentum();
      }

      // Reset if no pointers left
      if (pointers.size === 0) {
        isPinching = false;
        initialDistance = 0;
        velocityHistory = [];
      }

      el.releasePointerCapture?.(e.pointerId);
    };

    // Event listeners
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
