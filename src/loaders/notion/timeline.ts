import fs from 'node:fs';
import path from 'node:path';
import { processInBatches } from './music-previews';

export interface TimelineAlbumTile {
  id?: number;
  title: string;
  artist: string;
  primaryArtist: string;
  artistKeys: string[];
  albumKey: string;
  image: string;
  rank: number;
  streams: number;
  col: number;
  row: number;
  span: 1 | 2 | 3;
}

export interface TimelineYearData {
  year: number;
  isCurrentYear: boolean;
  totalStreams: number;
  totalMinutes: number;
  totalHours: number;
  uniqueAlbums: number;
  volumeRatio: number;
  topGenres: string[];
  cols: number;
  rows: number;
  tiles: TimelineAlbumTile[];
  eraNote?: string;
}

export interface TimelineBuildData {
  username: string;
  years: TimelineYearData[];
  maxHours: number;
  totalYears: number;
}

interface RawAlbumEntry {
  id?: number;
  title: string;
  artist: string;
  primaryArtist: string;
  artistKeys: string[];
  albumKey: string;
  image: string;
  rank: number;
  streams: number;
}

interface YearCachedRecord {
  empty?: boolean;
  year: number;
  totalStreams: number;
  totalMinutes: number;
  totalHours: number;
  uniqueAlbums: number;
  topGenres: string[];
  albums: RawAlbumEntry[];
}

const START_YEAR = 2012;
const CACHE_PREFIX = 'v1';

function normalizeKey(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getTimelineCoverUrl(url: string): string {
  // Spotify CDN supports 300x300 medium thumbnails via ab67616d00001e02
  if (url.includes('i.scdn.co/image/ab67616d0000b273')) {
    return url.replace('ab67616d0000b273', 'ab67616d00001e02');
  }
  return url;
}

function stripEditionSuffix(title: string): string {
  return title
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
}

function cleanAlbumsForYear(rawItems: any[]): RawAlbumEntry[] {
  const seenImages = new Set<string>();
  const seenKeys = new Set<string>();
  const albums: RawAlbumEntry[] = [];

  for (const item of rawItems) {
    const rawImage = item?.album?.image;
    const title = (item?.album?.name || '').trim();
    const artistsArr: string[] = Array.isArray(item?.album?.artists)
      ? item.album.artists
          .map((a: any) => (a?.name || '').trim())
          .filter(Boolean)
      : [];

    if (!rawImage || !title || !rawImage.startsWith('http')) continue;
    if (artistsArr.length === 0) continue;

    const artist = artistsArr.join(', ');
    if (artist.toLowerCase().includes('various artists')) continue;

    const primaryArtist = artistsArr[0];
    const artistKeys = Array.from(
      new Set(artistsArr.map(normalizeKey).filter(Boolean))
    );
    const primaryArtistKey = artistKeys[0] || normalizeKey(primaryArtist);
    const baseTitleKey =
      normalizeKey(stripEditionSuffix(title)) || normalizeKey(title);
    const albumKey = `${baseTitleKey}:::${primaryArtistKey}`;
    const image = getTimelineCoverUrl(rawImage);

    if (
      seenImages.has(image) ||
      seenImages.has(rawImage) ||
      seenKeys.has(albumKey)
    ) {
      continue;
    }

    seenImages.add(image);
    seenImages.add(rawImage);
    seenKeys.add(albumKey);

    const albumId =
      typeof item?.album?.id === 'number' ? item.album.id : undefined;

    albums.push({
      id: albumId,
      title,
      artist,
      primaryArtist,
      artistKeys,
      albumKey,
      image,
      rank: albums.length + 1,
      streams: Number(item?.streams) || 0
    });
  }

  return albums;
}

function cleanTopGenres(rawItems: any[]): string[] {
  const seen = new Set<string>();
  const genres: string[] = [];

  for (const item of rawItems) {
    const tag = (item?.genre?.tag || '').trim();
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (lower === 'music' || seen.has(lower)) continue;
    seen.add(lower);
    genres.push(tag);
    if (genres.length >= 3) break;
  }

  return genres;
}

async function fetchYearFromStatsFm(
  username: string,
  year: number
): Promise<YearCachedRecord | null> {
  const after = Date.UTC(year, 0, 1);
  const before = Date.UTC(year + 1, 0, 1);
  const base = `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}`;

  const [albumsRes, statsRes, genresRes] = await Promise.all([
    fetch(`${base}/top/albums?after=${after}&before=${before}&limit=100`),
    fetch(`${base}/streams/stats?after=${after}&before=${before}`),
    fetch(`${base}/top/genres?after=${after}&before=${before}&limit=8`).catch(
      () => null
    )
  ]);

  if (!albumsRes.ok || !statsRes.ok) {
    return null;
  }

  const albumsJson = await albumsRes.json();
  const statsJson = await statsRes.json();
  const genresJson =
    genresRes && genresRes.ok ? await genresRes.json().catch(() => null) : null;

  const statsItem = statsJson?.items || {};
  const totalStreams = Number(statsItem?.count) || 0;
  const totalMinutes = Math.round((Number(statsItem?.durationMs) || 0) / 60000);
  const totalHours = Math.round(totalMinutes / 60);
  const rawAlbums = Array.isArray(albumsJson?.items) ? albumsJson.items : [];
  const albums = cleanAlbumsForYear(rawAlbums);
  const uniqueAlbums =
    Number(statsItem?.cardinality?.albums) || albums.length || 0;

  if (totalStreams < 50 || albums.length === 0) {
    return {
      empty: true,
      year,
      totalStreams,
      totalMinutes,
      totalHours,
      uniqueAlbums,
      topGenres: [],
      albums: []
    };
  }

  const rawGenres = Array.isArray(genresJson?.items) ? genresJson.items : [];
  const topGenres = cleanTopGenres(rawGenres);

  return {
    year,
    totalStreams,
    totalMinutes,
    totalHours,
    uniqueAlbums,
    topGenres,
    albums
  };
}

function computeFeatureCounts(
  albums: RawAlbumEntry[],
  cols: number,
  rows: number,
  allowSoloHero3x3: boolean
): { hasSoloHero3x3: boolean; twoByTwoCount: number } {
  const hasSoloHero3x3 =
    allowSoloHero3x3 && rows >= 3 && cols >= 5 && albums.length >= 9;
  const totalCells = cols * rows;
  const heroArea = hasSoloHero3x3 ? 9 : 0;
  const targetFeatureArea = totalCells * 0.32;
  const maxTwoByTwos =
    rows >= 2 && cols >= 4
      ? Math.max(
          0,
          Math.min(
            Math.floor((totalCells - heroArea) / 4),
            Math.max(2, Math.floor((targetFeatureArea - heroArea) / 4))
          )
        )
      : 0;

  const twoByTwoStartIdx = hasSoloHero3x3 ? 1 : 0;
  let twoByTwoCount = 0;
  for (let i = twoByTwoStartIdx; i < albums.length; i++) {
    if (twoByTwoCount >= maxTwoByTwos) break;
    const alb = albums[i];
    const meetsRatio =
      albums[0].streams > 0 && alb.streams >= albums[0].streams * 0.22;
    const meetsMinimumFloor = twoByTwoCount < 2 && albums.length >= 6;
    if (meetsRatio || meetsMinimumFloor) {
      twoByTwoCount++;
    } else {
      break;
    }
  }

  return { hasSoloHero3x3, twoByTwoCount };
}

function packSoundwaveGrid(
  albums: RawAlbumEntry[],
  volumeRatio: number
): { cols: number; rows: number; tiles: TimelineAlbumTile[] } {
  const t = Math.sqrt(Math.max(0, Math.min(1, volumeRatio)));
  const baseCols = 2 * Math.round(4 + t * 4); // 8, 10, 12, 14, or 16
  let rows = Math.round(4 + t * 2); // 4, 5, or 6

  const top40Sum = albums
    .slice(0, 40)
    .reduce((sum, a) => sum + Math.max(0, a.streams), 0);

  let allowSoloHero3x3 =
    albums.length >= 2 &&
    rows >= 4 &&
    (albums[0].streams >= albums[1].streams * 1.28 ||
      (top40Sum > 0 && albums[0].streams / top40Sum >= 0.14));

  let cols = allowSoloHero3x3 ? baseCols + 1 : baseCols;

  const estimateNeeded = (c: number, r: number, allow3: boolean) => {
    const { hasSoloHero3x3, twoByTwoCount } = computeFeatureCounts(
      albums,
      c,
      r,
      allow3
    );
    return c * r - (hasSoloHero3x3 ? 8 : 0) - twoByTwoCount * 3;
  };

  // Shrink dimensions cleanly only if cleaned albums cannot cover all packed tiles
  while (
    estimateNeeded(cols, rows, allowSoloHero3x3) > albums.length &&
    (rows > 2 || cols > 4)
  ) {
    if (rows > 3 && (cols <= 8 || rows * 2 >= cols)) {
      rows--;
    } else if (cols > 4) {
      cols = Math.max(4, cols - 2);
    } else if (rows > 2) {
      rows--;
    } else {
      break;
    }
  }

  if (rows < 3 || cols < 5 || albums.length < 9) {
    allowSoloHero3x3 = false;
    if (cols % 2 === 1 && cols > 4) {
      cols--;
    }
  }

  while (
    estimateNeeded(cols, rows, allowSoloHero3x3) > albums.length &&
    rows > 1
  ) {
    rows--;
  }
  while (
    estimateNeeded(cols, rows, allowSoloHero3x3) > albums.length &&
    cols > 1
  ) {
    cols--;
  }

  const { hasSoloHero3x3, twoByTwoCount } = computeFeatureCounts(
    albums,
    cols,
    rows,
    allowSoloHero3x3
  );

  const occupied = Array.from({ length: rows }, () => new Uint8Array(cols));
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const tiles: TimelineAlbumTile[] = [];

  const canPlace = (r0: number, c0: number, span: number): boolean => {
    if (r0 < 0 || c0 < 0 || r0 + span > rows || c0 + span > cols) return false;
    for (let r = r0; r < r0 + span; r++) {
      for (let c = c0; c < c0 + span; c++) {
        if (occupied[r][c]) return false;
      }
    }
    return true;
  };

  const markOccupied = (r0: number, c0: number, span: number) => {
    for (let r = r0; r < r0 + span; r++) {
      for (let c = c0; c < c0 + span; c++) {
        occupied[r][c] = 1;
      }
    }
  };

  const findBestCenterOutPosition = (
    span: number,
    rank: number
  ): { r: number; c: number } | null => {
    let bestScore = Infinity;
    let bestPos: { r: number; c: number } | null = null;
    const sideSign = rank % 2 === 0 ? 1 : -1;

    for (let r = 0; r <= rows - span; r++) {
      for (let c = 0; c <= cols - span; c++) {
        if (!canPlace(r, c, span)) continue;
        const tileCx = c + (span - 1) / 2;
        const tileCy = r + (span - 1) / 2;
        const dx = tileCx - cx;
        const dy = tileCy - cy;
        const score = Math.hypot(dx * 1.15, dy * 0.9) + sideSign * dx * 0.02;
        if (score < bestScore) {
          bestScore = score;
          bestPos = { r, c };
        }
      }
    }

    return bestPos;
  };

  let albumCursor = 0;

  if (hasSoloHero3x3 && albumCursor < albums.length) {
    const pos = findBestCenterOutPosition(3, albums[albumCursor].rank);
    if (pos) {
      const alb = albums[albumCursor++];
      markOccupied(pos.r, pos.c, 3);
      tiles.push({
        ...alb,
        col: pos.c + 1,
        row: pos.r + 1,
        span: 3
      });
    }
  }

  const demotedToOneByOne: RawAlbumEntry[] = [];
  for (let k = 0; k < twoByTwoCount && albumCursor < albums.length; k++) {
    const alb = albums[albumCursor++];
    const pos = findBestCenterOutPosition(2, alb.rank);
    if (pos) {
      markOccupied(pos.r, pos.c, 2);
      tiles.push({
        ...alb,
        col: pos.c + 1,
        row: pos.r + 1,
        span: 2
      });
    } else {
      demotedToOneByOne.push(alb);
    }
  }

  // Collect all remaining empty 1x1 cells sorted center-out with alternating L/R bias
  const remainingCells: Array<{
    r: number;
    c: number;
    dist: number;
    dx: number;
  }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!occupied[r][c]) {
        const dx = c - cx;
        const dy = r - cy;
        remainingCells.push({
          r,
          c,
          dist: Math.hypot(dx * 1.15, dy * 0.9),
          dx
        });
      }
    }
  }

  remainingCells.sort((a, b) => {
    const diff = a.dist - b.dist;
    if (Math.abs(diff) > 0.001) return diff;
    return Math.abs(a.dx) - Math.abs(b.dx) || a.c - b.c || a.r - b.r;
  });

  const oneByOneQueue = [...demotedToOneByOne, ...albums.slice(albumCursor)];

  // Reorder remaining cells into balanced L/R pairs at matching distance bands
  // so consecutive ranks fill symmetrically outward from the center spine.
  const orderedCells: Array<{ r: number; c: number }> = [];
  const usedCell = new Uint8Array(remainingCells.length);

  for (let i = 0; i < remainingCells.length; i++) {
    if (usedCell[i]) continue;
    const base = remainingCells[i];
    usedCell[i] = 1;
    orderedCells.push({ r: base.r, c: base.c });

    // Look ahead slightly for the opposite-side mirror cell at comparable distance
    if (Math.abs(base.dx) > 0.25) {
      let mirrorIdx = -1;
      for (let j = i + 1; j < Math.min(remainingCells.length, i + 8); j++) {
        if (usedCell[j]) continue;
        const cand = remainingCells[j];
        if (
          cand.dx * base.dx < 0 &&
          Math.abs(cand.dist - base.dist) < 0.85 &&
          cand.r === base.r
        ) {
          mirrorIdx = j;
          break;
        }
      }
      if (mirrorIdx !== -1) {
        usedCell[mirrorIdx] = 1;
        orderedCells.push({
          r: remainingCells[mirrorIdx].r,
          c: remainingCells[mirrorIdx].c
        });
      }
    }
  }

  for (let i = 0; i < orderedCells.length && i < oneByOneQueue.length; i++) {
    const cell = orderedCells[i];
    const alb = oneByOneQueue[i];
    markOccupied(cell.r, cell.c, 1);
    tiles.push({
      ...alb,
      col: cell.c + 1,
      row: cell.r + 1,
      span: 1
    });
  }

  // Keep tiles sorted in rank order for clean DOM/accessibility tab order
  tiles.sort((a, b) => a.rank - b.rank);

  return { cols, rows, tiles };
}

export async function buildMusicTimeline(
  username = 'itseebo',
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<TimelineBuildData | undefined> {
  try {
    const currentYear = new Date().getUTCFullYear();
    const candidateYears: number[] = [];
    for (let y = START_YEAR; y <= currentYear; y++) {
      candidateYears.push(y);
    }

    const cacheDir = path.resolve('node_modules/.cache/timeline');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const loadedRecords: YearCachedRecord[] = [];

    await processInBatches(candidateYears, 4, async (year) => {
      const cachePath = path.join(
        cacheDir,
        `${CACHE_PREFIX}-${username}-year-${year}.json`
      );
      const isCurrentYear = year === currentYear;

      let diskRecord: YearCachedRecord | null = null;
      if (fs.existsSync(cachePath)) {
        try {
          diskRecord = JSON.parse(
            fs.readFileSync(cachePath, 'utf8')
          ) as YearCachedRecord;
        } catch {
          diskRecord = null;
        }
      }

      // Past years are immutable history: reuse cached JSON without hitting the network
      if (!isCurrentYear && diskRecord) {
        if (!diskRecord.empty && diskRecord.albums?.length > 0) {
          loadedRecords.push(diskRecord);
        }
        return;
      }

      try {
        const fresh = await fetchYearFromStatsFm(username, year);
        if (fresh) {
          try {
            fs.writeFileSync(cachePath, JSON.stringify(fresh));
          } catch {}
          if (!fresh.empty && fresh.albums.length > 0) {
            loadedRecords.push(fresh);
          }
          return;
        }
      } catch {
        // Fall through to disk fallback if available
      }

      if (diskRecord && !diskRecord.empty && diskRecord.albums?.length > 0) {
        loadedRecords.push(diskRecord);
      }
    });

    if (loadedRecords.length === 0) {
      logger?.warn('Could not load any yearly stats.fm timeline data.');
      return undefined;
    }

    const maxHours = Math.max(
      ...loadedRecords.map((r) => r.totalHours || 0),
      1
    );

    const years: TimelineYearData[] = loadedRecords.map((rec) => {
      const volumeRatio = Math.max(
        0,
        Math.min(1, (rec.totalHours || 0) / maxHours)
      );
      const packed = packSoundwaveGrid(rec.albums, volumeRatio);
      return {
        year: rec.year,
        isCurrentYear: rec.year === currentYear,
        totalStreams: rec.totalStreams,
        totalMinutes: rec.totalMinutes,
        totalHours: rec.totalHours,
        uniqueAlbums: rec.uniqueAlbums,
        volumeRatio,
        topGenres: rec.topGenres,
        cols: packed.cols,
        rows: packed.rows,
        tiles: packed.tiles
      };
    });

    // Sort newest-first (e.g. 2026 -> 2014)
    years.sort((a, b) => b.year - a.year);

    logger?.info(
      `Loaded stats.fm soundwave timeline across ${years.length} years (${years[years.length - 1].year}–${years[0].year}).`
    );

    return {
      username,
      years,
      maxHours,
      totalYears: years.length
    };
  } catch (err: any) {
    logger?.warn(
      `Failed building stats.fm music timeline: ${err?.message || err}`
    );
    return undefined;
  }
}
