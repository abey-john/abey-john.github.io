import {
  getActiveMusicViewMode,
  setMusicViewMode,
  type MusicViewMode,
  type MusicViewModeChangeDetail
} from './view-mode';

/**
 * Initializes the segmented Overview / Mosaic / Timeline view-mode toggle,
 * keeping keyboard roving-tabindex navigation and the sliding pill indicator
 * synchronized across clicks, Escape exits, resizes, and morph transitions.
 */
export function initMusicViewToggle(): () => void {
  const container = document.querySelector<HTMLElement>(
    '[data-music-view-toggle]'
  );
  const indicator =
    container?.querySelector<HTMLElement>('[data-view-indicator]') ?? null;
  const buttons = Array.from(
    container?.querySelectorAll<HTMLButtonElement>('[data-view-mode]') ?? []
  );

  if (!container || !indicator || buttons.length === 0) {
    return () => {};
  }

  let disposed = false;
  let readyRafId: number | null = null;

  const getButtonForMode = (mode: MusicViewMode): HTMLButtonElement => {
    return buttons.find((btn) => btn.dataset.viewMode === mode) ?? buttons[0];
  };

  const measureIndicator = (mode: MusicViewMode, instant: boolean) => {
    const activeBtn = getButtonForMode(mode);
    const wasReady = indicator.classList.contains('is-ready');
    if (instant && wasReady) {
      indicator.classList.remove('is-ready');
    }

    indicator.style.setProperty('--indicator-x', `${activeBtn.offsetLeft}px`);
    indicator.style.setProperty('--indicator-w', `${activeBtn.offsetWidth}px`);
    container.classList.add('has-indicator');

    if (instant && wasReady) {
      // Flush updated indicator bounds before restoring CSS transitions.
      void indicator.offsetWidth;
      indicator.classList.add('is-ready');
    }
  };

  const syncUI = (mode: MusicViewMode, animate: boolean) => {
    const activeBtn = getButtonForMode(mode);
    for (const btn of buttons) {
      const isActive = btn === activeBtn;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-checked', String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
    }
    measureIndicator(mode, !animate);
  };

  syncUI(getActiveMusicViewMode(), false);
  readyRafId = requestAnimationFrame(() => {
    readyRafId = null;
    if (!disposed) {
      indicator.classList.add('is-ready');
    }
  });

  const onButtonClick = (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement | null;
    const mode = btn?.dataset.viewMode as MusicViewMode | undefined;
    if (mode) {
      setMusicViewMode(mode);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const focusedIndex = buttons.findIndex(
      (btn) => btn === document.activeElement
    );
    const currentIndex =
      focusedIndex >= 0
        ? focusedIndex
        : Math.max(
            0,
            buttons.findIndex((btn) => btn.classList.contains('is-active'))
          );

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = buttons.length - 1;
    }

    if (nextIndex === null) return;
    e.preventDefault();
    const targetBtn = buttons[nextIndex];
    const mode = targetBtn?.dataset.viewMode as MusicViewMode | undefined;
    if (targetBtn && mode) {
      targetBtn.focus();
      setMusicViewMode(mode);
    }
  };

  const onViewModeChange = (e: Event) => {
    const { next } = (e as CustomEvent<MusicViewModeChangeDetail>).detail;
    syncUI(next, true);
  };

  const onResize = () => {
    measureIndicator(getActiveMusicViewMode(), true);
  };

  for (const btn of buttons) {
    btn.addEventListener('click', onButtonClick);
  }
  container.addEventListener('keydown', onKeyDown);
  window.addEventListener('music:view-mode-change', onViewModeChange);
  window.addEventListener('resize', onResize);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (!disposed) {
        measureIndicator(getActiveMusicViewMode(), true);
      }
    });
    resizeObserver.observe(container);
  }

  document.fonts?.ready?.then(() => {
    if (!disposed) {
      measureIndicator(getActiveMusicViewMode(), true);
    }
  });

  return () => {
    disposed = true;
    if (readyRafId !== null) {
      cancelAnimationFrame(readyRafId);
      readyRafId = null;
    }
    resizeObserver?.disconnect();
    for (const btn of buttons) {
      btn.removeEventListener('click', onButtonClick);
    }
    container.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('music:view-mode-change', onViewModeChange);
    window.removeEventListener('resize', onResize);
  };
}
