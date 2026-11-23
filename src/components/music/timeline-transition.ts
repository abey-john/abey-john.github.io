export interface TimelineWaveTransition {
  playEnter: () => void;
  playExit: (onDone: () => void) => void;
  cancel: () => void;
}

interface VisibleTileMetrics {
  el: HTMLElement;
  yearIdx: number;
  normDist: number;
  offsetX: number;
  edgeScale: number;
  tierDelay: number;
}

interface VisibleStageTargets {
  headers: Array<{ el: HTMLElement; yearIdx: number }>;
  tiles: VisibleTileMetrics[];
  sidebar: HTMLElement | null;
}

const ENTER_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EXIT_EASE = 'cubic-bezier(0.55, 0, 0.85, 0.35)';
const EXIT_SETTLE_MS = 370;

function isInViewport(rect: DOMRect, viewportHeight: number): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < viewportHeight
  );
}

function canRunWebAnimations(): boolean {
  if (typeof Element === 'undefined' || !Element.prototype.animate) {
    return false;
  }
  return !(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
}

function collectVisibleTargets(stageEl: HTMLElement): VisibleStageTargets {
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const fallbackCenterX = window.innerWidth / 2;
  const fallbackHalfWidth = Math.max(1, window.innerWidth / 2);

  const headers: VisibleStageTargets['headers'] = [];
  const tiles: VisibleTileMetrics[] = [];

  const yearEls = stageEl.querySelectorAll<HTMLElement>('.timeline-year');
  let visibleYearIdx = 0;

  for (const yearEl of yearEls) {
    if (!isInViewport(yearEl.getBoundingClientRect(), viewportHeight)) {
      continue;
    }

    const header = yearEl.querySelector<HTMLElement>('.timeline-year-header');
    if (
      header &&
      isInViewport(header.getBoundingClientRect(), viewportHeight)
    ) {
      headers.push({ el: header, yearIdx: visibleYearIdx });
    }

    const grid = yearEl.querySelector<HTMLElement>('.timeline-wave-grid');
    const gridRect = grid?.getBoundingClientRect();
    const gridCenterX =
      gridRect && gridRect.width > 0
        ? gridRect.left + gridRect.width / 2
        : fallbackCenterX;
    const halfWidth =
      gridRect && gridRect.width > 0
        ? Math.max(1, gridRect.width / 2)
        : fallbackHalfWidth;

    const yearTiles = yearEl.querySelectorAll<HTMLElement>('.tl-tile');
    for (const tile of yearTiles) {
      const rect = tile.getBoundingClientRect();
      if (!isInViewport(rect, viewportHeight)) {
        continue;
      }

      const tileCenterX = rect.left + rect.width / 2;
      const dx = tileCenterX - gridCenterX;
      const normDist = Math.min(1, Math.abs(dx) / halfWidth);
      const offsetX = dx === 0 ? 0 : -Math.sign(dx) * (6 + normDist * 16);

      const isHero = tile.classList.contains('span-3');
      const isMedium = tile.classList.contains('span-2');
      const edgeScale = isHero ? 0.58 : 0.42;
      const tierDelay = isHero ? 0 : isMedium ? 22 : 42;

      tiles.push({
        el: tile,
        yearIdx: visibleYearIdx,
        normDist,
        offsetX,
        edgeScale,
        tierDelay
      });
    }

    visibleYearIdx += 1;
  }

  let sidebar = stageEl.querySelector<HTMLElement>('.timeline-sidebar');
  if (sidebar) {
    const sidebarStyle = getComputedStyle(sidebar);
    if (
      sidebarStyle.display === 'none' ||
      sidebarStyle.display === 'contents'
    ) {
      sidebar = null;
    }
  }

  return { headers, tiles, sidebar };
}

/**
 * Creates a center-out soundwave bloom and reverse-collapse WAAPI controller
 * for transitions between the music overview page and the timeline stage.
 */
export function createTimelineWaveTransition(
  stageEl: HTMLElement
): TimelineWaveTransition {
  const activeAnimations = new Set<Animation>();
  let exitTimer: number | null = null;

  const cancelAnimations = (animations: Iterable<Animation>) => {
    for (const anim of animations) {
      try {
        anim.cancel();
      } catch {
        // Ignore already-finished animation cancellation errors
      }
    }
  };

  const track = (
    el: HTMLElement,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ) => {
    const anim = el.animate(keyframes, options);
    activeAnimations.add(anim);
    const prune = () => {
      activeAnimations.delete(anim);
    };
    const retainsFill = options.fill === 'forwards' || options.fill === 'both';
    if (!retainsFill) {
      anim.onfinish = prune;
    }
    anim.oncancel = prune;
  };

  const cancel = () => {
    if (exitTimer !== null) {
      window.clearTimeout(exitTimer);
      exitTimer = null;
    }
    const toCancel = Array.from(activeAnimations);
    activeAnimations.clear();
    cancelAnimations(toCancel);
  };

  const playEnter = () => {
    cancel();
    if (!canRunWebAnimations()) return;

    const { headers, tiles, sidebar } = collectVisibleTargets(stageEl);

    for (const { el, yearIdx } of headers) {
      track(
        el,
        [
          { opacity: 0, transform: 'translate3d(0, 10px, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ],
        {
          duration: 320,
          delay: yearIdx * 65,
          easing: ENTER_EASE,
          fill: 'backwards'
        }
      );
    }

    if (sidebar) {
      track(
        sidebar,
        [
          { opacity: 0, transform: 'translate3d(12px, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ],
        {
          duration: 360,
          delay: 140,
          easing: ENTER_EASE,
          fill: 'backwards'
        }
      );
    }

    for (const tile of tiles) {
      track(
        tile.el,
        [
          {
            opacity: 0,
            transform: `translate3d(${tile.offsetX}px, 0, 0) scale(${tile.edgeScale})`
          },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
        ],
        {
          duration: 380,
          delay:
            tile.yearIdx * 70 +
            Math.round(tile.normDist * 200) +
            tile.tierDelay,
          easing: ENTER_EASE,
          fill: 'backwards'
        }
      );
    }
  };

  const playExit = (onDone: () => void) => {
    cancel();
    if (!canRunWebAnimations()) {
      onDone();
      return;
    }

    const { headers, tiles, sidebar } = collectVisibleTargets(stageEl);
    if (tiles.length === 0 && headers.length === 0 && !sidebar) {
      onDone();
      return;
    }

    for (const { el } of headers) {
      track(
        el,
        [
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          { opacity: 0, transform: 'translate3d(0, -6px, 0)' }
        ],
        {
          duration: 240,
          delay: 40,
          easing: EXIT_EASE,
          fill: 'forwards'
        }
      );
    }

    if (sidebar) {
      track(
        sidebar,
        [
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          { opacity: 0, transform: 'translate3d(10px, 0, 0)' }
        ],
        {
          duration: 240,
          delay: 0,
          easing: EXIT_EASE,
          fill: 'forwards'
        }
      );
    }

    for (const tile of tiles) {
      track(
        tile.el,
        [
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
          {
            opacity: 0,
            transform: `translate3d(${tile.offsetX}px, 0, 0) scale(${tile.edgeScale})`
          }
        ],
        {
          duration: 230,
          delay: Math.round((1 - tile.normDist) * 130),
          easing: EXIT_EASE,
          fill: 'forwards'
        }
      );
    }

    exitTimer = window.setTimeout(() => {
      exitTimer = null;
      const toCancel = Array.from(activeAnimations);
      activeAnimations.clear();
      onDone();
      cancelAnimations(toCancel);
    }, EXIT_SETTLE_MS);
  };

  return { playEnter, playExit, cancel };
}
