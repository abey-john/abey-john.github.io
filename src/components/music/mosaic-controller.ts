import {
  cleanMatchText,
  extractPrimaryArtist,
  getMediumThumbUrl,
  resolveAlbumPreview
} from './audio-preview';
import {
  type MusicViewModeChangeDetail,
  resetMusicViewMode,
  setMusicViewMode
} from './view-mode';
import {
  type MosaicCellSnapshot,
  type MosaicMorphSnapshot,
  registerMosaicTransition
} from './view-transition';

export interface MosaicAlbum {
  id?: number;
  title: string;
  artist: string;
  image: string;
  rank: number;
  streams: number;
}

export interface MosaicPayload {
  atlasUrl: string;
  gridSize: number;
  gridCols?: number;
  gridRows?: number;
  tilePixelSize: number;
  albums: MosaicAlbum[];
  grid: number[];
}

export function initMusicMosaic(): () => void {
  const toggleBtn = document.querySelector<HTMLButtonElement>(
    '[data-mosaic-toggle]'
  );
  const normalView = document.querySelector<HTMLElement>(
    '[data-music-normal-view]'
  );
  const mosaicStage = document.querySelector<HTMLElement>(
    '[data-music-mosaic-stage]'
  );
  const canvas = document.querySelector<HTMLCanvasElement>(
    '[data-mosaic-canvas]'
  );
  const loupeCanvas = document.querySelector<HTMLCanvasElement>(
    '[data-mosaic-loupe]'
  );
  const viewport = document.querySelector<HTMLElement>(
    '[data-mosaic-viewport]'
  );
  const tooltip = document.querySelector<HTMLElement>('[data-mosaic-tooltip]');
  const resetZoomBtn = document.querySelector<HTMLButtonElement>(
    '[data-mosaic-reset-zoom]'
  );
  const payloadScript = document.querySelector<HTMLScriptElement>(
    '[data-mosaic-payload]'
  );

  if (
    !toggleBtn ||
    !normalView ||
    !mosaicStage ||
    !canvas ||
    !viewport ||
    !tooltip ||
    !payloadScript
  ) {
    return () => {};
  }

  let payload: MosaicPayload | null = null;
  try {
    payload = JSON.parse(payloadScript.textContent || '');
  } catch {
    return () => {};
  }

  if (!payload || !payload.albums?.length || !payload.grid?.length) {
    return () => {};
  }

  const { atlasUrl, gridSize, tilePixelSize, albums, grid } = payload;
  const gridCols = payload.gridCols || gridSize;
  const gridRows = payload.gridRows || gridSize;
  const totalCells = gridCols * gridRows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const loupeCtx = loupeCanvas ? loupeCanvas.getContext('2d') : null;
  const LOUPE_SIZE = 164;
  const LOUPE_RADIUS = LOUPE_SIZE / 2;
  const LOUPE_ZOOM = 3.6;

  // Tooltip DOM sub-elements
  const ttCover = tooltip.querySelector<HTMLCanvasElement>('[data-tt-cover]');
  const ttCoverCtx = ttCover ? ttCover.getContext('2d') : null;
  const ttTitle = tooltip.querySelector<HTMLElement>('[data-tt-title]');
  const ttArtist = tooltip.querySelector<HTMLElement>('[data-tt-artist]');
  const ttStats = tooltip.querySelector<HTMLElement>('[data-tt-stats]');
  const ttRing = tooltip.querySelector<SVGGeometryElement>('[data-tt-ring]');

  // State
  let isActive = false;
  let atlasImg: HTMLImageElement | null = null;
  let atlasLoaded = false;
  const rawCoverCache = new Map<number, HTMLImageElement>();
  let coverLoadTimer: number | null = null;

  // Viewport & Transform state
  let cssWidth = 0;
  let cssHeight = 0;
  let cellCss = 1;
  let baseOffsetX = 0;
  let baseOffsetY = 0;
  let dpr = 1;
  let scale = 1;
  let panX = 0;
  let panY = 0;

  // Entrance / Exit / Zoom animation state
  let rafId: number | null = null;
  let revealStartMs = 0;
  const REVEAL_DURATION_MS = 680;
  const EXIT_DURATION_MS = 480;
  const CONTENT_FADE_MS = 240;
  let isRevealing = false;
  let isExiting = false;
  let exitStartMs = 0;
  let transitionTimer: number | null = null;
  const tileRevealDelays = new Float32Array(totalCells);

  function randomizeRevealDelays() {
    for (let i = 0; i < tileRevealDelays.length; i++) {
      tileRevealDelays[i] = Math.random() * 0.62;
    }
  }
  randomizeRevealDelays();

  // Pointer / Hover / Drag / Pinch state
  const activePointers = new Map<number, { x: number; y: number }>();
  let hoveredCellIdx = -1;
  let lastPointerClientX = 0;
  let lastPointerClientY = 0;
  let lastPointerType = 'mouse';
  let isPointerInside = false;
  let isDragging = false;
  let isPinching = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  let pinchStartDist = 1;
  let pinchStartScale = 1;
  let pinchStartWorldX = 0;
  let pinchStartWorldY = 0;

  // Audio playback state
  let activeAudio: HTMLAudioElement | null = null;
  let activeCellIdx = -1;
  let activeAlbumIdx = -1;
  let isAudioLoading = false;
  let audioAbortController: AbortController | null = null;

  const mosaicAlbumIds = albums.map((a) => (a.id ? String(a.id) : ''));
  const mosaicAlbumKeys = albums.map((a) => {
    const stripped = a.title
      .toLowerCase()
      .replace(
        /\s*[(\[]\s*(deluxe|remaster|expanded|bonus|edition|special|anniversary)[^)\]]*[)\]]/gi,
        ''
      )
      .replace(
        /\s*[-–—]\s*(deluxe|remaster|expanded|bonus|edition|special|anniversary).*$/gi,
        ''
      )
      .trim();
    const titleKey = cleanMatchText(stripped) || cleanMatchText(a.title);
    const artistKey = cleanMatchText(extractPrimaryArtist(a.artist));
    return `${titleKey}:::${artistKey}`;
  });

  function buildMosaicSnapshot(): MosaicMorphSnapshot | null {
    if (!atlasLoaded || !atlasImg || !canvas || cssWidth <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const tileSize = cellCss * scale;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cells: MosaicCellSnapshot[] = [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let r = 0; r < gridRows; r++) {
      const rowOff = r * gridCols;
      const y = rect.top + panY + (baseOffsetY + r * cellCss) * scale;
      if (y + tileSize < -80 || y > vh + 80) continue;

      for (let c = 0; c < gridCols; c++) {
        const albumIdx = grid[rowOff + c];
        if (albumIdx === undefined || albumIdx < 0) continue;
        const x = rect.left + panX + (baseOffsetX + c * cellCss) * scale;
        if (x + tileSize < -80 || x > vw + 80) continue;

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + tileSize > maxX) maxX = x + tileSize;
        if (y + tileSize > maxY) maxY = y + tileSize;

        cells.push({
          albumId: mosaicAlbumIds[albumIdx] || '',
          albumKey: mosaicAlbumKeys[albumIdx] || '',
          sx: c * tilePixelSize,
          sy: r * tilePixelSize,
          sSize: tilePixelSize,
          x,
          y,
          size: tileSize
        });
      }
    }

    if (cells.length === 0) return null;

    return {
      atlasImg,
      cells,
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5
    };
  }

  function ensureAtlasLoaded() {
    if (atlasImg) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = atlasUrl;
    img.onload = () => {
      atlasLoaded = true;
      if (isActive) {
        if (hoveredCellIdx >= 0) {
          drawTooltipCover(hoveredCellIdx);
        }
        randomizeRevealDelays();
        revealStartMs = performance.now();
        isRevealing = true;
        scheduleRender();
      }
    };
    atlasImg = img;
  }

  function getUnblendedCoverImage(albumIdx: number): HTMLImageElement | null {
    const existing = rawCoverCache.get(albumIdx);
    if (existing) {
      return existing.complete && existing.naturalWidth > 0 ? existing : null;
    }
    return null;
  }

  function queueHighResCoverLoad(albumIdx: number) {
    if (rawCoverCache.has(albumIdx)) return;
    if (coverLoadTimer !== null) {
      window.clearTimeout(coverLoadTimer);
    }
    coverLoadTimer = window.setTimeout(() => {
      coverLoadTimer = null;
      if (!isActive || rawCoverCache.has(albumIdx)) return;
      const alb = albums[albumIdx];
      if (!alb?.image) return;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = getMediumThumbUrl(alb.image);
      img.onload = () => {
        if (!isActive) return;
        if (hoveredCellIdx >= 0 && grid[hoveredCellIdx] === albumIdx) {
          drawTooltipCover(hoveredCellIdx);
          if (isPointerInside) {
            renderLoupe(lastPointerClientX, lastPointerClientY);
          }
        }
        if (hoveredCellIdx !== -1 || activeCellIdx !== -1) {
          scheduleRender();
        }
      };
      rawCoverCache.set(albumIdx, img);
    }, 45);
  }

  function drawTooltipCover(cellIdx: number) {
    if (!ttCover || !ttCoverCtx || cellIdx < 0 || cellIdx >= grid.length) {
      return;
    }
    const albumIdx = grid[cellIdx];
    if (albumIdx === undefined || albumIdx < 0) return;

    const w = ttCover.width;
    const h = ttCover.height;
    ttCoverCtx.clearRect(0, 0, w, h);
    ttCoverCtx.imageSmoothingEnabled = true;
    ttCoverCtx.imageSmoothingQuality = 'high';

    const highResImg = getUnblendedCoverImage(albumIdx);
    if (highResImg) {
      ttCoverCtx.drawImage(highResImg, 0, 0, w, h);
      return;
    }

    if (atlasLoaded && atlasImg) {
      const r = Math.floor(cellIdx / gridCols);
      const c = cellIdx % gridCols;
      ttCoverCtx.drawImage(
        atlasImg,
        c * tilePixelSize,
        r * tilePixelSize,
        tilePixelSize,
        tilePixelSize,
        0,
        0,
        w,
        h
      );
    }

    queueHighResCoverLoad(albumIdx);
  }

  function clampPan(nextPanX: number, nextPanY: number, nextScale: number) {
    if (nextScale <= 1.001) {
      panX = 0;
      panY = 0;
      return;
    }
    const minPanX = cssWidth * (1 - nextScale);
    const minPanY = cssHeight * (1 - nextScale);
    panX = Math.min(0, Math.max(minPanX, nextPanX));
    panY = Math.min(0, Math.max(minPanY, nextPanY));
  }

  function updateResetZoomButton() {
    if (viewport) {
      viewport.classList.toggle('is-zoomed', scale > 1.03);
    }
    if (!resetZoomBtn) return;
    if (scale > 1.03) {
      resetZoomBtn.hidden = false;
      resetZoomBtn.textContent = `Reset Zoom (${scale.toFixed(1)}×)`;
    } else {
      resetZoomBtn.hidden = true;
    }
  }

  function measureCanvas() {
    if (!viewport || !canvas) return;
    const rect = viewport.getBoundingClientRect();
    const stageWidth = Math.max(
      280,
      viewport.clientWidth || Math.floor(rect.width)
    );
    const docTop = Math.max(0, rect.top + window.scrollY);
    const footerEl = document.querySelector<HTMLElement>('.site-footer');
    const footerH = footerEl ? footerEl.offsetHeight : 80;
    const mainEl = document.querySelector<HTMLElement>('.main-content');
    const mainPadBottom = mainEl
      ? parseFloat(window.getComputedStyle(mainEl).paddingBottom) || 0
      : 16;

    const maxStageHeight = Math.max(
      240,
      Math.floor(window.innerHeight - docTop - footerH - mainPadBottom - 4)
    );

    const nextCellCss = Math.min(
      stageWidth / gridCols,
      maxStageHeight / gridRows
    );
    const nextWidth = stageWidth;
    const nextHeight = Math.max(220, Math.floor(nextCellCss * gridRows));
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5);

    if (nextWidth !== cssWidth || nextHeight !== cssHeight || nextDpr !== dpr) {
      const ratioX = cssWidth > 0 ? nextWidth / cssWidth : 1;
      const ratioY = cssHeight > 0 ? nextHeight / cssHeight : 1;
      cssWidth = nextWidth;
      cssHeight = nextHeight;
      cellCss = nextCellCss;
      baseOffsetX = (cssWidth - cellCss * gridCols) / 2;
      baseOffsetY = (cssHeight - cellCss * gridRows) / 2;
      dpr = nextDpr;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      if (loupeCanvas) {
        loupeCanvas.width = Math.round(LOUPE_SIZE * dpr);
        loupeCanvas.height = Math.round(LOUPE_SIZE * dpr);
      }
      clampPan(panX * ratioX, panY * ratioY, scale);
    }
  }

  function renderFrame(now: number = performance.now()) {
    rafId = null;
    if ((!isActive && !isExiting) || !ctx || !canvas) return;

    measureCanvas();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!atlasLoaded || !atlasImg) {
      ctx.restore();
      return;
    }

    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (isExiting) {
      const elapsed = now - exitStartMs;
      const overallProgress = Math.max(
        0,
        Math.min(1, elapsed / EXIT_DURATION_MS)
      );

      for (let r = 0; r < gridRows; r++) {
        const rowOffset = r * gridCols;
        for (let c = 0; c < gridCols; c++) {
          const cellIdx = rowOffset + c;
          if (grid[cellIdx] < 0) continue;

          const delay = tileRevealDelays[cellIdx];
          const localT = Math.max(
            0,
            Math.min(1, (overallProgress - delay) / 0.38)
          );
          if (localT >= 1) continue;

          // Shrink & fade out (reverse of entry)
          const remaining = 1 - Math.pow(localT, 2.5);
          const tileScale = 0.2 + 0.8 * remaining;
          const drawSize = cellCss * tileScale + 0.35;
          const dx = baseOffsetX + c * cellCss + (cellCss - drawSize) / 2;
          const dy = baseOffsetY + r * cellCss + (cellCss - drawSize) / 2;

          ctx.globalAlpha = remaining;
          ctx.drawImage(
            atlasImg,
            c * tilePixelSize,
            r * tilePixelSize,
            tilePixelSize,
            tilePixelSize,
            dx,
            dy,
            drawSize,
            drawSize
          );
        }
      }
      ctx.globalAlpha = 1;

      if (elapsed < EXIT_DURATION_MS) {
        scheduleRender();
      } else {
        isExiting = false;
        mosaicStage!.hidden = true;
        normalView!.hidden = false;
        normalView!.classList.remove('is-fading-out');
        normalView!.classList.add('is-fading-in');
        if (transitionTimer !== null) {
          window.clearTimeout(transitionTimer);
        }
        transitionTimer = window.setTimeout(() => {
          transitionTimer = null;
          normalView?.classList.remove('is-fading-in');
        }, 360);
        hoveredCellIdx = -1;
        isPointerInside = false;
        tooltip!.hidden = true;
        if (loupeCanvas) loupeCanvas.hidden = true;
      }
      ctx.restore();
      return;
    }

    const elapsed = now - revealStartMs;

    if (isRevealing && elapsed < REVEAL_DURATION_MS) {
      const overallProgress = Math.max(
        0,
        Math.min(1, elapsed / REVEAL_DURATION_MS)
      );

      for (let r = 0; r < gridRows; r++) {
        const rowOffset = r * gridCols;
        for (let c = 0; c < gridCols; c++) {
          const cellIdx = rowOffset + c;
          if (grid[cellIdx] < 0) continue;

          const delay = tileRevealDelays[cellIdx];
          const localT = Math.max(
            0,
            Math.min(1, (overallProgress - delay) / 0.38)
          );
          if (localT <= 0) continue;

          // Snappy cubic ease-out pop-in
          const eased = 1 - Math.pow(1 - localT, 3);
          const tileScale = 0.2 + 0.8 * eased;
          const drawSize = cellCss * tileScale + 0.35;
          const dx = baseOffsetX + c * cellCss + (cellCss - drawSize) / 2;
          const dy = baseOffsetY + r * cellCss + (cellCss - drawSize) / 2;

          ctx.globalAlpha = eased;
          ctx.drawImage(
            atlasImg,
            c * tilePixelSize,
            r * tilePixelSize,
            tilePixelSize,
            tilePixelSize,
            dx,
            dy,
            drawSize,
            drawSize
          );
        }
      }
      ctx.globalAlpha = 1;
      scheduleRender();
    } else {
      const wasRevealing = isRevealing;
      isRevealing = false;
      ctx.drawImage(
        atlasImg,
        0,
        0,
        gridCols * tilePixelSize,
        gridRows * tilePixelSize,
        baseOffsetX,
        baseOffsetY,
        gridCols * cellCss,
        gridRows * cellCss
      );

      // Highlight active audio tile if any
      if (
        activeCellIdx >= 0 &&
        activeCellIdx < grid.length &&
        grid[activeCellIdx] >= 0
      ) {
        drawHighlightedTile(activeCellIdx, true);
      }

      // Highlight hovered tile with 100% un-tinted cover + crisp border
      if (
        hoveredCellIdx >= 0 &&
        hoveredCellIdx < grid.length &&
        grid[hoveredCellIdx] >= 0 &&
        hoveredCellIdx !== activeCellIdx
      ) {
        drawHighlightedTile(hoveredCellIdx, false);
      }

      if (wasRevealing && isPointerInside && hoveredCellIdx >= 0) {
        renderLoupe(lastPointerClientX, lastPointerClientY);
        positionTooltip(lastPointerClientX, lastPointerClientY);
      }
    }

    ctx.restore();
  }

  function drawHighlightedTile(cellIdx: number, isAudioTile: boolean) {
    if (!ctx) return;
    const albumIdx = grid[cellIdx];
    if (albumIdx === undefined || albumIdx < 0) return;

    const r = Math.floor(cellIdx / gridCols);
    const c = cellIdx % gridCols;
    const x = baseOffsetX + c * cellCss;
    const y = baseOffsetY + r * cellCss;

    const unblendedImg = getUnblendedCoverImage(albumIdx);

    if (unblendedImg) {
      ctx.drawImage(unblendedImg, x, y, cellCss, cellCss);
    }

    const lineWidth = Math.max(1 / scale, 1.35 / scale);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = isAudioTile ? '#10b981' : '#ffffff';
    ctx.strokeRect(
      x + lineWidth * 0.5,
      y + lineWidth * 0.5,
      cellCss - lineWidth,
      cellCss - lineWidth
    );
  }

  function renderLoupe(clientX: number, clientY: number) {
    if (
      !loupeCanvas ||
      !loupeCtx ||
      !viewport ||
      !canvas ||
      !atlasLoaded ||
      !atlasImg ||
      isRevealing ||
      !isPointerInside ||
      lastPointerType === 'touch' ||
      hoveredCellIdx < 0 ||
      scale > 1.02
    ) {
      if (loupeCanvas) loupeCanvas.hidden = true;
      return;
    }

    const vpRect = viewport.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const localX = clientX - cRect.left;
    const localY = clientY - cRect.top;

    const gridX = (localX - panX) / scale - baseOffsetX;
    const gridY = (localY - panY) / scale - baseOffsetY;

    loupeCanvas.hidden = false;
    const lx = clientX - vpRect.left - LOUPE_RADIUS;
    const ly = clientY - vpRect.top - LOUPE_RADIUS;
    loupeCanvas.style.transform = `translate3d(${Math.round(lx)}px, ${Math.round(ly)}px, 0)`;

    loupeCtx.save();
    loupeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    loupeCtx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    loupeCtx.imageSmoothingEnabled = true;
    loupeCtx.imageSmoothingQuality = 'high';

    loupeCtx.translate(LOUPE_RADIUS, LOUPE_RADIUS);
    loupeCtx.scale(LOUPE_ZOOM, LOUPE_ZOOM);
    loupeCtx.translate(-gridX, -gridY);

    loupeCtx.drawImage(
      atlasImg,
      0,
      0,
      gridCols * tilePixelSize,
      gridRows * tilePixelSize,
      0,
      0,
      gridCols * cellCss,
      gridRows * cellCss
    );

    const drawLoupeHighlight = (cellIdx: number, isAudioTile: boolean) => {
      const albumIdx = grid[cellIdx];
      if (albumIdx === undefined || albumIdx < 0) return;
      const r = Math.floor(cellIdx / gridCols);
      const c = cellIdx % gridCols;
      const x = c * cellCss;
      const y = r * cellCss;
      const unblendedImg = getUnblendedCoverImage(albumIdx);
      if (unblendedImg) {
        loupeCtx.drawImage(unblendedImg, x, y, cellCss, cellCss);
      }
      const lw = 1.6 / LOUPE_ZOOM;
      loupeCtx.lineWidth = lw;
      loupeCtx.strokeStyle = isAudioTile ? '#10b981' : '#ffffff';
      loupeCtx.strokeRect(
        x + lw * 0.5,
        y + lw * 0.5,
        cellCss - lw,
        cellCss - lw
      );
    };

    if (
      activeCellIdx >= 0 &&
      activeCellIdx < grid.length &&
      grid[activeCellIdx] >= 0
    ) {
      drawLoupeHighlight(activeCellIdx, true);
    }

    if (
      hoveredCellIdx >= 0 &&
      hoveredCellIdx < grid.length &&
      grid[hoveredCellIdx] >= 0 &&
      hoveredCellIdx !== activeCellIdx
    ) {
      drawLoupeHighlight(hoveredCellIdx, false);
    }

    loupeCtx.restore();
  }

  function scheduleRender() {
    if (rafId === null) {
      rafId = requestAnimationFrame(renderFrame);
    }
  }

  function getCellFromClientCoords(clientX: number, clientY: number): number {
    if (!canvas || cssWidth <= 0 || cssHeight <= 0) return -1;
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    if (
      localX < 0 ||
      localY < 0 ||
      localX >= rect.width ||
      localY >= rect.height
    ) {
      return -1;
    }

    const worldX = (localX - panX) / scale - baseOffsetX;
    const worldY = (localY - panY) / scale - baseOffsetY;
    const c = Math.floor(worldX / cellCss);
    const r = Math.floor(worldY / cellCss);

    if (r < 0 || r >= gridRows || c < 0 || c >= gridCols) return -1;
    const cellIdx = r * gridCols + c;
    if (grid[cellIdx] === undefined || grid[cellIdx] < 0) return -1;
    return cellIdx;
  }

  function updateTooltipContent(cellIdx: number) {
    if (!tooltip || cellIdx < 0 || cellIdx >= grid.length) {
      if (tooltip) tooltip.hidden = true;
      return;
    }

    const albumIdx = grid[cellIdx];
    const alb = albums[albumIdx];
    if (!alb) {
      tooltip.hidden = true;
      return;
    }

    drawTooltipCover(cellIdx);
    if (ttTitle) ttTitle.textContent = alb.title;
    if (ttArtist) ttArtist.textContent = alb.artist;
    if (ttStats) {
      ttStats.textContent = `#${alb.rank.toLocaleString()} • ${alb.streams.toLocaleString()} streams`;
    }

    syncTooltipAudioState(albumIdx);
    tooltip.hidden = false;
  }

  function positionTooltip(clientX: number, clientY: number) {
    if (!tooltip || tooltip.hidden || !viewport) return;
    const vpRect = viewport.getBoundingClientRect();
    const ttRect = tooltip.getBoundingClientRect();
    const isLoupeShown = loupeCanvas && !loupeCanvas.hidden;
    const offsetX = isLoupeShown ? LOUPE_RADIUS + 14 : 16;
    const offsetY = isLoupeShown ? -ttRect.height * 0.5 : 16;

    let left = clientX - vpRect.left + offsetX;
    let top = clientY - vpRect.top + offsetY;

    if (left + ttRect.width > vpRect.width - 8) {
      left = clientX - vpRect.left - ttRect.width - offsetX;
    }
    if (!isLoupeShown && top + ttRect.height > vpRect.height - 8) {
      top = clientY - vpRect.top - ttRect.height - 16;
    }

    left = Math.max(8, Math.min(vpRect.width - ttRect.width - 8, left));
    top = Math.max(8, Math.min(vpRect.height - ttRect.height - 8, top));

    tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function syncTooltipAudioState(inspectedAlbumIdx: number) {
    if (!tooltip) return;
    const isSameAlbum =
      activeAlbumIdx !== -1 && inspectedAlbumIdx === activeAlbumIdx;
    const isPlaying =
      isSameAlbum && activeAudio !== null && !activeAudio.paused;
    const isLoading = isSameAlbum && isAudioLoading;

    tooltip.classList.toggle('is-playing', isPlaying);
    tooltip.classList.toggle('is-loading', isLoading);
    tooltip.classList.toggle(
      'is-paused',
      isSameAlbum && !isPlaying && !isLoading && activeAudio !== null
    );

    if (!isSameAlbum && ttRing) {
      ttRing.style.strokeDashoffset = '100';
    }
  }

  function stopMosaicAudio() {
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
    activeCellIdx = -1;
    activeAlbumIdx = -1;
    isAudioLoading = false;

    if (tooltip) {
      tooltip.classList.remove('is-playing', 'is-loading', 'is-paused');
    }
    if (ttRing) {
      ttRing.style.strokeDashoffset = '100';
    }
    if (isActive) {
      scheduleRender();
    }
  }

  async function handleTileClick(cellIdx: number) {
    if (cellIdx < 0 || cellIdx >= grid.length) return;
    const albumIdx = grid[cellIdx];
    const alb = albums[albumIdx];
    if (!alb) return;

    // Toggle pause/resume if clicking the currently active album
    if (activeAlbumIdx === albumIdx && activeAudio) {
      if (activeAudio.paused) {
        try {
          await activeAudio.play();
          syncTooltipAudioState(
            hoveredCellIdx >= 0 ? grid[hoveredCellIdx] : albumIdx
          );
          scheduleRender();
        } catch {}
      } else {
        activeAudio.pause();
        syncTooltipAudioState(
          hoveredCellIdx >= 0 ? grid[hoveredCellIdx] : albumIdx
        );
        scheduleRender();
      }
      return;
    }

    stopMosaicAudio();
    window.dispatchEvent(
      new CustomEvent('music:stop-other-audio', {
        detail: { source: 'music-mosaic' }
      })
    );

    activeCellIdx = cellIdx;
    activeAlbumIdx = albumIdx;
    isAudioLoading = true;
    syncTooltipAudioState(albumIdx);
    scheduleRender();

    audioAbortController = new AbortController();
    const signal = audioAbortController.signal;

    try {
      const previewUrl = await resolveAlbumPreview(alb, signal);
      if (signal.aborted || activeAlbumIdx !== albumIdx) return;

      isAudioLoading = false;
      if (!previewUrl) {
        stopMosaicAudio();
        return;
      }

      const audio = new Audio(previewUrl);
      activeAudio = audio;
      const MAX_DURATION = 30;

      audio.addEventListener('timeupdate', () => {
        if (activeAlbumIdx !== albumIdx) return;
        const cur = audio.currentTime || 0;
        if (cur >= MAX_DURATION) {
          stopMosaicAudio();
          return;
        }
        if (cur >= MAX_DURATION - 1.5) {
          try {
            audio.volume = Math.max(0, Math.min(1, (MAX_DURATION - cur) / 1.5));
          } catch {}
        }
        if (
          ttRing &&
          hoveredCellIdx >= 0 &&
          grid[hoveredCellIdx] === albumIdx
        ) {
          const pct = Math.min(100, Math.max(0, (cur / MAX_DURATION) * 100));
          ttRing.style.strokeDashoffset = `${100 - pct}`;
        }
      });

      audio.addEventListener('ended', () => {
        if (activeAlbumIdx === albumIdx) stopMosaicAudio();
      });

      audio.addEventListener('error', () => {
        if (activeAlbumIdx === albumIdx) stopMosaicAudio();
      });

      await audio.play();
      syncTooltipAudioState(
        hoveredCellIdx >= 0 ? grid[hoveredCellIdx] : albumIdx
      );
      scheduleRender();
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        stopMosaicAudio();
      }
    }
  }

  function enterMosaic(skipNormalFade: boolean) {
    if (isActive) return;
    isActive = true;

    toggleBtn!.classList.add('is-active');
    toggleBtn!.setAttribute('aria-pressed', 'true');

    stopMosaicAudio();
    activePointers.clear();
    isDragging = false;
    isPinching = false;
    isExiting = false;

    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }

    const revealStage = () => {
      if (!isActive) return;
      normalView!.hidden = true;
      normalView!.classList.remove('is-fading-out', 'is-fading-in');
      mosaicStage!.hidden = false;
      window.scrollTo({ top: 0 });
      scale = 1;
      panX = 0;
      panY = 0;
      hoveredCellIdx = -1;
      isPointerInside = false;
      tooltip!.hidden = true;
      if (loupeCanvas) loupeCanvas.hidden = true;
      updateResetZoomButton();
      measureCanvas();

      ensureAtlasLoaded();
      if (atlasLoaded) {
        randomizeRevealDelays();
        revealStartMs = performance.now();
        isRevealing = true;
      }
      scheduleRender();
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

  function exitMosaic(revealNormalView: boolean) {
    const wasActiveOrExiting = isActive || isExiting;
    isActive = false;

    toggleBtn!.classList.remove('is-active');
    toggleBtn!.setAttribute('aria-pressed', 'false');

    stopMosaicAudio();
    activePointers.clear();
    isDragging = false;
    isPinching = false;

    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }

    scale = 1;
    panX = 0;
    panY = 0;
    hoveredCellIdx = -1;
    isPointerInside = false;
    tooltip!.hidden = true;
    if (loupeCanvas) loupeCanvas.hidden = true;
    updateResetZoomButton();

    if (!revealNormalView) {
      isRevealing = false;
      isExiting = false;
      mosaicStage!.hidden = true;
      return;
    }

    if (!wasActiveOrExiting) return;
    normalView!.classList.remove('is-fading-out', 'is-fading-in');

    if (atlasLoaded && atlasImg && !mosaicStage!.hidden) {
      randomizeRevealDelays();
      isRevealing = false;
      isExiting = true;
      exitStartMs = performance.now();
      scheduleRender();
    } else {
      mosaicStage!.hidden = true;
      normalView!.hidden = false;
    }
  }

  function hideMosaicImmediate() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    isRevealing = false;
    isExiting = false;
    canvas!.style.visibility = '';
    mosaicStage!.hidden = true;
  }

  const unregisterTransition = registerMosaicTransition({
    isAtlasReady: () => Boolean(atlasLoaded && atlasImg),
    ensureAtlasLoaded,
    captureSnapshot: buildMosaicSnapshot,
    prepareAsTarget: () => {
      if (!atlasLoaded || !atlasImg) return null;
      normalView!.hidden = true;
      normalView!.classList.remove('is-fading-out', 'is-fading-in');
      mosaicStage!.hidden = false;
      canvas!.style.visibility = 'hidden';
      window.scrollTo({ top: 0 });
      scale = 1;
      panX = 0;
      panY = 0;
      hoveredCellIdx = -1;
      isPointerInside = false;
      tooltip!.hidden = true;
      if (loupeCanvas) loupeCanvas.hidden = true;
      updateResetZoomButton();
      measureCanvas();
      return buildMosaicSnapshot();
    },
    finishReveal: () => {
      canvas!.style.visibility = '';
      isRevealing = false;
      isExiting = false;
      renderFrame();
    },
    hideImmediate: hideMosaicImmediate
  });

  // Event Listeners
  const onToggleClick = () => {
    setMusicViewMode(isActive ? 'overview' : 'mosaic');
  };

  const onViewModeChange = (e: Event) => {
    const { prev, next, morphing } = (
      e as CustomEvent<MusicViewModeChangeDetail>
    ).detail;
    if (morphing) {
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (next === 'mosaic') {
        isActive = true;
        toggleBtn!.classList.add('is-active');
        toggleBtn!.setAttribute('aria-pressed', 'true');
        stopMosaicAudio();
        activePointers.clear();
        isDragging = false;
        isPinching = false;
        isExiting = false;
        isRevealing = false;
      } else if (prev === 'mosaic') {
        isActive = false;
        toggleBtn!.classList.remove('is-active');
        toggleBtn!.setAttribute('aria-pressed', 'false');
        stopMosaicAudio();
        activePointers.clear();
        isDragging = false;
        isPinching = false;
        hoveredCellIdx = -1;
        isPointerInside = false;
        tooltip!.hidden = true;
        if (loupeCanvas) loupeCanvas.hidden = true;
        hideMosaicImmediate();
      }
      return;
    }

    if (next === 'mosaic') {
      enterMosaic(prev !== 'overview');
    } else if (next === 'overview') {
      exitMosaic(true);
    } else {
      exitMosaic(false);
    }
  };

  // Preload atlas on button hover so first click is instantaneous
  const onToggleHover = () => {
    ensureAtlasLoaded();
  };

  const onResetZoomClick = () => {
    activePointers.clear();
    isDragging = false;
    isPinching = false;
    scale = 1;
    panX = 0;
    panY = 0;
    updateResetZoomButton();
    scheduleRender();
  };

  let touchStartedOnTile = false;

  function beginPinchFromCoords(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) {
    if (!canvas) return;
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist < 4) return;

    const rect = canvas.getBoundingClientRect();
    const midX = (x1 + x2) / 2 - rect.left;
    const midY = (y1 + y2) / 2 - rect.top;

    isPinching = true;
    dragMoved = true;
    pinchStartDist = dist;
    pinchStartScale = scale;
    pinchStartWorldX = (midX - panX) / scale;
    pinchStartWorldY = (midY - panY) / scale;

    hoveredCellIdx = -1;
    if (tooltip) tooltip.hidden = true;
    if (loupeCanvas) loupeCanvas.hidden = true;
  }

  function updatePinchFromCoords(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) {
    if (!canvas) return;
    if (!isPinching) {
      beginPinchFromCoords(x1, y1, x2, y2);
    }
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist >= 4 && pinchStartDist >= 4) {
      const rect = canvas.getBoundingClientRect();
      const midX = (x1 + x2) / 2 - rect.left;
      const midY = (y1 + y2) / 2 - rect.top;

      const nextScale = Math.min(
        6,
        Math.max(1, pinchStartScale * (dist / pinchStartDist))
      );
      const nextPanX = midX - pinchStartWorldX * nextScale;
      const nextPanY = midY - pinchStartWorldY * nextScale;

      scale = nextScale;
      clampPan(nextPanX, nextPanY, scale);
      updateResetZoomButton();
      scheduleRender();
    }
  }

  function beginPinch() {
    if (activePointers.size < 2) return;
    const pts = Array.from(activePointers.values());
    beginPinchFromCoords(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!isActive || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const startCellIdx = getCellFromClientCoords(e.clientX, e.clientY);

    if (e.pointerType === 'touch') {
      if (activePointers.size === 0) {
        touchStartedOnTile = startCellIdx !== -1;
      }
      // If touching empty space with 1 finger, let the browser handle native page scrolling
      if (!touchStartedOnTile && activePointers.size === 0) {
        isDragging = true;
        isPinching = false;
        dragMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
        return;
      }
    }

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'mouse' && startCellIdx !== -1) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    }

    if (activePointers.size === 1) {
      touchStartedOnTile = startCellIdx !== -1;
      isDragging = true;
      isPinching = false;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartPanX = panX;
      dragStartPanY = panY;
    } else if (activePointers.size >= 2) {
      beginPinch();
      scheduleRender();
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isActive) return;
    lastPointerClientX = e.clientX;
    lastPointerClientY = e.clientY;
    lastPointerType = e.pointerType || 'mouse';
    isPointerInside = e.pointerType !== 'touch';

    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch-to-zoom + two-finger pan
    if (activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      updatePinchFromCoords(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      return;
    }

    if (isDragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) > (e.pointerType === 'touch' ? 6 : 4)) {
        dragMoved = true;
      }
      if (
        dragMoved &&
        scale > 1.01 &&
        (e.pointerType === 'mouse' || touchStartedOnTile)
      ) {
        clampPan(dragStartPanX + dx, dragStartPanY + dy, scale);
        canvas.style.cursor = 'grabbing';
        if (loupeCanvas) loupeCanvas.hidden = true;
        scheduleRender();
        return;
      }
    }

    if (e.pointerType === 'touch') return;

    const cellIdx = getCellFromClientCoords(e.clientX, e.clientY);
    canvas.style.cursor =
      cellIdx !== -1 ? (scale > 1.02 ? 'grab' : 'pointer') : 'default';
    if (cellIdx !== hoveredCellIdx) {
      hoveredCellIdx = cellIdx;
      updateTooltipContent(cellIdx);
      scheduleRender();
    }
    renderLoupe(e.clientX, e.clientY);
    positionTooltip(e.clientX, e.clientY);
  };

  const onPointerUpOrCancel = (e: PointerEvent) => {
    if (!isActive) return;
    activePointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}

    if (activePointers.size >= 2) {
      beginPinch();
      return;
    }

    if (activePointers.size === 1) {
      const remaining = Array.from(activePointers.values())[0];
      isPinching = false;
      isDragging = true;
      dragMoved = true;
      dragStartX = remaining.x;
      dragStartY = remaining.y;
      dragStartPanX = panX;
      dragStartPanY = panY;
      return;
    }

    if (isDragging) {
      const wasTap = e.type === 'pointerup' && !dragMoved && !isPinching;
      isDragging = false;
      isPinching = false;
      const cellIdx = getCellFromClientCoords(e.clientX, e.clientY);
      canvas.style.cursor =
        cellIdx !== -1 ? (scale > 1.02 ? 'grab' : 'pointer') : 'default';

      if (wasTap) {
        if (cellIdx !== -1) {
          hoveredCellIdx = cellIdx;
          updateTooltipContent(cellIdx);
          positionTooltip(e.clientX, e.clientY);
          handleTileClick(cellIdx);
        } else {
          hoveredCellIdx = -1;
          if (tooltip) tooltip.hidden = true;
          stopMosaicAudio();
          scheduleRender();
        }
      }
    }
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (!isActive || e.pointerType === 'touch' || activePointers.size > 0) {
      return;
    }
    isPointerInside = false;
    hoveredCellIdx = -1;
    if (tooltip) tooltip.hidden = true;
    if (loupeCanvas) loupeCanvas.hidden = true;
    scheduleRender();
  };

  const onTouchStart = (e: TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartedOnTile = getCellFromClientCoords(t.clientX, t.clientY) !== -1;
      isDragging = true;
      isPinching = false;
      dragMoved = false;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      dragStartPanX = panX;
      dragStartPanY = panY;
    } else if (e.touches.length >= 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      beginPinchFromCoords(t1.clientX, t1.clientY, t2.clientX, t2.clientY);
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length >= 2) {
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      updatePinchFromCoords(t1.clientX, t1.clientY, t2.clientX, t2.clientY);
      return;
    }
    if (e.touches.length === 1 && touchStartedOnTile && scale > 1.01) {
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - dragStartX;
      const dy = t.clientY - dragStartY;
      if (Math.hypot(dx, dy) > 6) {
        dragMoved = true;
      }
      if (dragMoved) {
        clampPan(dragStartPanX + dx, dragStartPanY + dy, scale);
        scheduleRender();
      }
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      isPinching = false;
      isDragging = true;
      dragMoved = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      dragStartPanX = panX;
      dragStartPanY = panY;
    } else if (e.touches.length === 0) {
      isPinching = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isActive) return;
    if (e.key === 'Escape') {
      if (scale > 1.03) {
        onResetZoomClick();
      } else {
        setMusicViewMode('overview');
      }
    }
  };

  const onResize = () => {
    if (isActive) {
      scheduleRender();
      if (hoveredCellIdx !== -1) {
        positionTooltip(lastPointerClientX, lastPointerClientY);
      }
    }
  };

  const onStopOtherAudio = (e: Event) => {
    if ((e as CustomEvent).detail?.source !== 'music-mosaic') {
      stopMosaicAudio();
    }
  };

  toggleBtn.addEventListener('click', onToggleClick);
  toggleBtn.addEventListener('mouseenter', onToggleHover);
  toggleBtn.addEventListener('focus', onToggleHover);
  resetZoomBtn?.addEventListener('click', onResetZoomClick);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: true });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUpOrCancel);
  canvas.addEventListener('pointercancel', onPointerUpOrCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  window.addEventListener('music:stop-other-audio', onStopOtherAudio);
  window.addEventListener('music:view-mode-change', onViewModeChange);

  return () => {
    unregisterTransition();
    canvas.style.visibility = '';
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    isExiting = false;
    isRevealing = false;
    if (coverLoadTimer !== null) {
      window.clearTimeout(coverLoadTimer);
      coverLoadTimer = null;
    }
    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    normalView?.classList.remove('is-fading-out', 'is-fading-in');
    stopMosaicAudio();
    resetMusicViewMode();
    toggleBtn.removeEventListener('click', onToggleClick);
    toggleBtn.removeEventListener('mouseenter', onToggleHover);
    toggleBtn.removeEventListener('focus', onToggleHover);
    resetZoomBtn?.removeEventListener('click', onResetZoomClick);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', onTouchEnd);
    canvas.removeEventListener('touchcancel', onTouchEnd);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUpOrCancel);
    canvas.removeEventListener('pointercancel', onPointerUpOrCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('music:stop-other-audio', onStopOtherAudio);
    window.removeEventListener('music:view-mode-change', onViewModeChange);
  };
}
