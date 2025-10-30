'use client';

import { MutableRefObject, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

type PinchOpts = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  setZoom: Dispatch<SetStateAction<number>>;
  zoomRef: MutableRefObject<number>;
  clampZoom: (z: number) => number;
  maxPhoneZoom?: number; // default 3
};

export default function usePinchZoom({
  containerRef,
  setZoom,
  zoomRef,
  clampZoom,
  maxPhoneZoom = 3,
}: PinchOpts) {
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; zoom: number; midX: number; midY: number } | null>(null);
  const shieldRef = useRef<HTMLDivElement | null>(null);

  /** Create an invisible overlay to keep the gesture within the scroller */
  const ensureShield = () => {
    const host = containerRef.current;
    if (!host) return null;
    if (shieldRef.current) return shieldRef.current;

    const sh = document.createElement('div');
    sh.className = 'pinch-gesture-shield';
    sh.setAttribute('aria-hidden', 'true');

    // Avoid using CSS 'inset' (not in TS typing)
    sh.style.position = 'absolute';
    sh.style.top = '0';
    sh.style.right = '0';
    sh.style.bottom = '0';
    sh.style.left = '0';
    sh.style.zIndex = '3';
    sh.style.touchAction = 'none';
    sh.style.background = 'transparent';
    sh.style.pointerEvents = 'auto';

    const cs = window.getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    host.appendChild(sh);
    shieldRef.current = sh;
    return sh;
  };

  const removeShield = () => {
    const host = containerRef.current;
    const sh = shieldRef.current;
    if (host && sh && host.contains(sh)) host.removeChild(sh);
    shieldRef.current = null;
  };

  /** Midpoint + distance between two points */
  const calcMidDist = (pts: { x: number; y: number }[]) => {
    const [p1, p2] = pts;
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return { midX, midY, dist: Math.hypot(dx, dy) };
  };

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    // Detect fallback need (Safari / Android Chrome without PointerEvent)
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroidChrome = /Android/.test(ua) && /Chrome\/\d+/.test(ua) && !/Edg\//.test(ua);
    const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
    const needTouchFallback = isIOS || isAndroidChrome || !hasPointer;

    const pad = () => {
  const cs = window.getComputedStyle(host);
  return {
    l: parseFloat(cs.paddingLeft || '0') || 0,
    t: parseFloat(cs.paddingTop || '0') || 0,
  };
};

    /* -------------------- POINTER EVENTS PATH -------------------- */
    const onPointerDown = (e: PointerEvent) => {
      if (needTouchFallback) return;
      if (!host.contains(e.target as Node)) return;

      // We only care about touch pointers
      if (e.pointerType !== 'touch') return;

      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2) {
        ensureShield();
        const pts = Array.from(pointersRef.current.values());
        const { midX, midY, dist } = calcMidDist(pts);
        const rect = host.getBoundingClientRect();
const p = pad();
pinchStartRef.current = {
  dist: Math.max(1, dist),
  zoom: zoomRef.current,
  midX: midX - rect.left - p.l,
  midY: midY - rect.top - p.t,
};
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (needTouchFallback) return;
      if (e.pointerType !== 'touch') return;
      if (!pointersRef.current.has(e.pointerId)) return;

      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2 && pinchStartRef.current) {
        // Must be passive:false to allow this on some browsers
        e.preventDefault();
        e.stopPropagation(); 

        const pts = Array.from(pointersRef.current.values());
        const { dist } = calcMidDist(pts);
        const start = pinchStartRef.current;
        if (!start || start.dist <= 0) return;

        let next = clampZoom(start.zoom * (dist / start.dist));
        if (window.innerWidth < 600) next = Math.min(next, maxPhoneZoom);

        const prev = zoomRef.current;
        if (Math.abs(next - prev) < 1e-4) return;

        const k = next / prev;
        const contentX = host.scrollLeft + start.midX;
        const contentY = host.scrollTop + start.midY;

        setZoom(next);
        requestAnimationFrame(() => {
          host.scrollLeft = contentX * k - start.midX;
          host.scrollTop = contentY * k - start.midY;
        });
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (needTouchFallback) return;
      if (e.pointerType !== 'touch') return;

      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) {
        pinchStartRef.current = null;
        removeShield();
      }
    };

    /* -------------------- TOUCH FALLBACK (iOS/Android Chrome) -------------------- */
    type TouchState = { startDist: number; startZoom: number; midX: number; midY: number } | null;
    let touchState: TouchState = null;

    const dist2 = (t1: Touch, t2: Touch) =>
      Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const midpoint = (t1: Touch, t2: Touch) => ({
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      if (!needTouchFallback) return;
      if (e.touches.length === 2) {
        e.stopPropagation();
        ensureShield();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const { x, y } = midpoint(t1, t2);
        const d = dist2(t1, t2);
       const rect = host.getBoundingClientRect();
const p = pad();
touchState = {
  startDist: Math.max(1, d),
  startZoom: zoomRef.current,
  midX: x - rect.left - p.l,
  midY: y - rect.top - p.t,
};

      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!needTouchFallback || !touchState) return;
      if (e.touches.length !== 2) {
        touchState = null;
        removeShield();
        return;
      }
      // Must be passive:false on the listener for this to work
      e.preventDefault();
      e.stopPropagation(); 
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const d = dist2(t1, t2);

      let next = clampZoom(touchState.startZoom * (d / touchState.startDist));
      if (window.innerWidth < 600) next = Math.min(next, maxPhoneZoom);

      const prev = zoomRef.current;
      if (Math.abs(next - prev) < 1e-4) return;

      const k = next / prev;
      const contentX = host.scrollLeft + touchState.midX;
      const contentY = host.scrollTop + touchState.midY;

      setZoom(next);
      requestAnimationFrame(() => {
        host.scrollLeft = contentX * k - touchState!.midX;
        host.scrollTop = contentY * k - touchState!.midY;
      });
    };

    const onTouchEnd = () => {
      if (!needTouchFallback) return;
      touchState = null;
      removeShield();
    };

    // Attach listeners — note which ones are passive:false
    host.addEventListener('pointerdown', onPointerDown, { passive: true });
    host.addEventListener('pointermove', onPointerMove, { passive: false });
    host.addEventListener('pointerup', onPointerEnd, { passive: true });
    host.addEventListener('pointercancel', onPointerEnd, { passive: true });
    host.addEventListener('pointerleave', onPointerEnd, { passive: true });

    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerEnd);
      host.removeEventListener('pointercancel', onPointerEnd);
      host.removeEventListener('pointerleave', onPointerEnd);

      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchEnd);

      removeShield();
    };
  }, [containerRef, setZoom, clampZoom, maxPhoneZoom, zoomRef]);
}
