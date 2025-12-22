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

  commitReadyRef: MutableRefObject<((pageNumber: number, zoom: number) => void) | null>;

  // lets page.tsx freeze windowing while pinch/commit is in-flight
  interactionRef?: MutableRefObject<boolean>;
  onHandoffComplete?: () => void;

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
  interactionRef,
  onHandoffComplete,
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
    let pendingAnchorPageNumber: number | null = null; // 1-based pageNumber of anchor page
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
      // compositor hint: reduces flicker on some mobile GPUs
      surface.style.willChange = 'transform';
      surface.style.transformOrigin = '0 0';
      surface.style.transform = `scale(${scale})`;
    };

    const clearVisualScale = () => {
      surface.style.transformOrigin = '';
      surface.style.transform = '';
      surface.style.willChange = '';
    };

    const clampScroll = (left: number, top: number) => {
      const maxL = Math.max(0, el.scrollWidth - el.clientWidth);
      const maxT = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollLeft = Math.max(0, Math.min(left, maxL));
      el.scrollTop = Math.max(0, Math.min(top, maxT));
    };

    const setInteracting = (v: boolean) => {
      if (interactionRef) interactionRef.current = v;
    };

    const finishInteracting = () => {
      setInteracting(false);
      onHandoffComplete?.();
    };

    const startPendingHandoff = () => {
      // One-shot handler triggered by PageCanvas render event
      commitReadyRef.current = (pageNumber: number, renderedZoom: number) => {
        if (!pendingActive) return;
        if (Math.abs(renderedZoom - pendingCommitZoom) > 0.0005) return;

        // Only complete handoff when the page under the fingers (anchor page) is rendered.
        // Otherwise we clear transform too early and you see a blink.
        if (pendingAnchorPageNumber != null && pageNumber !== pendingAnchorPageNumber) return;

        if (pendingAnchor) {
          const next = getScrollFromAnchor(
            pendingAnchor,
            pendingCommitZoom,
            lastCenterX,
            lastCenterY
          );
          // Clear transform first (stop double scaling), then clamp scroll
          clearVisualScale();
          if (next) clampScroll(next.left, next.top);
        } else {
          clearVisualScale();
        }

        pendingActive = false;
        pendingAnchor = null;
        pendingAnchorPageNumber = null;

        if (pendingTimeout != null) {
          window.clearTimeout(pendingTimeout);
          pendingTimeout = null;
        }

        commitReadyRef.current = null;

        // windowing freeze off + recompute visible pages
        finishInteracting();
      };

      // Fallback: don’t get stuck scaled
      pendingTimeout = window.setTimeout(() => {
        if (!pendingActive) return;

        clearVisualScale();
        pendingActive = false;
        pendingAnchor = null;
        pendingAnchorPageNumber = null;
        commitReadyRef.current = null;

        finishInteracting();
      }, 350);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (!el.contains(e.target as Node)) return;

      try {
        (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
      } catch {}

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

      // Use coalesced events when available (helps on fast pinches)
      const coalesced = (e as any).getCoalescedEvents?.();
      const lastEvt =
        coalesced && coalesced.length ? coalesced[coalesced.length - 1] : e;

      pointers.set(e.pointerId, { x: lastEvt.clientX, y: lastEvt.clientY });

      if (pointers.size !== 2) return;

      const [p1, p2] = Array.from(pointers.values());
      const currDist = distance(p1, p2);

      if (!isPinching) {
        if (Math.abs(currDist - baseDistance) > PINCH_START_THRESHOLD) {
          isPinching = true;

          // Freeze windowing immediately
          setInteracting(true);

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

      pendingAnchor = getAnchorFromContentPoint(docX, docY, pendingBaseZoom);
      pendingAnchorPageNumber = pendingAnchor ? pendingAnchor.pageIndex + 1 : null;

      // Keep transform until new render is ready (prevents snap/blink)
      pendingActive = true;
      startPendingHandoff();

      // Commit zoom once (pdf.js render begins)
      setZoomOnly(committedTargetZoom);

      isPinching = false;
      pointers.clear();
      baseDistance = 0;

      el.style.touchAction = prevTouchAction;
      el.style.overflow = prevOverflow;
    };

    const recomputeFinalFromCurrentPointers = () => {
      if (!isPinching) return;
      if (pointers.size !== 2) return;
      if (!baseDistance) return;

      const [p1, p2] = Array.from(pointers.values());
      const currDist = distance(p1, p2);

      const rawZoom = baseZoom * (currDist / (baseDistance || 1));
      lastTargetZoom = clampZoom(rawZoom);

      const rect = el.getBoundingClientRect();
      const c = center(p1, p2);
      lastCenterX = c.x - rect.left;
      lastCenterY = c.y - rect.top;
    };

    const onPointerUp = (e: PointerEvent) => {
      // Update pointer with final coords (fast pinch often misses last move)
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      // If we still have both pointers right now, recompute final center+zoom once
      recomputeFinalFromCurrentPointers();

      pointers.delete(e.pointerId);
      if (pointers.size < 2) finishPinch();
    };

    const onPointerCancel = (e: PointerEvent) => {
      // Update pointer with final coords first
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      recomputeFinalFromCurrentPointers();

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

      // safety: never leave it frozen
      setInteracting(false);

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
    interactionRef,
    onHandoffComplete,
  ]);
}
