import {
  cancelActiveMusicMorph,
  runMosaicTimelineMorph
} from './view-transition';

export type MusicViewMode = 'overview' | 'mosaic' | 'timeline';

export interface MusicViewModeChangeDetail {
  prev: MusicViewMode;
  next: MusicViewMode;
  morphing?: boolean;
}

let currentViewMode: MusicViewMode = 'overview';

export function getActiveMusicViewMode(): MusicViewMode {
  return currentViewMode;
}

function dispatchModeChange(
  prev: MusicViewMode,
  next: MusicViewMode,
  morphing: boolean
): void {
  window.dispatchEvent(
    new CustomEvent<MusicViewModeChangeDetail>('music:view-mode-change', {
      detail: { prev, next, morphing }
    })
  );
}

export function setMusicViewMode(next: MusicViewMode): void {
  const prev = currentViewMode;
  if (prev === next) return;

  cancelActiveMusicMorph();
  currentViewMode = next;

  window.dispatchEvent(
    new CustomEvent('music:stop-other-audio', {
      detail: { source: 'view-mode' }
    })
  );

  if (
    (prev === 'mosaic' && next === 'timeline') ||
    (prev === 'timeline' && next === 'mosaic')
  ) {
    const started = runMosaicTimelineMorph(prev, next, () => {
      dispatchModeChange(prev, next, true);
    });
    if (started) return;
  }

  dispatchModeChange(prev, next, false);
}

export function resetMusicViewMode(): void {
  cancelActiveMusicMorph();
  currentViewMode = 'overview';
}
