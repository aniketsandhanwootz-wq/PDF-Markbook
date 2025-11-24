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

/**
 * Pointer-based pinch-zoom + one-finger pan for the PDF surface.
 * - Active only when `enabled` is true (we gate this by touch-capable devices).
 * - Uses zoomRef + zoomAt so behaviour matches wheel / HUD zoom.
 */
export default function usePinchZoom({
  containerRef,
  zoomRef,
  zoomAt,
  clampZoom,
  enabled,
}: UsePinchZoomOptions) {
  useEffect(() => {
    if (!enabled) return;

    const el = containerRef.current;
    if (!el) return;

    // Track active pointers
    const pts = new Map<number, { x: number; y: number }>();

    let dragging = false;
    let pinch = false;

    // Drag (one-finger pan)
    let dragStartX = 0;
    let dragStartY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    // Pinch (two-finger zoom)
    let lastMidX = 0;
    let lastMidY = 0;
    let lastDist = 0;

    const getTwo = () => {
      const arr = Array.from(pts.values());
      return [arr[0], arr[1]] as const;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) return;

      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pts.size === 1) {
        // Start one-finger drag
        dragging = true;
        pinch = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        startScrollLeft = el.scrollLeft;
        startScrollTop = el.scrollTop;
      } else if (pts.size === 2) {
        // Start pinch
        dragging = false;
        pinch = true;

        const [p0, p1] = getTwo();
        lastMidX = (p0.x + p1.x) / 2;
        lastMidY = (p0.y + p1.y) / 2;
        lastDist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinch && pts.size >= 2) {
        // Two (or more) fingers → pinch
        const [p0, p1] = getTwo();
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);

        if (lastDist > 0) {
          const factor = dist / lastDist;
          const next = clampZoom(zoomRef.current * factor);

          // Zoom around pinch midpoint
          zoomAt(next, midX, midY);

          // Pan by midpoint drift so content stays under the fingers
          el.scrollLeft -= (midX - lastMidX);
          el.scrollTop -= (midY - lastMidY);
        }

        lastMidX = midX;
        lastMidY = midY;
        lastDist = dist;

        e.preventDefault();
        e.stopPropagation();
      } else if (dragging && pts.size === 1) {
        // One-finger drag → pan when zoomed
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;

        el.scrollLeft = startScrollLeft - dx;
        el.scrollTop = startScrollTop - dy;

        e.preventDefault();
        e.stopPropagation();
      }
    };

    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);

      if (pts.size < 2) {
        pinch = false;
        lastDist = 0;
      }
      if (pts.size === 0) {
        dragging = false;
      }

      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', end, { passive: true });
    el.addEventListener('pointercancel', end, { passive: true });
    el.addEventListener('pointerleave', end, { passive: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', end as any);
      el.removeEventListener('pointercancel', end as any);
      el.removeEventListener('pointerleave', end as any);
    };
  }, [containerRef, zoomRef, zoomAt, clampZoom, enabled]);
}
