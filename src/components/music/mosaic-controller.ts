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
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  // Tooltip DOM sub-elements
  const ttCover = tooltip.querySelector<HTMLImageElement>('[data-tt-cover]');
  const ttTitle = tooltip.querySelector<HTMLElement>('[data-tt-title]');
  const ttArtist = tooltip.querySelector<HTMLElement>('[data-tt-artist]');
  const ttStats = tooltip.querySelector<HTMLElement>('[data-tt-stats]');
  const ttRing = tooltip.querySelector<SVGGeometryElement>('[data-tt-ring]');

  // State
  let isActive = false;
  let atlasImg: HTMLImageElement | null = null;
  let atlasLoaded = false;
  const rawCoverCache = new Map<number, HTMLImageElement>();
  const previewUrlCache = new Map<number, string | null>();

  // Viewport & Transform state
  let cssSize = 0;
  let dpr = 1;
  let scale = 1;
  let panX = 0;
  let panY = 0;

  // Entrance / Zoom animation state
  let rafId: number | null = null;
  let revealStartMs = 0;
  const REVEAL_DURATION_MS = 680;
  let isRevealing = false;
  const tileRevealDelays = new Float32Array(gridSize * gridSize);

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
    const alb = albums[albumIdx];
    if (!alb?.image) return null;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = getThumbUrl(alb.image);
    img.onload = () => {
      if (isActive && (hoveredCellIdx !== -1 || activeCellIdx !== -1)) {
        scheduleRender();
      }
    };
    rawCoverCache.set(albumIdx, img);
    return null;
  }

  function clampPan(nextPanX: number, nextPanY: number, nextScale: number) {
    if (nextScale <= 1.001) {
      panX = 0;
      panY = 0;
      return;
    }
    const minPan = cssSize * (1 - nextScale);
    panX = Math.min(0, Math.max(minPan, nextPanX));
    panY = Math.min(0, Math.max(minPan, nextPanY));
  }

  function updateResetZoomButton() {
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
    const nextSize = Math.max(
      280,
      viewport.clientWidth || Math.floor(rect.width)
    );
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5);

    if (nextSize !== cssSize || nextDpr !== dpr) {
      const ratio = cssSize > 0 ? nextSize / cssSize : 1;
      cssSize = nextSize;
      dpr = nextDpr;
      canvas.width = Math.round(cssSize * dpr);
      canvas.height = Math.round(cssSize * dpr);
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssSize}px`;
      clampPan(panX * ratio, panY * ratio, scale);
    }
  }

  function renderFrame(now: number = performance.now()) {
    rafId = null;
    if (!isActive || !ctx || !canvas) return;

    measureCanvas();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    if (!atlasLoaded || !atlasImg) {
      // Subtle skeleton shimmer while atlas finishes decoding
      ctx.fillStyle = 'rgba(128, 128, 136, 0.08)';
      ctx.fillRect(0, 0, cssSize, cssSize);
      ctx.restore();
      return;
    }

    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const cellCss = cssSize / gridSize;
    const elapsed = now - revealStartMs;

    if (isRevealing && elapsed < REVEAL_DURATION_MS) {
      const overallProgress = Math.max(
        0,
        Math.min(1, elapsed / REVEAL_DURATION_MS)
      );

      for (let r = 0; r < gridSize; r++) {
        const rowOffset = r * gridSize;
        for (let c = 0; c < gridSize; c++) {
          const delay = tileRevealDelays[rowOffset + c];
          const localT = Math.max(
            0,
            Math.min(1, (overallProgress - delay) / 0.38)
          );
          if (localT <= 0) continue;

          // Snappy cubic ease-out pop-in
          const eased = 1 - Math.pow(1 - localT, 3);
          const tileScale = 0.2 + 0.8 * eased;
          const drawSize = cellCss * tileScale + 0.35;
          const dx = c * cellCss + (cellCss - drawSize) / 2;
          const dy = r * cellCss + (cellCss - drawSize) / 2;

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
      isRevealing = false;
      ctx.drawImage(
        atlasImg,
        0,
        0,
        gridSize * tilePixelSize,
        gridSize * tilePixelSize,
        0,
        0,
        cssSize,
        cssSize
      );

      // Highlight active audio tile if any
      if (activeCellIdx >= 0 && activeCellIdx < grid.length) {
        drawHighlightedTile(activeCellIdx, true);
      }

      // Highlight hovered tile with 100% un-tinted cover + crisp border
      if (
        hoveredCellIdx >= 0 &&
        hoveredCellIdx < grid.length &&
        hoveredCellIdx !== activeCellIdx
      ) {
        drawHighlightedTile(hoveredCellIdx, false);
      }
    }

    ctx.restore();
  }

  function drawHighlightedTile(cellIdx: number, isAudioTile: boolean) {
    if (!ctx) return;
    const r = Math.floor(cellIdx / gridSize);
    const c = cellIdx % gridSize;
    const cellCss = cssSize / gridSize;
    const x = c * cellCss;
    const y = r * cellCss;

    const albumIdx = grid[cellIdx];
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

  function scheduleRender() {
    if (rafId === null) {
      rafId = requestAnimationFrame(renderFrame);
    }
  }

  function getCellFromClientCoords(clientX: number, clientY: number): number {
    if (!canvas || cssSize <= 0) return -1;
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

    const worldX = (localX - panX) / scale;
    const worldY = (localY - panY) / scale;
    const c = Math.floor((worldX / cssSize) * gridSize);
    const r = Math.floor((worldY / cssSize) * gridSize);

    if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) return -1;
    return r * gridSize + c;
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

    const thumbUrl = getThumbUrl(alb.image);
    if (ttCover && ttCover.dataset.currentSrc !== thumbUrl) {
      ttCover.dataset.currentSrc = thumbUrl;
      ttCover.src = thumbUrl;
    }
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
    const offset = 16;

    let left = clientX - vpRect.left + offset;
    let top = clientY - vpRect.top + offset;

    if (left + ttRect.width > vpRect.width - 8) {
      left = clientX - vpRect.left - ttRect.width - offset;
    }
    if (top + ttRect.height > vpRect.height - 8) {
      top = clientY - vpRect.top - ttRect.height - offset;
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
      normalView!.hidden = true;
      mosaicStage!.hidden = false;
      scale = 1;
      panX = 0;
      panY = 0;
      hoveredCellIdx = -1;
      tooltip!.hidden = true;
      updateResetZoomButton();

      ensureAtlasLoaded();
      if (atlasLoaded) {
        randomizeRevealDelays();
        revealStartMs = performance.now();
        isRevealing = true;
      }
      scheduleRender();
    } else {
      mosaicStage!.hidden = true;
      normalView!.hidden = false;
      hoveredCellIdx = -1;
      tooltip!.hidden = true;
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

  const onWheel = (e: WheelEvent) => {
    if (!isActive || !canvas) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const nextScale = Math.min(6, Math.max(1, scale * zoomFactor));
    if (Math.abs(nextScale - scale) < 0.001) return;

    const worldX = (mouseX - panX) / scale;
    const worldY = (mouseY - panY) / scale;

    const nextPanX = mouseX - worldX * nextScale;
    const nextPanY = mouseY - worldY * nextScale;

    scale = nextScale;
    clampPan(nextPanX, nextPanY, scale);
    updateResetZoomButton();

    const cellIdx = getCellFromClientCoords(e.clientX, e.clientY);
    if (cellIdx !== hoveredCellIdx) {
      hoveredCellIdx = cellIdx;
      updateTooltipContent(cellIdx);
    }
    positionTooltip(e.clientX, e.clientY);
    scheduleRender();
  };

  function beginPinch() {
    if (!canvas || activePointers.size < 2) return;
    const pts = Array.from(activePointers.values());
    const p1 = pts[0];
    const p2 = pts[1];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist < 4) return;

    const rect = canvas.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2 - rect.left;
    const midY = (p1.y + p2.y) / 2 - rect.top;

    isPinching = true;
    dragMoved = true;
    pinchStartDist = dist;
    pinchStartScale = scale;
    pinchStartWorldX = (midX - panX) / scale;
    pinchStartWorldY = (midY - panY) / scale;

    hoveredCellIdx = -1;
    if (tooltip) tooltip.hidden = true;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!isActive || (e.pointerType === 'mouse' && e.button !== 0)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}

    if (activePointers.size === 1) {
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

    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch-to-zoom + two-finger pan
    if (activePointers.size >= 2) {
      if (!isPinching) {
        beginPinch();
      }
      const pts = Array.from(activePointers.values());
      const p1 = pts[0];
      const p2 = pts[1];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (dist >= 4 && pinchStartDist >= 4) {
        const rect = canvas.getBoundingClientRect();
        const midX = (p1.x + p2.x) / 2 - rect.left;
        const midY = (p1.y + p2.y) / 2 - rect.top;

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
      return;
    }

    if (isDragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) > (e.pointerType === 'touch' ? 6 : 4)) {
        dragMoved = true;
      }
      if (dragMoved && scale > 1.01) {
        clampPan(dragStartPanX + dx, dragStartPanY + dy, scale);
        canvas.style.cursor = 'grabbing';
        scheduleRender();
        return;
      }
    }

    if (e.pointerType === 'touch') return;

    canvas.style.cursor = scale > 1.02 ? 'grab' : 'pointer';
    const cellIdx = getCellFromClientCoords(e.clientX, e.clientY);
    if (cellIdx !== hoveredCellIdx) {
      hoveredCellIdx = cellIdx;
      updateTooltipContent(cellIdx);
      scheduleRender();
    }
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
      canvas.style.cursor = scale > 1.02 ? 'grab' : 'pointer';

      if (wasTap) {
        const cellIdx = getCellFromClientCoords(e.clientX, e.clientY);
        if (cellIdx !== -1) {
          hoveredCellIdx = cellIdx;
          updateTooltipContent(cellIdx);
          positionTooltip(e.clientX, e.clientY);
          handleTileClick(cellIdx);
        }
      }
    }
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (!isActive || e.pointerType === 'touch' || activePointers.size > 0) {
      return;
    }
    hoveredCellIdx = -1;
    if (tooltip) tooltip.hidden = true;
    scheduleRender();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length >= 2 || scale > 1.01) {
      e.preventDefault();
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
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
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
    stopMosaicAudio();
    toggleBtn.removeEventListener('click', onToggleClick);
    toggleBtn.removeEventListener('mouseenter', onToggleHover);
    toggleBtn.removeEventListener('focus', onToggleHover);
    resetZoomBtn?.removeEventListener('click', onResetZoomClick);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('touchmove', onTouchMove);
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
