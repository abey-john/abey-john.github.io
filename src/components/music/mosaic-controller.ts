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
  const previewUrlCache = new Map<number, string | null>();

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

  function getThumbUrl(url: string): string {
    if (url.includes('i.scdn.co/image/ab67616d0000b273')) {
      return url.replace('ab67616d0000b273', 'ab67616d00001e02');
    }
    return url;
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
      img.src = getThumbUrl(alb.image);
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

  function cleanMatchText(str: string): string {
    return (str || '')
      .toLowerCase()
      .replace(/\$/g, 's')
      .replace(/@/g, 'a')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function matchesArtistName(
    itemArtist: string,
    targetArtist: string
  ): boolean {
    const ia = cleanMatchText(itemArtist);
    const primaryTarget = cleanMatchText(targetArtist.split(',')[0]);
    const fullTarget = cleanMatchText(targetArtist);
    if (!ia || !primaryTarget) return false;
    return (
      ia.includes(primaryTarget) ||
      primaryTarget.includes(ia) ||
      ia.includes(fullTarget)
    );
  }

  function matchesAlbumTitle(itemAlbum: string, targetAlbum: string): boolean {
    const ia = cleanMatchText(itemAlbum);
    const ta = cleanMatchText(targetAlbum);
    if (!ia || !ta) return false;
    if (ia.includes(ta) || ta.includes(ia)) return true;
    const baseTarget = cleanMatchText(targetAlbum.split(/[:(\[-]/)[0]);
    const baseItem = cleanMatchText(itemAlbum.split(/[:(\[-]/)[0]);
    if (
      baseTarget.length >= 3 &&
      baseItem.length >= 3 &&
      (baseItem.includes(baseTarget) || baseTarget.includes(baseItem))
    ) {
      return true;
    }
    return false;
  }

  function getBaseTitle(str: string): string {
    return (str || '')
      .replace(
        /\s*[-–—(\[]\s*(feat\.?|ft\.?|with\s|remaster|deluxe|bonus|explicit|clean|version|edition|stereo|mono)[^)\]]*[)\]]?/gi,
        ''
      )
      .split(/[:(\[\-–—]/)[0]
      .trim();
  }

  function getAlternatePenalty(
    trackName: string,
    collectionName: string,
    artistName: string,
    allowedContext: string
  ): number {
    const trk = (trackName || '').toLowerCase();
    const col = (collectionName || '').toLowerCase();
    const art = (artistName || '').toLowerCase();
    const ctx = (allowedContext || '').toLowerCase();

    let penalty = 0;

    // Heavy penalty for tribute / karaoke / lullaby / cover bands
    if (
      /\b(tribute|lullaby|karaoke|8-bit|music box|piano guys|vitamin string)\b/.test(
        `${trk} ${col} ${art}`
      )
    ) {
      penalty += 220;
    }

    // Penalize remixes, DJ mixes, sped-up/slowed, instrumentals, commentary unless expected by the album/track context
    const remixChecks: Array<[RegExp, number]> = [
      [/\b(remix|remixes|re-mix|megamix|club mix|vip mix|dub mix)\b/, 130],
      [/\b(sped up|slowed|chopped|screwed|nightcore)\b/, 130],
      [/\b(instrumental|acapella|a cappella|karaoke|commentary)\b/, 120],
      [/\b(live|concert|unplugged|mtv unplugged)\b/, 90],
      [
        /\b(acoustic|stripped|demo|voice memo|session|sessions|rehearsal)\b/,
        85
      ],
      [/\b(radio edit|short edit|intro|outro|skit|interlude)\b/, 45]
    ];

    for (const [regex, weight] of remixChecks) {
      if ((regex.test(trk) || regex.test(col)) && !regex.test(ctx)) {
        penalty += weight;
      }
    }

    // Penalize singles / EPs / greatest hits compilations when matching a studio album
    if (
      (/\b(single|ep)\b/.test(col) || col.includes(' - single')) &&
      !/\b(single|ep)\b/.test(ctx)
    ) {
      penalty += 35;
    }
    if (
      /\b(greatest hits|best of|essential|anthology)\b/.test(col) &&
      !/\b(greatest hits|best of|essential|anthology)\b/.test(ctx)
    ) {
      penalty += 30;
    }

    return penalty;
  }

  async function resolveAlbumPreview(
    alb: MosaicAlbum,
    albumIdx: number,
    signal: AbortSignal
  ): Promise<string | null> {
    if (previewUrlCache.has(albumIdx)) {
      return previewUrlCache.get(albumIdx) ?? null;
    }

    const primaryArtist = alb.artist.split(',')[0].trim();
    const baseAlbumTitle = getBaseTitle(alb.title) || alb.title;
    let preferredTrackName = '';

    // 1. Query stats.fm for the user's #1 most-streamed studio track on this exact album
    if (alb.id) {
      try {
        const [userTracksRes, albumTracksRes] = await Promise.all([
          fetch(
            `https://api.stats.fm/api/v1/users/itseebo/top/albums/${alb.id}/tracks`,
            { signal }
          ).catch(() => null),
          fetch(`https://api.stats.fm/api/v1/albums/${alb.id}/tracks`, {
            signal
          }).catch(() => null)
        ]);

        if (userTracksRes?.ok) {
          const userData = await userTracksRes.json();
          const userItems = Array.isArray(userData.items) ? userData.items : [];
          if (userItems.length > 0) {
            // Prefer the user's highest-streamed non-remix/non-alternate track
            const bestUserItem =
              userItems.find(
                (item: any) =>
                  item?.track?.name &&
                  getAlternatePenalty(
                    item.track.name,
                    alb.title,
                    alb.artist,
                    alb.title
                  ) === 0
              ) || userItems[0];

            preferredTrackName = bestUserItem?.track?.name || '';

            // Only use a direct stats.fm preview URL if it is on one of the user's top 2 tracks
            // AND that track has zero remix/live/acoustic penalty (otherwise look up the studio track on iTunes)
            for (const item of userItems.slice(0, 2)) {
              const tName = item?.track?.name || '';
              const directUrl =
                item?.track?.appleMusicPreview || item?.track?.spotifyPreview;
              if (
                directUrl &&
                getAlternatePenalty(tName, alb.title, alb.artist, alb.title) ===
                  0
              ) {
                previewUrlCache.set(albumIdx, directUrl);
                return directUrl;
              }
            }
          }
        }

        if (!preferredTrackName && albumTracksRes?.ok) {
          const albData = await albumTracksRes.json();
          const albTracks = Array.isArray(albData.items) ? albData.items : [];
          if (albTracks.length > 0) {
            const bestAlbTrack =
              albTracks.find(
                (trk: any) =>
                  trk?.name &&
                  getAlternatePenalty(
                    trk.name,
                    alb.title,
                    alb.artist,
                    alb.title
                  ) === 0
              ) || albTracks[0];
            preferredTrackName = bestAlbTrack?.name || '';
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
      }
    }

    const allowedContext = `${alb.title} ${preferredTrackName}`;
    const cleanPrefFull = cleanMatchText(preferredTrackName);
    const cleanPrefBase = cleanMatchText(getBaseTitle(preferredTrackName));
    const cleanAlbumBase = cleanMatchText(baseAlbumTitle);

    const scoreCandidateTrack = (
      trackName: string,
      collectionName: string,
      artistName: string
    ): number => {
      const cTrkFull = cleanMatchText(trackName);
      const cTrkBase = cleanMatchText(getBaseTitle(trackName));
      let score = 0;

      if (cleanPrefFull && cTrkFull === cleanPrefFull) {
        score += 140;
      } else if (cleanPrefBase && cTrkBase === cleanPrefBase) {
        score += 110;
      } else if (
        cleanPrefBase &&
        cleanPrefBase.length >= 3 &&
        (cTrkBase.includes(cleanPrefBase) || cleanPrefBase.includes(cTrkBase))
      ) {
        score += 65;
      } else if (cleanAlbumBase && cTrkBase === cleanAlbumBase) {
        score += 35;
      } else {
        score += 10;
      }

      score -= getAlternatePenalty(
        trackName,
        collectionName,
        artistName,
        allowedContext
      );
      return score;
    };

    // 2. Album-First iTunes Lookup: Find the verified studio album collectionId, then score its tracks
    try {
      const albumQueries = [
        `${alb.title} ${primaryArtist}`,
        ...(baseAlbumTitle !== alb.title
          ? [`${baseAlbumTitle} ${primaryArtist}`]
          : [])
      ];

      for (const q of albumQueries) {
        const albRes = await fetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`,
          { signal }
        );
        if (!albRes.ok) continue;
        const albJson = await albRes.json();
        const matchingCollections = (albJson.results || []).filter(
          (c: any) =>
            c.collectionId &&
            matchesArtistName(c.artistName, alb.artist) &&
            matchesAlbumTitle(c.collectionName, alb.title)
        );

        // Sort standard studio albums ahead of Remix / Live / Single / Tribute editions
        matchingCollections.sort(
          (a: any, b: any) =>
            getAlternatePenalty('', a.collectionName, a.artistName, alb.title) -
            getAlternatePenalty('', b.collectionName, b.artistName, alb.title)
        );

        for (const col of matchingCollections.slice(0, 3)) {
          const lookupRes = await fetch(
            `https://itunes.apple.com/lookup?id=${col.collectionId}&entity=song`,
            { signal }
          );
          if (!lookupRes.ok) continue;
          const lookupJson = await lookupRes.json();
          const tracks = (lookupJson.results || []).filter(
            (t: any) => t.wrapperType === 'track' && t.previewUrl
          );
          if (tracks.length > 0) {
            const scoredTracks = tracks
              .map((t: any) => ({
                track: t,
                score: scoreCandidateTrack(
                  t.trackName,
                  col.collectionName || alb.title,
                  t.artistName || alb.artist
                )
              }))
              .sort((a: any, b: any) => b.score - a.score);

            const best = scoredTracks[0];
            if (best && best.score > 0 && best.track?.previewUrl) {
              previewUrlCache.set(albumIdx, best.track.previewUrl);
              return best.track.previewUrl;
            }
          }
        }
      }

      // 3. Fallback: Scoped song search with strict album & anti-remix scoring
      const cleanPrefTrack = getBaseTitle(preferredTrackName);
      const songQueries = [
        ...(cleanPrefTrack
          ? [
              `${cleanPrefTrack} ${primaryArtist} ${baseAlbumTitle}`,
              `${cleanPrefTrack} ${primaryArtist}`
            ]
          : []),
        `${baseAlbumTitle} ${primaryArtist}`
      ];

      for (const sq of songQueries) {
        const songRes = await fetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(sq)}&entity=song&limit=20`,
          { signal }
        );
        if (!songRes.ok) continue;
        const songJson = await songRes.json();
        const candidates = (songJson.results || []).filter(
          (s: any) =>
            s.previewUrl && matchesArtistName(s.artistName, alb.artist)
        );

        const scoredSongs = candidates
          .map((s: any) => {
            let score = scoreCandidateTrack(
              s.trackName || '',
              s.collectionName || '',
              s.artistName || ''
            );
            if (matchesAlbumTitle(s.collectionName || '', alb.title)) {
              score += 90;
            }
            return { song: s, score };
          })
          .sort((a: any, b: any) => b.score - a.score);

        if (scoredSongs.length > 0 && scoredSongs[0].score > 25) {
          const url = scoredSongs[0].song.previewUrl;
          previewUrlCache.set(albumIdx, url);
          return url;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
    }

    previewUrlCache.set(albumIdx, null);
    return null;
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
      const previewUrl = await resolveAlbumPreview(alb, albumIdx, signal);
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

  function setMosaicActive(nextActive: boolean) {
    if (isActive === nextActive) return;
    isActive = nextActive;

    toggleBtn!.classList.toggle('is-active', isActive);
    toggleBtn!.setAttribute('aria-pressed', isActive ? 'true' : 'false');

    // Stop any playing audio on view switch
    stopMosaicAudio();
    window.dispatchEvent(
      new CustomEvent('music:stop-other-audio', {
        detail: { source: 'music-mosaic' }
      })
    );

    activePointers.clear();
    isDragging = false;
    isPinching = false;

    if (isActive) {
      isExiting = false;
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      normalView!.classList.remove('is-fading-in');
      normalView!.classList.add('is-fading-out');

      transitionTimer = window.setTimeout(() => {
        transitionTimer = null;
        if (!isActive) return;
        normalView!.hidden = true;
        normalView!.classList.remove('is-fading-out');
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
      }, CONTENT_FADE_MS);
    } else {
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      normalView!.classList.remove('is-fading-out', 'is-fading-in');
      scale = 1;
      panX = 0;
      panY = 0;
      hoveredCellIdx = -1;
      isPointerInside = false;
      tooltip!.hidden = true;
      if (loupeCanvas) loupeCanvas.hidden = true;
      updateResetZoomButton();

      if (atlasLoaded && atlasImg) {
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
  }

  // Event Listeners
  const onToggleClick = () => {
    setMosaicActive(!isActive);
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
        setMosaicActive(false);
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

  return () => {
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
  };
}
