export type MusicViewMode = 'overview' | 'mosaic' | 'timeline';

export interface MusicViewModeChangeDetail {
  prev: MusicViewMode;
  next: MusicViewMode;
}

let currentViewMode: MusicViewMode = 'overview';

export function getActiveMusicViewMode(): MusicViewMode {
  return currentViewMode;
}

export function setMusicViewMode(next: MusicViewMode): void {
  const prev = currentViewMode;
  if (prev === next) return;
  currentViewMode = next;

  window.dispatchEvent(
    new CustomEvent('music:stop-other-audio', {
      detail: { source: 'view-mode' }
    })
  );
  window.dispatchEvent(
    new CustomEvent<MusicViewModeChangeDetail>('music:view-mode-change', {
      detail: { prev, next }
    })
  );
}

export function resetMusicViewMode(): void {
  currentViewMode = 'overview';
}
