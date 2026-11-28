import type * as maplibregl from 'maplibre-gl';

export interface GlobeDragController {
  stop: () => void;
  isDragging: () => boolean;
  destroy: () => void;
}

const DRAG_THRESHOLD_PX = 5;
const MIN_ZOOM_BLEND = 3.5;
const MAX_ZOOM_BLEND = 8.5;
const GLOBE_DRAG_SCALE = 0.88;
const MAP_DRAG_SCALE = 1.0;
const GLOBE_DRAG_DAMPING = 0.14;
const MAP_DRAG_DAMPING = 0.3;
const GLOBE_GLIDE_DAMPING = 0.055;
const MAP_GLIDE_DAMPING = 0.1;
const MAX_LAT = 82;
const MAX_GLIDE_PX = 500;
const STOP_EPS_PX = 0.08;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function getZoomParams(zoom: number) {
  const degPerPx = 360 / (512 * Math.pow(2, zoom));
  const t = clamp(
    (zoom - MIN_ZOOM_BLEND) / (MAX_ZOOM_BLEND - MIN_ZOOM_BLEND),
    0,
    1
  );

  return {
    degPerPx,
    dragScale: lerp(GLOBE_DRAG_SCALE, MAP_DRAG_SCALE, t),
    dragDamping: lerp(GLOBE_DRAG_DAMPING, MAP_DRAG_DAMPING, t),
    glideDamping: lerp(GLOBE_GLIDE_DAMPING, MAP_GLIDE_DAMPING, t),
    mercatorBlend: clamp((zoom - 4) / 3, 0, 1)
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function shouldIgnoreTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '.maplibregl-popup, .maplibregl-ctrl, button, a, input, select, textarea'
    )
  );
}

/**
 * Replaces MapLibre's native 1:1 dragPan with a weighted, dual-damped
 * globe drag and coasting controller inspired by orbital camera controls.
 */
export function createGlobeDrag(
  map: maplibregl.Map,
  mapEl: HTMLElement,
  callbacks?: {
    onDragStart?: () => void;
  }
): GlobeDragController {
  map.dragPan.disable();

  const activePointers = new Set<number>();
  let pointerId: number | null = null;
  let isPointerDown = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let remLng = 0;
  let remLat = 0;
  let rafId: number | null = null;
  let lastTime = 0;
  let suppressNextClick = false;
  let suppressTimerId: number | null = null;

  const clearSuppressTimer = () => {
    if (suppressTimerId !== null) {
      window.clearTimeout(suppressTimerId);
      suppressTimerId = null;
    }
  };

  const stopRaf = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTime = 0;
  };

  const cancelDrag = () => {
    pointerId = null;
    isPointerDown = false;
    hasMoved = false;
    remLng = 0;
    remLat = 0;
    stopRaf();
    mapEl.classList.remove('is-dragging');
  };

  const step = (now: number) => {
    const dtSec =
      lastTime === 0
        ? 1 / 60
        : Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;

    const { degPerPx, dragDamping, glideDamping } = getZoomParams(
      map.getZoom()
    );
    const activelyDragging = isPointerDown && hasMoved;
    const damping = activelyDragging
      ? prefersReducedMotion()
        ? 0.35
        : dragDamping
      : glideDamping;

    const alpha = 1 - Math.pow(1 - damping, dtSec * 60);
    const stepLng = remLng * alpha;
    const stepLat = remLat * alpha;
    remLng -= stepLng;
    remLat -= stepLat;

    if (stepLng !== 0 || stepLat !== 0) {
      const center = map.getCenter();
      const nextLng = ((center.lng + stepLng + 540) % 360) - 180;
      const rawNextLat = center.lat + stepLat;
      const nextLat = clamp(rawNextLat, -MAX_LAT, MAX_LAT);

      // Avoid accumulating latitude lag when pulling past polar clamp
      if (
        (rawNextLat > MAX_LAT && remLat > 0) ||
        (rawNextLat < -MAX_LAT && remLat < 0)
      ) {
        remLat = 0;
      }

      map.jumpTo({ center: [nextLng, nextLat] }, { globeDrag: true });
    }

    const eps = STOP_EPS_PX * degPerPx;
    if (!activelyDragging && Math.abs(remLng) < eps && Math.abs(remLat) < eps) {
      remLng = 0;
      remLat = 0;
      rafId = null;
      lastTime = 0;
      return;
    }

    rafId = requestAnimationFrame(step);
  };

  const ensureRaf = () => {
    if (rafId === null) {
      lastTime = 0;
      rafId = requestAnimationFrame(step);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (shouldIgnoreTarget(e.target)) return;

    activePointers.add(e.pointerId);
    if (activePointers.size > 1) {
      cancelDrag();
      return;
    }

    suppressNextClick = false;
    clearSuppressTimer();

    // Catch any active glide immediately when grabbing the globe
    remLng = 0;
    remLat = 0;
    stopRaf();

    pointerId = e.pointerId;
    isPointerDown = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isPointerDown || e.pointerId !== pointerId) return;
    if (activePointers.size > 1) {
      cancelDrag();
      return;
    }

    if (!hasMoved) {
      if (
        Math.hypot(e.clientX - startX, e.clientY - startY) <= DRAG_THRESHOLD_PX
      ) {
        return;
      }
      hasMoved = true;
      mapEl.classList.add('is-dragging');
      callbacks?.onDragStart?.();
      lastX = e.clientX;
      lastY = e.clientY;
      ensureRaf();
      return;
    }

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const { degPerPx, dragScale, mercatorBlend } = getZoomParams(map.getZoom());
    const center = map.getCenter();
    const latCos = Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
    const latFactor = 1 - mercatorBlend * (1 - latCos);

    remLng += -dx * degPerPx * dragScale;
    remLat += dy * degPerPx * latFactor * dragScale;
    ensureRaf();
  };

  const onPointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (!isPointerDown || e.pointerId !== pointerId) return;

    const wasDragging = hasMoved;
    isPointerDown = false;
    hasMoved = false;
    pointerId = null;
    mapEl.classList.remove('is-dragging');

    if (wasDragging) {
      suppressNextClick = true;
      clearSuppressTimer();
      suppressTimerId = window.setTimeout(() => {
        suppressNextClick = false;
        suppressTimerId = null;
      }, 50);

      if (prefersReducedMotion()) {
        remLng = 0;
        remLat = 0;
        stopRaf();
        return;
      }

      const { degPerPx, dragDamping, glideDamping } = getZoomParams(
        map.getZoom()
      );
      const ratio = dragDamping / glideDamping;
      const maxGlide = Math.min(120, MAX_GLIDE_PX * degPerPx);

      remLng = clamp(remLng * ratio, -maxGlide, maxGlide);
      remLat = clamp(remLat * ratio, -maxGlide, maxGlide);

      const eps = STOP_EPS_PX * degPerPx;
      if (Math.abs(remLng) >= eps || Math.abs(remLat) >= eps) {
        ensureRaf();
      } else {
        remLng = 0;
        remLat = 0;
        stopRaf();
      }
    }
  };

  const onPointerCancel = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (e.pointerId === pointerId) {
      cancelDrag();
    }
  };

  const onWindowBlur = () => {
    activePointers.clear();
    cancelDrag();
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    clearSuppressTimer();
    e.stopPropagation();
    e.preventDefault();
  };

  mapEl.addEventListener('pointerdown', onPointerDown);
  mapEl.addEventListener('click', onClickCapture, { capture: true });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('blur', onWindowBlur);

  const stop = () => {
    cancelDrag();
  };

  const destroy = () => {
    stop();
    suppressNextClick = false;
    clearSuppressTimer();
    mapEl.removeEventListener('pointerdown', onPointerDown);
    mapEl.removeEventListener('click', onClickCapture, { capture: true });
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
  };

  return {
    stop,
    isDragging: () => isPointerDown && hasMoved,
    destroy
  };
}
