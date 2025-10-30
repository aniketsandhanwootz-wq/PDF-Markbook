'use client';

import { MutableRefObject, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

type PinchOpts = {
  // Use HTMLDivElement so scrollLeft/Top are well-typed
  containerRef: MutableRefObject<HTMLDivElement | null>;
  // Use the normal React setter type (covers value and functional form)
  setZoom: Dispatch<SetStateAction<number>>;
  zoomRef: MutableRefObject<number>;
  clampZoom: (z: number) => number;
  maxPhoneZoom?: number; // default 3 on phones
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

  // util
  const calcMidDist = (pts: { x: number; y: number }[]) => {
    const [p1, p2] = pts;
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return { midX, midY, dist: Math.hypot(dx, dy) };
  };

  const ensureShield = () => {
    const host = containerRef.current;
    if (!host) return null;
    if (shieldRef.current) return shieldRef.current;

    const sh = document.createElement('div');
    // Avoid `inset` (not in CSSStyleDeclaration); set each edge explicitly
    sh.style.position = 'absolute';
    sh.style.top = '0';
    sh.style.right = '0';
    sh.style.bottom = '0';
    sh.style.left = '0';
    sh.style.zIndex = '3';
    sh.style.touchAction = 'none';     // <- key to receive pinch
    sh.style.background = 'transparent';
    sh.style.pointerEvents = 'auto';

    sh.setAttribute('aria-hidden', 'true');
    sh.className = 'pinch-gesture-shield';

    // Make container positioned so the shield can cover it
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

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroidChrome = /Android/.test(ua) && /Chrome\/\d+/.test(ua) && !/Edg\//.test(ua);
    const needTouchFallback = isIOS || isAndroidChrome || !(window as any).PointerEvent;

    // ---------- POINTER PATH ----------
    const onPointerDown = (e: PointerEvent) => {
      if (needTouchFallback) return;
      if (!host.contains(e.target as Node)) return;

      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2) {
        ensureShield();
        const pts = Array.from(pointersRef.current.values());
        const { midX, midY, dist } = calcMidDist(pts);

        const rect = host.getBoundingClientRect();
        pinchStartRef.current = {
          dist: Math.max(1, dist),
          zoom: zoomRef.current,
          midX: midX - rect.left,
          midY: midY - rect.top,
        };
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (needTouchFallback) return;
      if (!pointersRef.current.has(e.pointerId)) return;

      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2 && pinchStartRef.current) {
        e.preventDefault(); // stop browser page zoom
        const pts = Array.from(pointersRef.current.values());
        const { dist } = calcMidDist(pts);
        const start = pinchStartRef.current;
        if (start.dist <= 0) return;

        let next = clampZoom(start.zoom * (dist / start.dist));
        if (window.innerWidth < 600) next = Math.min(next, maxPhoneZoom);

        const prev = zoomRef.current;
        if (Math.abs(next - prev) < 1e-4) return;

        const k = next / prev;
        const contentX = host.scrollLeft + start.midX;
        const contentY = host.scrollTop + start.midY;

        // normal React setter works for both forms
        setZoom(next);

        requestAnimationFrame(() => {
          host.scrollLeft = contentX * k - start.midX;
          host.scrollTop = contentY * k - start.midY;
        });
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (needTouchFallback) return;
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) {
        pinchStartRef.current = null;
        removeShield();
      }
    };

    // ---------- TOUCH PATH (iOS/Android Chrome / no PointerEvent) ----------
    type TouchState = { startDist: number; startZoom: number; midX: number; midY: number } | null;
    let touchState: TouchState = null;

    const dist2 = (t1: Touch, t2: Touch) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const midpoint = (t1: Touch, t2: Touch) => ({ x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 });

    const onTouchStart = (e: TouchEvent) => {
      if (!needTouchFallback) return;
      if (e.touches.length === 2) {
        ensureShield();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const { x, y } = midpoint(t1, t2);
        const d = dist2(t1, t2);
        const rect = host.getBoundingClientRect();

        touchState = {
          startDist: Math.max(1, d),
          startZoom: zoomRef.current,
          midX: x - rect.left,
          midY: y - rect.top,
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
      e.preventDefault();

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

    // Listeners
    host.addEventListener('pointerdown', onPointerDown, { passive: true });
    host.addEventListener('pointermove', onPointerMove as any, { passive: false });
    host.addEventListener('pointerup', onPointerEnd, { passive: true });
    host.addEventListener('pointercancel', onPointerEnd, { passive: true });
    host.addEventListener('pointerleave', onPointerEnd, { passive: true });

    host.addEventListener('touchstart', onTouchStart as any, { passive: true });
    host.addEventListener('touchmove', onTouchMove as any, { passive: false });
    host.addEventListener('touchend', onTouchEnd as any, { passive: true });
    host.addEventListener('touchcancel', onTouchEnd as any, { passive: true });

    return () => {
      host.removeEventListener('pointerdown', onPointerDown as any);
      host.removeEventListener('pointermove', onPointerMove as any);
      host.removeEventListener('pointerup', onPointerEnd as any);
      host.removeEventListener('pointercancel', onPointerEnd as any);
      host.removeEventListener('pointerleave', onPointerEnd as any);

      host.removeEventListener('touchstart', onTouchStart as any);
      host.removeEventListener('touchmove', onTouchMove as any);
      host.removeEventListener('touchend', onTouchEnd as any);
      host.removeEventListener('touchcancel', onTouchEnd as any);

      removeShield();
    };
  }, [containerRef, setZoom, clampZoom, maxPhoneZoom]);
}
