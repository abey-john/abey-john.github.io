export interface TimelineTrailController {
  activate: (tileBtn: HTMLButtonElement) => void;
  clear: () => void;
  hasActiveTrail: () => boolean;
  destroy: () => void;
}

export function createTimelineTrail(
  stageEl: HTMLElement,
  tiles: HTMLButtonElement[],
  railButtons: HTMLButtonElement[],
  pillEl: HTMLElement,
  onDismiss?: () => void
): TimelineTrailController {
  const artistEl = pillEl.querySelector<HTMLElement>('[data-trail-artist]');
  const metaEl = pillEl.querySelector<HTMLElement>('[data-trail-meta]');
  const closeBtn =
    pillEl.querySelector<HTMLButtonElement>('[data-trail-close]');

  let hasMatch = false;

  function clear() {
    hasMatch = false;
    stageEl.classList.remove('has-trail');

    for (const tile of tiles) {
      tile.classList.remove('is-trail-album', 'is-trail-artist');
    }
    for (const btn of railButtons) {
      btn.classList.remove('has-trail-hit');
    }

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

    let count = 0;
    const matchedYears = new Set<number>();

    for (const tile of tiles) {
      tile.classList.remove('is-trail-album', 'is-trail-artist');
      const keys = (tile.dataset.artistKeys || '').split('|').filter(Boolean);
      if (!keys.includes(primaryKey)) continue;

      const isExactAlbum =
        Boolean(targetAlbumKey) && tile.dataset.albumKey === targetAlbumKey;
      tile.classList.add(isExactAlbum ? 'is-trail-album' : 'is-trail-artist');
      count++;

      const yr = Number(tile.dataset.year);
      if (!Number.isNaN(yr) && yr > 0) {
        matchedYears.add(yr);
      }
    }

    if (count === 0) {
      clear();
      return;
    }

    hasMatch = true;
    stageEl.classList.add('has-trail');

    for (const btn of railButtons) {
      const yr = Number(btn.dataset.railYear);
      btn.classList.toggle('has-trail-hit', matchedYears.has(yr));
    }

    const sortedYears = Array.from(matchedYears).sort((a, b) => a - b);
    const yearSpan =
      sortedYears.length > 1
        ? `${sortedYears[0]}–${sortedYears[sortedYears.length - 1]}`
        : sortedYears.length === 1
          ? String(sortedYears[0])
          : '';
    const unit = count === 1 ? 'album' : 'albums';

    if (artistEl) {
      artistEl.textContent = primaryArtist;
    }
    if (metaEl) {
      metaEl.textContent = yearSpan
        ? `${count} ${unit} · ${yearSpan}`
        : `${count} ${unit}`;
    }

    pillEl.hidden = false;
  }

  function hasActiveTrail(): boolean {
    return hasMatch;
  }

  const onCloseClick = () => {
    clear();
    onDismiss?.();
  };

  closeBtn?.addEventListener('click', onCloseClick);

  function destroy() {
    clear();
    closeBtn?.removeEventListener('click', onCloseClick);
  }

  return {
    activate,
    clear,
    hasActiveTrail,
    destroy
  };
}
