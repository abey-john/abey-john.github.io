import type * as maplibregl from 'maplibre-gl';

export interface GlobeRotationController {
  start: () => void;
  stop: () => void;
  isSpinning: () => boolean;
  destroy: () => void;
}

const ROTATION_DEG_PER_SEC = 1.8;

export function createGlobeAutoRotation(
  map: maplibregl.Map,
  mapEl: HTMLElement
): GlobeRotationController {
  let spinning = false;
  let rafId: number | null = null;
  let lastTime = 0;

  const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stop = () => {
    spinning = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const step = (now: number) => {
    if (!spinning) return;

    if (lastTime === 0) {
      lastTime = now;
    }
    const dtSec = Math.min(0.064, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;

    if (dtSec > 0) {
      const center = map.getCenter();
      const nextLng =
        ((center.lng + ROTATION_DEG_PER_SEC * dtSec + 540) % 360) - 180;
      map.jumpTo({ center: [nextLng, center.lat] });
    }

    rafId = requestAnimationFrame(step);
  };

  const start = () => {
    if (prefersReducedMotion()) return;
    if (spinning) return;
    spinning = true;
    lastTime = 0;
    rafId = requestAnimationFrame(step);
  };

  const onUserInput = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('.maplibregl-ctrl-recenter')) {
      return;
    }
    stop();
  };

  const listenerOpts: AddEventListenerOptions = {
    capture: true,
    passive: true
  };
  mapEl.addEventListener('pointerdown', onUserInput, listenerOpts);
  mapEl.addEventListener('wheel', onUserInput, listenerOpts);
  mapEl.addEventListener('touchstart', onUserInput, listenerOpts);
  mapEl.addEventListener('keydown', onUserInput, { capture: true });

  const destroy = () => {
    stop();
    mapEl.removeEventListener('pointerdown', onUserInput, { capture: true });
    mapEl.removeEventListener('wheel', onUserInput, { capture: true });
    mapEl.removeEventListener('touchstart', onUserInput, { capture: true });
    mapEl.removeEventListener('keydown', onUserInput, { capture: true });
  };

  return {
    start,
    stop,
    isSpinning: () => spinning,
    destroy
  };
}
