// apps/viewer/hooks/usePinchZoom.ts
'use client';

import { useEffect, MutableRefObject } from 'react';

export type PinchAnchor = {
  pageIndex: number; // 0-based
  xAt1: number; // x inside page at scale=1
  yAt1: number; // y inside page at scale=1
};

type UsePinchZoomOptions = {
  containerRef: MutableRefObject<HTMLDivElement | null>;

  /**
   * Element that contains all pages/overlays.
   * We apply a temporary GPU scale transform here during an active pinch.
   */
  contentRef: MutableRefObject<HTMLElement | null>;

  /** Current committed zoom (render zoom). */
  zoomRef: MutableRefObject<number>;

  /**
   * Commit zoom (updates React state + zoomRef via your setZoomQ).
   * Called ONLY once when pinch ends.
   */
  setZoomOnly: (nextZoomRaw: number) => number;

  clampZoom: (z: number) => number;

  /**
   * Optional: improve correctness when your layout includes constant gutters that do not scale.
   * Converts the touch point (in content coords at baseZoom) into a stable document anchor.
   */
  getAnchorFromContentPoint?: (
    contentX: number,
    contentY: number,
    baseZoom: number
  ) => PinchAnchor | null;

  /**
   * Optional: convert stable anchor back into scroll coords for a given zoom + center point.
   */
  getScrollFromAnchor?: (
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
    const contentEl = contentRef.current;
    if (!el || !contentEl) return;

    // Save original styles (we restore on cleanup/end)
    const prevTouchAction = el.style.touchAction;

    const prevTransform = contentEl.style.transform;
    const prevTransformOrigin = contentEl.style.transformOrigin;
    const prevWillChange = contentEl.style.willChange;

    // Default: allow 1-finger scroll.
    el.style.touchAction = 'pan-x pan-y';

    const pointers = new Map<number, { x: number; y: number }>();

    // --- Pinch baseline (captured once per gesture) ---
    let isPinching = false;
    let baseZoom = 1;
    let baseDistance = 0;

    // Content-space point under fingers at pinch-start (content coords at baseZoom)
    let baseContentX = 0;
    let baseContentY = 0;

    // Stable anchor (pageIndex + x/y at scale=1) used for perfect commit w/ constant gutters
    let anchor: PinchAnchor | null = null;

    // Smoothed pinch center (relative to container)
    let centerXInEl = 0;
    let centerYInEl = 0;

    // Latest computed values
    let latestVisualScale = 1;
    let latestFinalZoom = 1;

    // rAF throttle
    let raf: number | null = null;
    let latestP1: { x: number; y: number } | null = null;
    let latestP2: { x: number; y: number } | null = null;

    // Tune for “standard viewer feel”
    const CENTER_SMOOTHING = 0.28; // center wobble smoothing
    const MIN_SCALE_CHANGE = 0.0012; // dead-zone to remove micro jitter
    const ZOOM_SMOOTHING = 0.08; // small zoom smoothing helps a lot on phones

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

    const beginPinch = () => {
      if (isPinching) return;
      if (pointers.size < 2) return;

      const two = getTwoPointers();
      if (!two) return;

      const { p1, p2 } = two;

      baseZoom = zoomRef.current || 1;
      baseDistance = distance(p1, p2) || 1;

      const c = center(p1, p2);
      const rect = el.getBoundingClientRect();
      const cx = c.x - rect.left;
      const cy = c.y - rect.top;

      centerXInEl = cx;
      centerYInEl = cy;

      baseContentX = el.scrollLeft + cx;
      baseContentY = el.scrollTop + cy;

      anchor =
        typeof getAnchorFromContentPoint === 'function'
          ? getAnchorFromContentPoint(baseContentX, baseContentY, baseZoom)
          : null;

      latestVisualScale = 1;
      latestFinalZoom = baseZoom;

      isPinching = true;

      // Own the gesture
      el.style.touchAction = 'none';

      // Smooth visual scaling during pinch
      contentEl.style.transformOrigin = '0 0';
      contentEl.style.willChange = 'transform';
    };

    const applyScrollClamped = (left: number, top: number) => {
      const maxL = Math.max(0, el.scrollWidth - el.clientWidth);
      const maxT = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollLeft = Math.max(0, Math.min(left, maxL));
      el.scrollTop = Math.max(0, Math.min(top, maxT));
    };

    const applyFrame = () => {
      raf = null;
      if (!isPinching) return;
      if (!latestP1 || !latestP2) return;
      if (!baseDistance) return;

      const p1 = latestP1;
      const p2 = latestP2;

      const currDist = distance(p1, p2);
      const c = center(p1, p2);

      const rect = el.getBoundingClientRect();
      const rawCx = c.x - rect.left;
      const rawCy = c.y - rect.top;

      // Smooth center to reduce “vibration”
      centerXInEl = centerXInEl + (rawCx - centerXInEl) * CENTER_SMOOTHING;
      centerYInEl = centerYInEl + (rawCy - centerYInEl) * CENTER_SMOOTHING;

      const rawZoom = clampZoom(baseZoom * (currDist / baseDistance));
      latestFinalZoom = rawZoom;

      // Visual scale (smoothed)
      const desiredScale = rawZoom / baseZoom;
      const nextScale =
        ZOOM_SMOOTHING > 0
          ? latestVisualScale + (desiredScale - latestVisualScale) * ZOOM_SMOOTHING
          : desiredScale;

      if (Math.abs(nextScale - latestVisualScale) < MIN_SCALE_CHANGE) {
        // still pan smoothly with center movement
        const s = latestVisualScale || 1;
        applyScrollClamped(baseContentX - centerXInEl / s, baseContentY - centerYInEl / s);
        return;
      }

      latestVisualScale = nextScale;

      // Apply GPU transform (no pdf.js re-render during pinch)
      contentEl.style.transform = `translate3d(0,0,0) scale(${latestVisualScale})`;

      // Keep the same content point under the pinch center:
      // screen = (content - scroll) * scale  => scroll = content - center/scale
      applyScrollClamped(
        baseContentX - centerXInEl / latestVisualScale,
        baseContentY - centerYInEl / latestVisualScale
      );
    };

    const endPinch = () => {
      if (!isPinching) return;
      isPinching = false;
      baseDistance = 0;

      // Clear temporary transform
      contentEl.style.transform = prevTransform;
      contentEl.style.transformOrigin = prevTransformOrigin;
      contentEl.style.willChange = prevWillChange;

      // Restore default behavior
      el.style.touchAction = prevTouchAction;

      // Commit zoom ONCE (this stops the “vibration”)
      const committed = setZoomOnly(latestFinalZoom);

      // After layout updates at committed zoom, correct scroll precisely
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const rect = el.getBoundingClientRect();
          const cx = Math.max(0, Math.min(rect.width, centerXInEl));
          const cy = Math.max(0, Math.min(rect.height, centerYInEl));

          let targetLeft: number;
          let targetTop: number;

          if (anchor && typeof getScrollFromAnchor === 'function') {
            const v = getScrollFromAnchor(anchor, committed, cx, cy);
            targetLeft = v?.left ?? 0;
            targetTop = v?.top ?? 0;
          } else {
            const scale = committed / baseZoom;
            targetLeft = baseContentX * scale - cx;
            targetTop = baseContentY * scale - cy;
          }

          applyScrollClamped(targetLeft, targetTop);
        });
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2) {
        beginPinch();
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;

      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size < 2) return;

      beginPinch();
      if (!isPinching) return;

      const two = getTwoPointers();
      if (!two) return;

      latestP1 = two.p1;
      latestP2 = two.p2;

      if (raf == null) raf = requestAnimationFrame(applyFrame);

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

      el.style.touchAction = prevTouchAction;

      contentEl.style.transform = prevTransform;
      contentEl.style.transformOrigin = prevTransformOrigin;
      contentEl.style.willChange = prevWillChange;

      el.removeEventListener('pointerdown', onPointerDown as any);
      el.removeEventListener('pointermove', onPointerMove as any);
      el.removeEventListener('pointerup', onPointerEnd as any);
      el.removeEventListener('pointercancel', onPointerEnd as any);
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
