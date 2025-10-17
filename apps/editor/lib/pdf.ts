export function clampZoom(zoom: number): number {
  return Math.max(0.25, Math.min(6.0, zoom));
}

export function fitToWidth(containerWidth: number, pageWidthCSSPx: number): number {
  return containerWidth / pageWidthCSSPx;
}

export function computeZoomForRect(
  container: { w: number; h: number },
  pageSizeAtScale1: { w: number; h: number },
  rectAtScale1: { w: number; h: number },
  fill = 0.75
): number {
  const sx = (container.w * fill) / Math.max(1, rectAtScale1.w);
  const sy = (container.h * fill) / Math.max(1, rectAtScale1.h);
  return clampZoom(Math.min(sx, sy));
}

export function scrollToRect(
  containerEl: HTMLElement,
  pageTopPx: number,
  pageWidthPx: number,
  rectPxAtCurrentZoom: { x: number; y: number; w: number; h: number },
  viewportSize: { w: number; h: number }
) {
  const rectCenterY = pageTopPx + rectPxAtCurrentZoom.y + rectPxAtCurrentZoom.h / 2;
  const targetTop = Math.max(0, rectCenterY - viewportSize.h / 2);

  let targetLeft = 0;
  if (pageWidthPx > viewportSize.w) {
    const rectCenterX = rectPxAtCurrentZoom.x + rectPxAtCurrentZoom.w / 2;
    targetLeft = Math.max(0, rectCenterX - viewportSize.w / 2);
  }

  containerEl.scrollTo({ top: targetTop, left: targetLeft, behavior: 'smooth' });
}