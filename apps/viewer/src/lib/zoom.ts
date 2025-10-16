export interface Mark {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  padding_pct: number;
  page_index: number;
}

export interface PageDimensions {
  width_pt: number;
  height_pt: number;
  rotation_deg: number;
}

export interface RotatedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert normalized rect to rotation-safe coordinates
 * QA: Opening a mark on a 90° rotated page centers the region with padding, no clipping
 */
export function mapUnrotatedRectToRotation(
  mark: Mark,
  pageW: number,
  pageH: number,
  rotation: number
): RotatedRect {
  // Convert normalized to absolute unrotated coordinates
  const x = mark.nx * pageW;
  const y = mark.ny * pageH;
  const w = mark.nw * pageW;
  const h = mark.nh * pageH;

  const r = rotation % 360;
  
  switch (r) {
    case 0:
      return { x, y, w, h };
    case 90:
      return {
        x: y,
        y: pageW - (x + w),
        w: h,
        h: w
      };
    case 180:
      return {
        x: pageW - (x + w),
        y: pageH - (y + h),
        w,
        h
      };
    case 270:
      return {
        x: pageH - (y + h),
        y: x,
        w: h,
        h: w
      };
    default:
      return { x, y, w, h };
  }
}

export function getRotatedPageSize(pageW: number, pageH: number, rotation: number): { width: number; height: number } {
  const r = rotation % 360;
  return (r === 90 || r === 270) ? { width: pageH, height: pageW } : { width: pageW, height: pageH };
}

/**
 * Compute optimal scale to fit rect with padding in container
 * Enforces minimum visible size to avoid "lost in pixels" for tiny rects
 */
export function computeAutoZoom({
  rectRotated,
  containerW,
  containerH,
  paddingPx
}: {
  rectRotated: RotatedRect;
  containerW: number;
  containerH: number;
  paddingPx: number;
}): number {
  const { w: rw, h: rh } = rectRotated;
  
  // Calculate scale to fit rect + padding
  const scaleX = containerW / (rw + 2 * paddingPx);
  const scaleY = containerH / (rh + 2 * paddingPx);
  let targetScale = Math.min(scaleX, scaleY);
  
  // Enforce minimum visible size (40px)
  const minVisible = 40;
  const minScaleForWidth = minVisible / rw;
  const minScaleForHeight = minVisible / rh;
  const minScale = Math.max(minScaleForWidth, minScaleForHeight);
  
  if (targetScale < minScale) {
    targetScale = minScale;
  }
  
  // Clamp to sane bounds
  return Math.max(0.25, Math.min(8, targetScale));
}

/**
 * Calculate scroll position to center rect in container
 * QA: Switching marks scrolls inside the pdf pane only; the browser page does not scroll
 */
export function centerScroll({
  container,
  rectCenter,
  scale
}: {
  container: HTMLElement;
  rectCenter: { x: number; y: number };
  scale: number;
}): { scrollLeft: number; scrollTop: number } {
  const containerW = container.clientWidth;
  const containerH = container.clientHeight;
  
  // Convert rect center to viewport coordinates
  const sx = rectCenter.x * scale;
  const sy = rectCenter.y * scale;
  
  // Calculate scroll to center
  const scrollLeft = sx - containerW / 2;
  const scrollTop = sy - containerH / 2;
  
  // Clamp to available scroll range
  const maxScrollLeft = container.scrollWidth - containerW;
  const maxScrollTop = container.scrollHeight - containerH;
  
  return {
    scrollLeft: Math.max(0, Math.min(maxScrollLeft, scrollLeft)),
    scrollTop: Math.max(0, Math.min(maxScrollTop, scrollTop))
  };
}