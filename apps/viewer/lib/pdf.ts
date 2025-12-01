// Debounce utility for zoom operations
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

// Throttle utility for high-frequency events
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  
  return function executedFunction(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export function clampZoom(zoom: number): number {
  // Slightly smaller max on touch devices – avoids huge canvases / white screens
  let maxZoom = 5.0; // desktop default

  if (typeof window !== 'undefined') {
    const isTouch =
      'ontouchstart' in window || (navigator as any).maxTouchPoints > 0;
    if (isTouch) {
      maxZoom = 3.2; // phones/tablets – still plenty close
    }
  }

  return Math.max(0.25, Math.min(maxZoom, zoom));
}

/**
 * Returns a zoom that makes rectSize fit within containerSize,
 * given the pageSize at scale=1. Adds paddingRatio (0..1) around the rect.
 */
export function computeZoomForRect(
  containerSize: { w: number; h: number },
  pageSizeAt1: { w: number; h: number },
  rectSizeAt1: { w: number; h: number },
  paddingRatio = 0.1
): number {
  const padW = rectSizeAt1.w * paddingRatio;
  const padH = rectSizeAt1.h * paddingRatio;
  const neededW = rectSizeAt1.w + padW * 2;
  const neededH = rectSizeAt1.h + padH * 2;

  const scaleX = containerSize.w / neededW;
  const scaleY = containerSize.h / neededH;
  return clampZoom(Math.min(scaleX, scaleY));
}

/**
 * Smoothly scroll so that rect is centered within the container.
 */
export function scrollToRect(
  container: HTMLElement,
  pageTop: number,
  _pageWidthPxOrRectLeft: number | undefined | null,
  rectPx: { x: number; y: number; w: number; h: number },
  viewportSize: { w: number; h: number }
): void {
  const rectCenterY = pageTop + rectPx.y + rectPx.h / 2;
  const targetScrollTop = rectCenterY - viewportSize.h / 2;

  container.scrollTo({
    top: Math.max(0, targetScrollTop),
    behavior: 'smooth',
  });
}

/**
 * Calculate if a page is visible in the viewport
 */
export function isPageVisible(
  pageTop: number,
  pageHeight: number,
  scrollTop: number,
  viewportHeight: number,
  buffer = 200
): boolean {
  const pageBottom = pageTop + pageHeight;
  const viewportTop = scrollTop - buffer;
  const viewportBottom = scrollTop + viewportHeight + buffer;
  
  return pageBottom >= viewportTop && pageTop <= viewportBottom;
}

/**
 * Request idle callback polyfill
 */
export const requestIdleCallback =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? window.requestIdleCallback
    : (callback: IdleRequestCallback) => setTimeout(callback, 1);

export const cancelIdleCallback =
  typeof window !== 'undefined' && 'cancelIdleCallback' in window
    ? window.cancelIdleCallback
    : (id: number) => clearTimeout(id);

/**
 * Download master report for a document.
 * Calls the backend /reports/master/generate endpoint.
 */
export async function downloadMasterReport(params: {
  project_name: string;
  id: string;
  part_number: string;
  report_title?: string;
  apiBase?: string;
}): Promise<void> {
  const apiBase = params.apiBase || process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  
  try {
    const response = await fetch(`${apiBase}/reports/master/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_name: params.project_name,
        id: params.id,
        part_number: params.part_number,
        report_title: params.report_title || `${params.part_number} Master Report`,
        max_runs: 100, // Can be made configurable later
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Master report generation failed: ${response.status} ${text}`);
    }

    // Trigger download
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${params.part_number}_master_report.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Master report download failed:', error);
    throw error;
  }
}