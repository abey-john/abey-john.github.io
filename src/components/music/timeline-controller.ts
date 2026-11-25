import {
  invalidateCachedAlbumPreview,
  preloadPreviewManifest,
  resolveAlbumPreview
} from './audio-preview';
import { createTimelineTrail } from './timeline-trail';
import { createTimelineWaveTransition } from './timeline-transition';
import {
  type MusicViewModeChangeDetail,
  resetMusicViewMode,
  setMusicViewMode
} from './view-mode';
import {
  registerTimelineTransition,
  type TimelineTileSnapshot
} from './view-transition';

export function initMusicTimeline(): () => void {
  const toggleBtn = document.querySelector<HTMLButtonElement>(
    '[data-timeline-toggle]'
  );
  const normalView = document.querySelector<HTMLElement>(
    '[data-music-normal-view]'
  );
  const timelineStage = document.querySelector<HTMLElement>(
    '[data-music-timeline-stage]'
  );
  const timelineContainer = timelineStage?.querySelector<HTMLElement>(
    '[data-timeline-container]'
  );
  const tooltip =
    timelineStage?.querySelector<HTMLElement>('[data-tl-tooltip]');
  const trailPill = timelineStage?.querySelector<HTMLElement>(
    '[data-tl-trail-pill]'
  );

  if (
    !normalView ||
    !timelineStage ||
    !timelineContainer ||
    !tooltip ||
    !trailPill
  ) {
    return () => {};
  }

  const tiles = Array.from(
    timelineStage.querySelectorAll<HTMLButtonElement>('[data-tl-tile]')
  );
  const railButtons = Array.from(
    timelineStage.querySelectorAll<HTMLButtonElement>('[data-rail-year]')
  );
  const yearSections = Array.from(
    timelineStage.querySelectorAll<HTMLElement>('[data-timeline-year]')
  );

  // Tooltip sub-elements
  const ttCover = tooltip.querySelector<HTMLImageElement>('[data-tl-tt-cover]');
  const ttTitle = tooltip.querySelector<HTMLElement>('[data-tl-tt-title]');
  const ttArtist = tooltip.querySelector<HTMLElement>('[data-tl-tt-artist]');
  const ttStats = tooltip.querySelector<HTMLElement>('[data-tl-tt-stats]');
  const ttRing = tooltip.querySelector<SVGGeometryElement>('[data-tl-tt-ring]');

  const trail = createTimelineTrail(
    timelineStage,
    tiles,
    railButtons,
    trailPill,
    () => stopTimelineAudio()
  );
  const waveTransition = createTimelineWaveTransition(timelineStage);

  const CONTENT_FADE_MS = 220;
  let isActive = false;
  let transitionTimer: number | null = null;
  let yearObserver: IntersectionObserver | null = null;
  let coverObserver: IntersectionObserver | null = null;
  const visibleYears = new Map<number, number>();

  // Hover state
  let hoveredTile: HTMLButtonElement | null = null;
  let lastClientX = 0;
  let lastClientY = 0;

  // Audio playback state
  let activeTile: HTMLButtonElement | null = null;
  let activeAudio: HTMLAudioElement | null = null;
  let isAudioLoading = false;
  let audioAbortController: AbortController | null = null;

  function hideTooltip() {
    hoveredTile = null;
    tooltip!.hidden = true;
    tooltip!.classList.remove('is-playing', 'is-paused', 'is-loading');
    if (ttRing) ttRing.style.strokeDashoffset = '100';
  }

  function syncTooltipAudioState(tile: HTMLButtonElement | null) {
    if (!tooltip) return;
    const isSame = Boolean(tile && activeTile && tile === activeTile);
    const isPlaying = isSame && activeAudio !== null && !activeAudio.paused;
    const isPaused =
      isSame && !isPlaying && !isAudioLoading && activeAudio !== null;

    tooltip.classList.toggle('is-playing', isPlaying);
    tooltip.classList.toggle('is-loading', isSame && isAudioLoading);
    tooltip.classList.toggle('is-paused', isPaused);

    if (!isSame && ttRing) {
      ttRing.style.strokeDashoffset = '100';
    } else if (isSame && ttRing && activeAudio) {
      const pct = Math.min(
        100,
        Math.max(0, (activeAudio.currentTime / 30) * 100)
      );
      ttRing.style.strokeDashoffset = `${100 - pct}`;
    }
  }

  function showTooltipForTile(tile: HTMLButtonElement, x: number, y: number) {
    hoveredTile = tile;
    if (ttCover) {
      const imgUrl = tile.dataset.image || '';
      if (ttCover.getAttribute('src') !== imgUrl) {
        ttCover.src = imgUrl;
      }
    }
    if (ttTitle) ttTitle.textContent = tile.dataset.title || '';
    if (ttArtist) ttArtist.textContent = tile.dataset.artist || '';
    if (ttStats) {
      const rank = tile.dataset.rank || '';
      const year = tile.dataset.year || '';
      const streams = Number(tile.dataset.streams || 0).toLocaleString();
      ttStats.textContent = `#${rank} in ${year} • ${streams} streams`;
    }

    syncTooltipAudioState(tile);
    tooltip!.hidden = false;
    positionTooltip(x, y);
  }

  function positionTooltip(clientX: number, clientY: number) {
    if (!tooltip || tooltip.hidden) return;
    const ttRect = tooltip.getBoundingClientRect();
    let left = clientX + 16;
    let top = clientY + 16;

    if (left + ttRect.width > window.innerWidth - 10) {
      left = clientX - ttRect.width - 16;
    }
    if (top + ttRect.height > window.innerHeight - 10) {
      top = clientY - ttRect.height - 16;
    }

    left = Math.max(8, Math.min(window.innerWidth - ttRect.width - 8, left));
    top = Math.max(8, Math.min(window.innerHeight - ttRect.height - 8, top));

    tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function setTileProgress(tile: HTMLButtonElement, pct: number) {
    const ring = tile.querySelector<SVGGeometryElement>('[data-tile-ring]');
    if (ring) {
      ring.style.strokeDashoffset = `${100 - pct}`;
    }
  }

  function stopTimelineAudio() {
    if (audioAbortController) {
      audioAbortController.abort();
      audioAbortController = null;
    }
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.removeAttribute('src');
      activeAudio.load();
      activeAudio = null;
    }
    if (activeTile) {
      activeTile.classList.remove('is-playing', 'is-paused', 'is-loading');
      activeTile.setAttribute('aria-pressed', 'false');
      setTileProgress(activeTile, 0);
      activeTile = null;
    }
    isAudioLoading = false;
    syncTooltipAudioState(hoveredTile);
  }

  async function handleTileClick(tile: HTMLButtonElement) {
    // Pause / resume if clicking the currently active tile
    if (activeTile === tile && activeAudio) {
      if (activeAudio.paused) {
        try {
          await activeAudio.play();
          tile.classList.add('is-playing');
          tile.classList.remove('is-paused');
          tile.setAttribute('aria-pressed', 'true');
          syncTooltipAudioState(hoveredTile);
        } catch {}
      } else {
        activeAudio.pause();
        tile.classList.remove('is-playing');
        tile.classList.add('is-paused');
        tile.setAttribute('aria-pressed', 'false');
        syncTooltipAudioState(hoveredTile);
      }
      return;
    }

    stopTimelineAudio();
    window.dispatchEvent(
      new CustomEvent('music:stop-other-audio', {
        detail: { source: 'music-timeline' }
      })
    );

    trail.activate(tile);

    activeTile = tile;
    isAudioLoading = true;
    tile.classList.add('is-loading');
    tile.setAttribute('aria-pressed', 'true');
    syncTooltipAudioState(hoveredTile);

    audioAbortController = new AbortController();
    const signal = audioAbortController.signal;

    const albumId = tile.dataset.albumId
      ? Number(tile.dataset.albumId)
      : undefined;
    const targetAlbum = {
      id: albumId && !Number.isNaN(albumId) ? albumId : undefined,
      title: tile.dataset.title || '',
      artist: tile.dataset.artist || '',
      primaryArtist: tile.dataset.primaryArtist || undefined
    };
    let hasRetriedLive = false;

    const startPlayback = async (
      previewUrl: string,
      wasFromLiveBypass: boolean
    ) => {
      if (signal.aborted || activeTile !== tile) return;

      const audio = new Audio(previewUrl);
      activeAudio = audio;
      const MAX_DURATION = 30;
      let recoveryAttempted = false;

      const recoverFromBrokenUrl = async (err?: any) => {
        if (signal.aborted || activeTile !== tile) return;
        if (err?.name === 'AbortError') return;
        if (err?.name === 'NotAllowedError') {
          if (activeAudio === audio) stopTimelineAudio();
          return;
        }
        if (activeAudio !== audio || recoveryAttempted) return;
        if (hasRetriedLive || wasFromLiveBypass) {
          stopTimelineAudio();
          return;
        }

        recoveryAttempted = true;
        hasRetriedLive = true;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        activeAudio = null;

        isAudioLoading = true;
        tile.classList.remove('is-playing', 'is-paused');
        tile.classList.add('is-loading');
        syncTooltipAudioState(hoveredTile);

        invalidateCachedAlbumPreview(targetAlbum);
        try {
          const freshUrl = await resolveAlbumPreview(
            targetAlbum,
            signal,
            undefined,
            { bypassCache: true }
          );
          if (signal.aborted || activeTile !== tile) return;
          isAudioLoading = false;
          tile.classList.remove('is-loading');

          if (!freshUrl || freshUrl === previewUrl) {
            stopTimelineAudio();
            return;
          }
          await startPlayback(freshUrl, true);
        } catch (retryErr: any) {
          if (retryErr?.name !== 'AbortError') {
            stopTimelineAudio();
          }
        }
      };

      audio.addEventListener('timeupdate', () => {
        if (activeTile !== tile || activeAudio !== audio) return;
        const cur = audio.currentTime || 0;
        if (cur >= MAX_DURATION) {
          stopTimelineAudio();
          return;
        }
        if (cur >= MAX_DURATION - 1.5) {
          try {
            audio.volume = Math.max(0, Math.min(1, (MAX_DURATION - cur) / 1.5));
          } catch {}
        }
        const pct = Math.min(100, Math.max(0, (cur / MAX_DURATION) * 100));
        setTileProgress(tile, pct);
        if (ttRing && hoveredTile === tile) {
          ttRing.style.strokeDashoffset = `${100 - pct}`;
        }
      });

      audio.addEventListener('ended', () => {
        if (activeTile === tile && activeAudio === audio) {
          stopTimelineAudio();
        }
      });

      audio.addEventListener('error', () => {
        void recoverFromBrokenUrl();
      });

      try {
        await audio.play();
        if (!signal.aborted && activeTile === tile && activeAudio === audio) {
          tile.classList.add('is-playing');
          tile.classList.remove('is-paused');
          syncTooltipAudioState(hoveredTile);
        }
      } catch (playErr: any) {
        await recoverFromBrokenUrl(playErr);
      }
    };

    try {
      const previewUrl = await resolveAlbumPreview(targetAlbum, signal);

      if (signal.aborted || activeTile !== tile) return;

      isAudioLoading = false;
      tile.classList.remove('is-loading');

      if (!previewUrl) {
        // Keep the artist trail visible even if no 30s audio snippet was found
        activeTile = null;
        tile.setAttribute('aria-pressed', 'false');
        syncTooltipAudioState(hoveredTile);
        return;
      }

      await startPlayback(previewUrl, false);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        stopTimelineAudio();
      }
    }
  }

  function setActiveRailYear(year: number) {
    for (const btn of railButtons) {
      const matches = Number(btn.dataset.railYear) === year;
      btn.classList.toggle('is-current', matches);
      if (matches) {
        btn.setAttribute('aria-current', 'location');
      } else {
        btn.removeAttribute('aria-current');
      }
    }
  }

  function setupYearObserver() {
    teardownYearObserver();
    visibleYears.clear();

    if (yearSections.length > 0) {
      const firstYear = Number(yearSections[0].dataset.timelineYear);
      if (!Number.isNaN(firstYear)) {
        setActiveRailYear(firstYear);
      }
    }

    if (typeof IntersectionObserver === 'undefined') return;

    yearObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const yr = Number((entry.target as HTMLElement).dataset.timelineYear);
          if (Number.isNaN(yr)) continue;
          if (entry.isIntersecting) {
            visibleYears.set(yr, entry.intersectionRatio);
          } else {
            visibleYears.delete(yr);
          }
        }

        if (visibleYears.size > 0) {
          let bestYear = -1;
          let bestRatio = -1;
          for (const [yr, ratio] of visibleYears.entries()) {
            if (ratio > bestRatio || (ratio === bestRatio && yr > bestYear)) {
              bestRatio = ratio;
              bestYear = yr;
            }
          }
          if (bestYear !== -1) {
            setActiveRailYear(bestYear);
          }
        }
      },
      {
        rootMargin: '-20% 0px -55% 0px',
        threshold: [0, 0.25, 0.5, 0.75]
      }
    );

    for (const section of yearSections) {
      yearObserver.observe(section);
    }
  }

  function teardownYearObserver() {
    if (yearObserver) {
      yearObserver.disconnect();
      yearObserver = null;
    }
    visibleYears.clear();
  }

  function hydrateCover(
    img: HTMLImageElement | null,
    priority: 'high' | 'auto' = 'auto'
  ) {
    if (!img || img.getAttribute('src') || !img.dataset.src) return;
    if (priority === 'high') {
      img.fetchPriority = 'high';
    }
    img.src = img.dataset.src;
    delete img.dataset.src;
  }

  function hydrateYearSection(
    section: HTMLElement | null | undefined,
    priority: 'high' | 'auto' = 'auto'
  ) {
    if (!section || section.dataset.coversHydrated === '1') return;
    section.dataset.coversHydrated = '1';
    coverObserver?.unobserve(section);
    const imgs = section.querySelectorAll<HTMLImageElement>('.tl-cover');
    for (const img of imgs) {
      hydrateCover(img, priority);
    }
  }

  function teardownCoverObserver() {
    if (coverObserver) {
      coverObserver.disconnect();
      coverObserver = null;
    }
  }

  function setupCoverObserver() {
    teardownCoverObserver();
    hydrateYearSection(yearSections[0], 'high');
    hydrateYearSection(yearSections[1], 'auto');

    if (typeof IntersectionObserver === 'undefined') {
      for (let i = 2; i < yearSections.length; i++) {
        hydrateYearSection(yearSections[i], 'auto');
      }
      return;
    }

    coverObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          hydrateYearSection(el, 'auto');
          coverObserver?.unobserve(el);
        }
      },
      {
        rootMargin: '450px 0px',
        threshold: 0
      }
    );

    for (let i = 2; i < yearSections.length; i++) {
      const section = yearSections[i];
      if (section.dataset.coversHydrated !== '1') {
        coverObserver.observe(section);
      }
    }
  }

  function enterTimeline(skipNormalFade: boolean) {
    if (isActive) return;
    isActive = true;
    void preloadPreviewManifest();

    waveTransition.cancel();
    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }

    const revealStage = () => {
      if (!isActive) return;
      normalView!.hidden = true;
      normalView!.classList.remove('is-fading-out', 'is-fading-in');
      timelineStage!.hidden = false;
      window.scrollTo({ top: 0 });
      if (!skipNormalFade) {
        waveTransition.playEnter();
      }
      setupYearObserver();
      setupCoverObserver();
    };

    if (skipNormalFade) {
      revealStage();
      return;
    }

    normalView!.classList.remove('is-fading-in');
    normalView!.classList.add('is-fading-out');

    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      revealStage();
    }, CONTENT_FADE_MS);
  }

  function exitTimeline(revealNormalView: boolean) {
    const wasActive = isActive;
    isActive = false;

    stopTimelineAudio();
    trail.clear();
    hideTooltip();
    teardownYearObserver();
    teardownCoverObserver();
    waveTransition.cancel();

    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }

    if (!revealNormalView) {
      timelineStage!.hidden = true;
      return;
    }

    if (!wasActive) return;

    if (!timelineStage!.hidden) {
      waveTransition.playExit(() => {
        if (isActive) return;
        timelineStage!.hidden = true;
        normalView!.hidden = false;
        normalView!.classList.remove('is-fading-out');
        normalView!.classList.add('is-fading-in');
        transitionTimer = window.setTimeout(() => {
          transitionTimer = null;
          normalView?.classList.remove('is-fading-in');
        }, 360);
      });
    } else {
      timelineStage!.hidden = true;
      normalView!.hidden = false;
    }
  }

  function captureVisibleTimelineTiles(
    eagerLoad = false
  ): TimelineTileSnapshot[] {
    const vh = window.innerHeight;
    const snapshots: TimelineTileSnapshot[] = [];
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom < -120 || r.top > vh + 140) continue;

      const imgEl = tile.querySelector<HTMLImageElement>('.tl-cover');
      if (eagerLoad) {
        hydrateCover(imgEl, 'high');
      }

      const span: 1 | 2 | 3 = tile.classList.contains('span-3')
        ? 3
        : tile.classList.contains('span-2')
          ? 2
          : 1;

      snapshots.push({
        albumId: tile.dataset.albumId || '',
        albumKey: tile.dataset.albumKey || '',
        span,
        imgEl,
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height
      });
    }
    return snapshots;
  }

  function hideTimelineImmediate() {
    waveTransition.cancel();
    teardownCoverObserver();
    timelineStage!.classList.remove('is-morphing-in');
    timelineStage!.style.removeProperty('--morph-chrome-opacity');
    timelineStage!.hidden = true;
  }

  const unregisterTransition = registerTimelineTransition({
    captureVisibleSnapshot: () => captureVisibleTimelineTiles(false),
    prepareAsTarget: () => {
      waveTransition.cancel();
      void preloadPreviewManifest();
      normalView!.hidden = true;
      normalView!.classList.remove('is-fading-out', 'is-fading-in');
      timelineStage!.classList.add('is-morphing-in');
      timelineStage!.style.setProperty('--morph-chrome-opacity', '0');
      timelineStage!.hidden = false;
      window.scrollTo({ top: 0 });
      return captureVisibleTimelineTiles(true);
    },
    setMorphChromeOpacity: (opacity: number) => {
      timelineStage!.style.setProperty(
        '--morph-chrome-opacity',
        String(opacity)
      );
    },
    finishReveal: () => {
      timelineStage!.classList.remove('is-morphing-in');
      timelineStage!.style.removeProperty('--morph-chrome-opacity');
      if (isActive) {
        setupYearObserver();
        setupCoverObserver();
      }
    },
    hideImmediate: hideTimelineImmediate
  });

  // Event Listeners
  const onToggleHover = () => {
    void preloadPreviewManifest();
  };

  const onViewModeChange = (e: Event) => {
    const { prev, next, morphing } = (
      e as CustomEvent<MusicViewModeChangeDetail>
    ).detail;
    if (morphing) {
      waveTransition.cancel();
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (next === 'timeline') {
        isActive = true;
      } else if (prev === 'timeline') {
        isActive = false;
        stopTimelineAudio();
        trail.clear();
        hideTooltip();
        teardownYearObserver();
        teardownCoverObserver();
        hideTimelineImmediate();
      }
      return;
    }

    if (next === 'timeline') {
      enterTimeline(prev !== 'overview');
    } else if (next === 'overview') {
      exitTimeline(true);
    } else {
      exitTimeline(false);
    }
  };

  const onContainerClick = (e: MouseEvent) => {
    if (!isActive) return;
    const tile = (e.target as Element | null)?.closest<HTMLButtonElement>(
      '[data-tl-tile]'
    );
    if (tile) {
      void handleTileClick(tile);
    }
  };

  const onContainerPointerOver = (e: PointerEvent) => {
    if (!isActive || e.pointerType === 'touch') return;
    const tile = (e.target as Element | null)?.closest<HTMLButtonElement>(
      '[data-tl-tile]'
    );
    if (tile && tile !== hoveredTile) {
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      showTooltipForTile(tile, e.clientX, e.clientY);
    }
  };

  const onContainerPointerMove = (e: PointerEvent) => {
    if (!isActive || e.pointerType === 'touch' || !hoveredTile) return;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    positionTooltip(e.clientX, e.clientY);
  };

  const onContainerPointerOut = (e: PointerEvent) => {
    if (!isActive || e.pointerType === 'touch') return;
    const relatedTile = (
      e.relatedTarget as Element | null
    )?.closest?.<HTMLButtonElement>('[data-tl-tile]');
    if (!relatedTile) {
      hideTooltip();
    }
  };

  const onRailClick = (e: Event) => {
    const btn = (e.currentTarget as HTMLButtonElement) || null;
    if (!btn) return;
    const year = Number(btn.dataset.railYear);
    if (Number.isNaN(year)) return;
    const section = timelineStage.querySelector<HTMLElement>(
      `#timeline-year-${year}`
    );
    if (section) {
      const idx = yearSections.indexOf(section);
      hydrateYearSection(section, 'high');
      if (idx > 0) hydrateYearSection(yearSections[idx - 1], 'auto');
      if (idx >= 0 && idx + 1 < yearSections.length) {
        hydrateYearSection(yearSections[idx + 1], 'auto');
      }
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveRailYear(year);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isActive) return;
    if (e.key === 'Escape') {
      if (trail.hasActiveTrail() || activeAudio || isAudioLoading) {
        stopTimelineAudio();
        trail.clear();
      } else {
        setMusicViewMode('overview');
      }
    }
  };

  const onResize = () => {
    if (isActive && hoveredTile && !tooltip.hidden) {
      positionTooltip(lastClientX, lastClientY);
    }
  };

  const onStopOtherAudio = (e: Event) => {
    if ((e as CustomEvent).detail?.source !== 'music-timeline') {
      stopTimelineAudio();
    }
  };

  const onStageClick = (e: MouseEvent) => {
    if (!isActive) return;
    if (!trail.hasActiveTrail() && !activeAudio && !isAudioLoading) return;
    const target = e.target as Element | null;
    if (
      target?.closest(
        '[data-tl-tile], [data-tl-trail-pill], [data-rail-year], [data-music-view-toggle]'
      )
    ) {
      return;
    }
    stopTimelineAudio();
    trail.clear();
  };

  toggleBtn?.addEventListener('mouseenter', onToggleHover);
  toggleBtn?.addEventListener('focus', onToggleHover);
  timelineStage.addEventListener('click', onStageClick);
  timelineContainer.addEventListener('click', onContainerClick);
  timelineContainer.addEventListener('pointerover', onContainerPointerOver);
  timelineContainer.addEventListener('pointermove', onContainerPointerMove);
  timelineContainer.addEventListener('pointerout', onContainerPointerOut);
  for (const btn of railButtons) {
    btn.addEventListener('click', onRailClick);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  window.addEventListener('music:stop-other-audio', onStopOtherAudio);
  window.addEventListener('music:view-mode-change', onViewModeChange);

  return () => {
    unregisterTransition();
    waveTransition.cancel();
    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    teardownYearObserver();
    teardownCoverObserver();
    stopTimelineAudio();
    trail.destroy();
    hideTooltip();
    timelineStage.classList.remove('is-morphing-in');
    timelineStage.style.removeProperty('--morph-chrome-opacity');
    normalView.classList.remove('is-fading-in', 'is-fading-out');
    resetMusicViewMode();

    toggleBtn?.removeEventListener('mouseenter', onToggleHover);
    toggleBtn?.removeEventListener('focus', onToggleHover);
    timelineStage.removeEventListener('click', onStageClick);
    timelineContainer.removeEventListener('click', onContainerClick);
    timelineContainer.removeEventListener(
      'pointerover',
      onContainerPointerOver
    );
    timelineContainer.removeEventListener(
      'pointermove',
      onContainerPointerMove
    );
    timelineContainer.removeEventListener('pointerout', onContainerPointerOut);
    for (const btn of railButtons) {
      btn.removeEventListener('click', onRailClick);
    }
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('music:stop-other-audio', onStopOtherAudio);
    window.removeEventListener('music:view-mode-change', onViewModeChange);
  };
}
