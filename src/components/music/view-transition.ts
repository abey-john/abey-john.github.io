export interface MosaicCellSnapshot {
  albumId: string;
  albumKey: string;
  /** Atlas source rect in pixels */
  sx: number;
  sy: number;
  sSize: number;
  /** Viewport-space rect in CSS pixels */
  x: number;
  y: number;
  size: number;
}

export interface MosaicMorphSnapshot {
  atlasImg: HTMLImageElement;
  cells: MosaicCellSnapshot[];
  centerX: number;
  centerY: number;
}

export interface TimelineTileSnapshot {
  albumId: string;
  albumKey: string;
  span: 1 | 2 | 3;
  imgEl: HTMLImageElement | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MosaicTransitionParticipant {
  isAtlasReady: () => boolean;
  ensureAtlasLoaded: () => void;
  captureSnapshot: () => MosaicMorphSnapshot | null;
  prepareAsTarget: () => MosaicMorphSnapshot | null;
  finishReveal: () => void;
  hideImmediate: () => void;
}

export interface TimelineTransitionParticipant {
  captureVisibleSnapshot: () => TimelineTileSnapshot[];
  prepareAsTarget: () => TimelineTileSnapshot[];
  setMorphChromeOpacity: (opacity: number) => void;
  finishReveal: () => void;
  hideImmediate: () => void;
}

interface FlyingSprite {
  tile: TimelineTileSnapshot;
  cell: MosaicCellSnapshot;
  exactMatch: boolean;
  arcSign: number;
  arcAmp: number;
  delay: number;
}

interface DustSprite {
  cell: MosaicCellSnapshot;
  driftX: number;
  driftY: number;
  stagger: number;
}

const MORPH_UNMATCHED_TILES = true;
const DURATION_MS = 740;

let mosaicParticipant: MosaicTransitionParticipant | null = null;
let timelineParticipant: TimelineTransitionParticipant | null = null;
let activeCancelFn: (() => void) | null = null;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function drawRoundedClip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  if (r <= 0.25) {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    return;
  }
  const radius = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function pickNearestUnusedCell(
  candidates: MosaicCellSnapshot[],
  used: Uint8Array,
  indexByCell: Map<MosaicCellSnapshot, number>,
  targetX: number,
  targetY: number
): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const idx = indexByCell.get(candidates[i]);
    if (idx === undefined || used[idx]) continue;
    const cell = candidates[i];
    const cx = cell.x + cell.size * 0.5;
    const cy = cell.y + cell.size * 0.5;
    const d2 =
      (cx - targetX) * (cx - targetX) + (cy - targetY) * (cy - targetY);
    if (d2 < bestDist) {
      bestDist = d2;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

function pairCellsAndTiles(
  mosaicSnap: MosaicMorphSnapshot,
  timelineTiles: TimelineTileSnapshot[]
): { flying: FlyingSprite[]; dust: DustSprite[] } {
  const cells = mosaicSnap.cells;
  const used = new Uint8Array(cells.length);
  const indexByCell = new Map<MosaicCellSnapshot, number>();
  const cellsByAlbumId = new Map<string, MosaicCellSnapshot[]>();
  const cellsByAlbumKey = new Map<string, MosaicCellSnapshot[]>();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    indexByCell.set(cell, i);
    if (cell.albumId) {
      const list = cellsByAlbumId.get(cell.albumId);
      if (list) list.push(cell);
      else cellsByAlbumId.set(cell.albumId, [cell]);
    }
    if (cell.albumKey) {
      const list = cellsByAlbumKey.get(cell.albumKey);
      if (list) list.push(cell);
      else cellsByAlbumKey.set(cell.albumKey, [cell]);
    }
  }

  // Hero tiles (3x3, 2x2) get first pick of exact matches
  const sortedTiles = [...timelineTiles].sort((a, b) => b.span - a.span);
  const unmatchedTiles: TimelineTileSnapshot[] = [];
  const flying: FlyingSprite[] = [];

  const pushSprite = (
    tile: TimelineTileSnapshot,
    cell: MosaicCellSnapshot,
    exactMatch: boolean,
    idx: number
  ) => {
    const tCx = tile.x + tile.width * 0.5;
    const tCy = tile.y + tile.height * 0.5;
    const cCx = cell.x + cell.size * 0.5;
    const cCy = cell.y + cell.size * 0.5;
    const dist = Math.hypot(tCx - cCx, tCy - cCy);
    const arcSign = idx % 2 === 0 ? 1 : -1;
    const arcAmp = Math.min(26, dist * 0.085);
    const delay = (idx % 7) * 0.014;
    flying.push({ tile, cell, exactMatch, arcSign, arcAmp, delay });
  };

  let spriteCounter = 0;

  // Pass 1: Exact album-ID (or normalized albumKey) matches
  for (const tile of sortedTiles) {
    const tCx = tile.x + tile.width * 0.5;
    const tCy = tile.y + tile.height * 0.5;
    let chosenIdx = -1;

    if (tile.albumId && cellsByAlbumId.has(tile.albumId)) {
      chosenIdx = pickNearestUnusedCell(
        cellsByAlbumId.get(tile.albumId)!,
        used,
        indexByCell,
        tCx,
        tCy
      );
    }
    if (chosenIdx < 0 && tile.albumKey && cellsByAlbumKey.has(tile.albumKey)) {
      chosenIdx = pickNearestUnusedCell(
        cellsByAlbumKey.get(tile.albumKey)!,
        used,
        indexByCell,
        tCx,
        tCy
      );
    }

    if (chosenIdx >= 0) {
      used[chosenIdx] = 1;
      pushSprite(tile, cells[chosenIdx], true, spriteCounter++);
    } else {
      unmatchedTiles.push(tile);
    }
  }

  // Pass 2: Pair remaining visible Timeline tiles to nearest unassigned silhouette cells
  if (MORPH_UNMATCHED_TILES) {
    for (const tile of unmatchedTiles) {
      const tCx = tile.x + tile.width * 0.5;
      const tCy = tile.y + tile.height * 0.5;
      let chosenIdx = pickNearestUnusedCell(cells, used, indexByCell, tCx, tCy);

      if (chosenIdx >= 0) {
        used[chosenIdx] = 1;
        pushSprite(tile, cells[chosenIdx], false, spriteCounter++);
      } else if (cells.length > 0) {
        // Fallback when zoomed closely into Mosaic with fewer visible cells than visible tiles
        let fallbackIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          const cx = cell.x + cell.size * 0.5;
          const cy = cell.y + cell.size * 0.5;
          const d2 = (cx - tCx) * (cx - tCx) + (cy - tCy) * (cy - tCy);
          if (d2 < bestDist) {
            bestDist = d2;
            fallbackIdx = i;
          }
        }
        pushSprite(tile, cells[fallbackIdx], false, spriteCounter++);
      }
    }
  }

  // Pass 3: Remaining background cells gently scatter outward (or bloom back in)
  const dust: DustSprite[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (used[i]) continue;
    const cell = cells[i];
    const cx = cell.x + cell.size * 0.5;
    const cy = cell.y + cell.size * 0.5;
    const dx = cx - mosaicSnap.centerX;
    const dy = cy - mosaicSnap.centerY;
    const baseAngle = Math.atan2(dy, dx);
    const jitterAngle = baseAngle + (Math.random() - 0.5) * 0.65;
    const driftDist = 12 + Math.random() * 16;
    dust.push({
      cell,
      driftX: Math.cos(jitterAngle) * driftDist,
      driftY: Math.sin(jitterAngle) * driftDist,
      stagger: Math.random() * 0.26
    });
  }

  // Draw smaller tiles first so hero 2x2 and 3x3 covers glide cleanly above them
  flying.sort((a, b) => a.tile.span - b.tile.span);

  return { flying, dust };
}

export function registerMosaicTransition(
  participant: MosaicTransitionParticipant
): () => void {
  mosaicParticipant = participant;
  return () => {
    if (mosaicParticipant === participant) {
      mosaicParticipant = null;
    }
  };
}

export function registerTimelineTransition(
  participant: TimelineTransitionParticipant
): () => void {
  timelineParticipant = participant;
  return () => {
    if (timelineParticipant === participant) {
      timelineParticipant = null;
    }
  };
}

export function preloadMosaicAtlasForTransition(): void {
  mosaicParticipant?.ensureAtlasLoaded();
}

export function cancelActiveMusicMorph(): void {
  if (activeCancelFn) {
    const cancel = activeCancelFn;
    activeCancelFn = null;
    cancel();
  }
}

export function runMosaicTimelineMorph(
  prev: 'mosaic' | 'timeline',
  next: 'mosaic' | 'timeline',
  onCommitMode: () => void
): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }
  if (!mosaicParticipant || !timelineParticipant) return false;
  if (!mosaicParticipant.isAtlasReady()) return false;

  const toTimeline = prev === 'mosaic' && next === 'timeline';
  const mosaic = mosaicParticipant;
  const timeline = timelineParticipant;

  let mosaicSnap: MosaicMorphSnapshot | null = null;
  let timelineTiles: TimelineTileSnapshot[] = [];

  if (toTimeline) {
    mosaicSnap = mosaic.captureSnapshot();
    if (!mosaicSnap || mosaicSnap.cells.length === 0) return false;

    onCommitMode();
    timelineTiles = timeline.prepareAsTarget();
    if (timelineTiles.length === 0) {
      timeline.finishReveal();
      return true;
    }
  } else {
    timelineTiles = timeline.captureVisibleSnapshot();
    if (timelineTiles.length === 0) return false;

    onCommitMode();
    mosaicSnap = mosaic.prepareAsTarget();
    if (!mosaicSnap || mosaicSnap.cells.length === 0) {
      mosaic.finishReveal();
      return true;
    }
  }

  const { flying, dust } = pairCellsAndTiles(mosaicSnap, timelineTiles);
  const atlasImg = mosaicSnap.atlasImg;

  const overlay = document.createElement('canvas');
  overlay.setAttribute('data-music-morph-canvas', '');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '60';
  document.body.appendChild(overlay);

  const ctx = overlay.getContext('2d');
  if (!ctx) {
    overlay.remove();
    if (toTimeline) timeline.finishReveal();
    else mosaic.finishReveal();
    return true;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  overlay.width = Math.max(1, Math.round(vw * dpr));
  overlay.height = Math.max(1, Math.round(vh * dpr));

  const fallbackBg =
    getComputedStyle(document.documentElement)
      .getPropertyValue('--color-border-subtle')
      .trim() || '#e5e7eb';

  let rafId: number | null = null;
  let settled = false;
  const startMs = performance.now();

  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    window.removeEventListener('resize', onResize);
    overlay.remove();
    if (activeCancelFn === cleanup) {
      activeCancelFn = null;
    }
    if (toTimeline) {
      timeline.finishReveal();
    } else {
      mosaic.finishReveal();
    }
  };

  const onResize = () => {
    cleanup();
  };

  activeCancelFn = cleanup;
  window.addEventListener('resize', onResize);

  const drawFrame = (now: number) => {
    if (settled) return;
    const rawT = clamp01((now - startMs) / DURATION_MS);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Background Mosaic portrait scatter / reform
    for (let i = 0; i < dust.length; i++) {
      const d = dust[i];
      if (toTimeline) {
        const localT = clamp01((rawT - d.stagger * 0.5) / 0.56);
        if (localT >= 1) continue;
        const e = 1 - Math.pow(1 - localT, 2);
        const alpha = 1 - e;
        const scale = lerp(1, 0.25, e);
        const sz = d.cell.size * scale;
        const x = d.cell.x + (d.cell.size - sz) * 0.5 + d.driftX * e;
        const y = d.cell.y + (d.cell.size - sz) * 0.5 + d.driftY * e;
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          atlasImg,
          d.cell.sx,
          d.cell.sy,
          d.cell.sSize,
          d.cell.sSize,
          x,
          y,
          sz,
          sz
        );
      } else {
        const start = 0.28 + d.stagger * 0.6;
        const localT = clamp01((rawT - start) / (0.98 - start));
        if (localT <= 0) continue;
        const e = 1 - Math.pow(1 - localT, 3);
        const sz = d.cell.size * lerp(0.25, 1, e);
        const x = d.cell.x + (d.cell.size - sz) * 0.5 + d.driftX * (1 - e);
        const y = d.cell.y + (d.cell.size - sz) * 0.5 + d.driftY * (1 - e);
        ctx.globalAlpha = e;
        ctx.drawImage(
          atlasImg,
          d.cell.sx,
          d.cell.sy,
          d.cell.sSize,
          d.cell.sSize,
          x,
          y,
          sz,
          sz
        );
      }
    }
    ctx.globalAlpha = 1;

    // 2. Paired flying cover sprites
    for (let i = 0; i < flying.length; i++) {
      const s = flying[i];
      const p = clamp01((rawT - s.delay) / (1 - s.delay));
      const e = easeInOutCubic(p);

      const cCx = s.cell.x + s.cell.size * 0.5;
      const cCy = s.cell.y + s.cell.size * 0.5;
      const tCx = s.tile.x + s.tile.width * 0.5;
      const tCy = s.tile.y + s.tile.height * 0.5;

      const startCx = toTimeline ? cCx : tCx;
      const startCy = toTimeline ? cCy : tCy;
      const endCx = toTimeline ? tCx : cCx;
      const endCy = toTimeline ? tCy : cCy;

      const dx = endCx - startCx;
      const dy = endCy - startCy;
      const dist = Math.hypot(dx, dy);
      const nx = dist > 1 ? -dy / dist : 0;
      const ny = dist > 1 ? dx / dist : -1;
      const arcOffset = s.arcAmp * s.arcSign * Math.sin(Math.PI * p);

      const cx = lerp(startCx, endCx, e) + nx * arcOffset;
      const cy = lerp(startCy, endCy, e) + ny * arcOffset;

      const w = toTimeline
        ? lerp(s.cell.size, s.tile.width, e)
        : lerp(s.tile.width, s.cell.size, e);
      const h = toTimeline
        ? lerp(s.cell.size, s.tile.height, e)
        : lerp(s.tile.height, s.cell.size, e);
      const x = cx - w * 0.5;
      const y = cy - h * 0.5;

      const targetRadius = s.tile.span >= 3 ? 4 : 3;
      const radius = toTimeline
        ? lerp(0, targetRadius, e)
        : lerp(targetRadius, 0, e);

      const img = s.tile.imgEl;
      const imgReady = Boolean(img && img.complete && img.naturalWidth > 0);

      let atlasAlpha: number;
      let imgAlpha: number;
      if (!imgReady) {
        atlasAlpha = 1;
        imgAlpha = 0;
      } else if (toTimeline) {
        const blendStart = s.exactMatch ? 0.35 : 0.2;
        const blendEnd = s.exactMatch ? 0.85 : 0.78;
        imgAlpha = clamp01((p - blendStart) / (blendEnd - blendStart));
        atlasAlpha = 1 - imgAlpha;
      } else {
        const blend = clamp01((p - 0.22) / 0.56);
        atlasAlpha = blend;
        imgAlpha = 1 - blend;
      }

      ctx.save();
      drawRoundedClip(ctx, x, y, w, h, radius);
      ctx.clip();

      if (!imgReady && toTimeline) {
        ctx.fillStyle = fallbackBg;
        ctx.fillRect(x, y, w, h);
      }
      if (atlasAlpha > 0.01) {
        ctx.globalAlpha = atlasAlpha;
        ctx.drawImage(
          atlasImg,
          s.cell.sx,
          s.cell.sy,
          s.cell.sSize,
          s.cell.sSize,
          x,
          y,
          w,
          h
        );
      }
      if (imgAlpha > 0.01 && img) {
        ctx.globalAlpha = imgAlpha;
        ctx.drawImage(img, x, y, w, h);
      }
      ctx.restore();
    }

    ctx.restore();

    if (toTimeline) {
      const chromeOpacity = clamp01((rawT - 0.46) / 0.44);
      timeline.setMorphChromeOpacity(chromeOpacity);
    }

    if (rawT < 1) {
      rafId = requestAnimationFrame(drawFrame);
    } else {
      cleanup();
    }
  };

  rafId = requestAnimationFrame(drawFrame);
  return true;
}
