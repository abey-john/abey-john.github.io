export interface TimelineTrailController {
  activate: (tileBtn: HTMLButtonElement) => void;
  step: (delta: -1 | 1) => void;
  togglePin: () => void;
  clearIfUnpinned: () => void;
  clear: () => void;
  hasActiveTrail: () => boolean;
  destroy: () => void;
}

export function createTimelineTrail(
  stageEl: HTMLElement,
  tiles: HTMLButtonElement[],
  railButtons: HTMLButtonElement[],
  pillEl: HTMLElement
): TimelineTrailController {
  const summaryEl = pillEl.querySelector<HTMLElement>('[data-trail-summary]');
  const prevBtn = pillEl.querySelector<HTMLButtonElement>('[data-trail-prev]');
  const nextBtn = pillEl.querySelector<HTMLButtonElement>('[data-trail-next]');
  const pinBtn = pillEl.querySelector<HTMLButtonElement>('[data-trail-pin]');
  const closeBtn =
    pillEl.querySelector<HTMLButtonElement>('[data-trail-close]');

  let matchedTiles: HTMLButtonElement[] = [];
  let currentIdx = -1;
  let isPinned = false;
  let focusTimer: number | null = null;
  let focusedTile: HTMLButtonElement | null = null;

  function clearFocusPulse() {
    if (focusTimer !== null) {
      window.clearTimeout(focusTimer);
      focusTimer = null;
    }
    if (focusedTile) {
      focusedTile.classList.remove('is-trail-focus');
      focusedTile = null;
    }
  }

  function clear() {
    isPinned = false;
    clearFocusPulse();
    stageEl.classList.remove('has-trail');

    for (const tile of tiles) {
      tile.classList.remove(
        'is-trail-album',
        'is-trail-artist',
        'is-trail-focus'
      );
    }
    for (const btn of railButtons) {
      btn.classList.remove('has-trail-hit');
    }

    if (pinBtn) {
      pinBtn.classList.remove('is-pinned');
      pinBtn.setAttribute('aria-pressed', 'false');
    }

    matchedTiles = [];
    currentIdx = -1;
    pillEl.hidden = true;
  }

  function activate(tileBtn: HTMLButtonElement) {
    const primaryArtist =
      tileBtn.dataset.primaryArtist || tileBtn.dataset.artist || '';
    const primaryKey =
      (tileBtn.dataset.artistKeys || '').split('|').filter(Boolean)[0] || '';
    const targetAlbumKey = tileBtn.dataset.albumKey || '';

    if (!primaryKey) {
      clear();
      return;
    }

    clearFocusPulse();
    matchedTiles = [];
    const matchedYears = new Set<number>();

    for (const tile of tiles) {
      tile.classList.remove(
        'is-trail-album',
        'is-trail-artist',
        'is-trail-focus'
      );
      const keys = (tile.dataset.artistKeys || '').split('|').filter(Boolean);
      if (!keys.includes(primaryKey)) continue;

      const isExactAlbum =
        Boolean(targetAlbumKey) && tile.dataset.albumKey === targetAlbumKey;
      tile.classList.add(isExactAlbum ? 'is-trail-album' : 'is-trail-artist');
      matchedTiles.push(tile);

      const yr = Number(tile.dataset.year);
      if (!Number.isNaN(yr) && yr > 0) {
        matchedYears.add(yr);
      }
    }

    if (matchedTiles.length === 0) {
      clear();
      return;
    }

    stageEl.classList.add('has-trail');

    for (const btn of railButtons) {
      const yr = Number(btn.dataset.railYear);
      btn.classList.toggle('has-trail-hit', matchedYears.has(yr));
    }

    currentIdx = Math.max(0, matchedTiles.indexOf(tileBtn));

    const sortedYears = Array.from(matchedYears).sort((a, b) => a - b);
    const yearSpan =
      sortedYears.length > 1
        ? `${sortedYears[0]}–${sortedYears[sortedYears.length - 1]}`
        : sortedYears.length === 1
          ? String(sortedYears[0])
          : '';
    const count = matchedTiles.length;
    const unit = count === 1 ? 'album' : 'albums';

    if (summaryEl) {
      summaryEl.textContent = yearSpan
        ? `${primaryArtist} · ${count} ${unit} · ${yearSpan}`
        : `${primaryArtist} · ${count} ${unit}`;
    }

    if (prevBtn) prevBtn.disabled = count <= 1;
    if (nextBtn) nextBtn.disabled = count <= 1;
    pillEl.hidden = false;
  }

  function step(delta: -1 | 1) {
    if (matchedTiles.length === 0) return;
    currentIdx =
      (currentIdx + delta + matchedTiles.length) % matchedTiles.length;
    const target = matchedTiles[currentIdx];
    if (!target) return;

    clearFocusPulse();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-trail-focus');
    focusedTile = target;
    focusTimer = window.setTimeout(() => {
      focusTimer = null;
      if (focusedTile === target) {
        target.classList.remove('is-trail-focus');
        focusedTile = null;
      }
    }, 1400);
  }

  function togglePin() {
    isPinned = !isPinned;
    if (pinBtn) {
      pinBtn.classList.toggle('is-pinned', isPinned);
      pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    }
  }

  function clearIfUnpinned() {
    if (!isPinned) {
      clear();
    }
  }

  function hasActiveTrail(): boolean {
    return matchedTiles.length > 0;
  }

  const onPrevClick = () => step(-1);
  const onNextClick = () => step(1);
  const onPinClick = () => togglePin();
  const onCloseClick = () => clear();

  prevBtn?.addEventListener('click', onPrevClick);
  nextBtn?.addEventListener('click', onNextClick);
  pinBtn?.addEventListener('click', onPinClick);
  closeBtn?.addEventListener('click', onCloseClick);

  function destroy() {
    clear();
    prevBtn?.removeEventListener('click', onPrevClick);
    nextBtn?.removeEventListener('click', onNextClick);
    pinBtn?.removeEventListener('click', onPinClick);
    closeBtn?.removeEventListener('click', onCloseClick);
  }

  return {
    activate,
    step,
    togglePin,
    clearIfUnpinned,
    clear,
    hasActiveTrail,
    destroy
  };
}
