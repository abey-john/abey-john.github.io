import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { processInBatches } from './music-previews';

export interface MosaicAlbumItem {
  id?: number;
  title: string;
  artist: string;
  image: string;
  rank: number;
  streams: number;
}

export interface MosaicBuildData {
  atlasUrl: string;
  gridSize: number;
  tilePixelSize: number;
  albums: MosaicAlbumItem[];
  grid: number[];
}

interface CachedAlbumSignature {
  id?: number;
  rank: number;
  streams: number;
  title: string;
  artist: string;
  image: string;
  thumbHash: string;
  /** 4 quadrants (TL, TR, BL, BR), each [L, a, b] */
  quadLab: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
}

const GRID_SIZE = 70;
const TILE_PX = 50; // 70 * 50 = 3500x3500 high-res mosaic canvas
const MAX_ALBUM_POOL = 1100;
const MAX_USES_PER_ALBUM = 5; // 4,900 tiles / ~1,000 albums ≈ 4.9 uses max
const TILE_DC_SHIFT = 0.25; // Per-tile flat average color nudge (constant across all 50x50 pixels of a tile)
const TILE_INTERNAL_CONTRAST = 0.92; // Keep 92% of the album cover's own crisp internal artwork contrast
const TILE_SATURATION = 0.92; // Preserve vibrant original album cover colors
const CACHE_VERSION = 'v11-70x70-50px-max5-dc025';

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let sr = r / 255;
  let sg = g / 255;
  let sb = b / 255;

  sr = sr > 0.04045 ? Math.pow((sr + 0.055) / 1.055, 2.4) : sr / 12.92;
  sg = sg > 0.04045 ? Math.pow((sg + 0.055) / 1.055, 2.4) : sg / 12.92;
  sb = sb > 0.04045 ? Math.pow((sb + 0.055) / 1.055, 2.4) : sb / 12.92;

  const x = (sr * 0.4124 + sg * 0.3576 + sb * 0.1805) / 0.95047;
  const y = (sr * 0.2126 + sg * 0.7152 + sb * 0.0722) / 1.0;
  const z = (sr * 0.0193 + sg * 0.1192 + sb * 0.9505) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bVal = 200 * (fy - fz);
  return [L, a, bVal];
}

function getSpotifyThumbUrl(url: string): string {
  // Spotify CDN supports 64x64 thumbnails via ab67616d00004851 (~2.3KB vs 114KB)
  if (url.includes('i.scdn.co/image/ab67616d0000b273')) {
    return url.replace('ab67616d0000b273', 'ab67616d00004851');
  }
  return url;
}

async function fetchLifetimeTopAlbums(
  username: string
): Promise<MosaicAlbumItem[]> {
  const offsets = [0, 500, 1000, 1500];
  const responses = await Promise.all(
    offsets.map(async (offset) => {
      try {
        const res = await fetch(
          `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/top/albums?limit=500&offset=${offset}`
        );
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.items) ? data.items : [];
      } catch {
        return [];
      }
    })
  );

  const rawItems = responses.flat();
  const seenImages = new Set<string>();
  const seenKeys = new Set<string>();
  const uniqueAlbums: MosaicAlbumItem[] = [];

  for (const item of rawItems) {
    const image = item?.album?.image;
    const title = (item?.album?.name || '').trim();
    const artistsArr = Array.isArray(item?.album?.artists)
      ? item.album.artists
          .map((a: any) => (a?.name || '').trim())
          .filter(Boolean)
      : [];
    if (artistsArr.length === 0) continue;

    const artist = artistsArr.join(', ');
    if (artist.toLowerCase().includes('various artists')) continue;

    const albumId =
      typeof item?.album?.id === 'number' ? item.album.id : undefined;
    if (!image || !title || !image.startsWith('http')) continue;

    // Normalize title to deduplicate Deluxe / Remastered editions with same base album
    const normTitle = title
      .toLowerCase()
      .replace(
        /\s*\((deluxe|remaster|expanded|bonus|edition|special)[^)]*\)/gi,
        ''
      )
      .trim();
    const key = `${normTitle}:::${artist.toLowerCase()}`;

    if (seenImages.has(image) || seenKeys.has(key)) continue;
    seenImages.add(image);
    seenKeys.add(key);

    uniqueAlbums.push({
      id: albumId,
      rank: Number(item.position) || uniqueAlbums.length + 1,
      streams: Number(item.streams) || 0,
      title,
      artist,
      image
    });

    if (uniqueAlbums.length >= MAX_ALBUM_POOL) break;
  }

  return uniqueAlbums;
}

export async function buildAlbumMosaic(
  portraitPublicPath: string | undefined,
  username = 'itseebo',
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<MosaicBuildData | undefined> {
  try {
    // 1. Resolve local portrait file path (with fallback to existing about portrait)
    let resolvedPortraitPath = '';
    if (portraitPublicPath) {
      const candidate = path.resolve(
        'public',
        portraitPublicPath.replace(/^\//, '')
      );
      if (fs.existsSync(candidate)) {
        resolvedPortraitPath = candidate;
      }
    }

    if (!resolvedPortraitPath) {
      const fallbackDir = path.resolve('public/assets/notion');
      if (fs.existsSync(fallbackDir)) {
        const files = fs
          .readdirSync(fallbackDir)
          .filter(
            (f) =>
              f.endsWith('.webp') &&
              !f.includes('-432') &&
              !f.startsWith('music-mosaic')
          );
        if (files.length > 0) {
          resolvedPortraitPath = path.join(fallbackDir, files[0]);
        }
      }
    }

    if (!resolvedPortraitPath || !fs.existsSync(resolvedPortraitPath)) {
      logger?.warn(
        'Mosaic portrait image not found locally; skipping mosaic generation.'
      );
      return undefined;
    }

    const portraitBytes = fs.readFileSync(resolvedPortraitPath);
    const portraitHash = crypto
      .createHash('md5')
      .update(portraitBytes)
      .update(CACHE_VERSION)
      .digest('hex')
      .slice(0, 12);

    const cacheDir = path.resolve('node_modules/.cache/mosaic');
    const thumbsDir = path.join(cacheDir, 'thumbs');
    if (!fs.existsSync(thumbsDir)) {
      fs.mkdirSync(thumbsDir, { recursive: true });
    }

    const publicNotionDir = path.resolve('public/assets/notion');
    const srcNotionDir = path.resolve('src/assets/notion');
    if (!fs.existsSync(publicNotionDir))
      fs.mkdirSync(publicNotionDir, { recursive: true });
    if (!fs.existsSync(srcNotionDir))
      fs.mkdirSync(srcNotionDir, { recursive: true });

    const atlasFilename = `music-mosaic-${portraitHash}.webp`;
    const publicAtlasPath = path.join(publicNotionDir, atlasFilename);
    const srcAtlasPath = path.join(srcNotionDir, atlasFilename);
    const buildCachePath = path.join(
      cacheDir,
      `mosaic-build-${portraitHash}.json`
    );

    // 2. Return cached build immediately if portrait + version haven't changed
    if (
      fs.existsSync(buildCachePath) &&
      fs.existsSync(publicAtlasPath) &&
      fs.existsSync(srcAtlasPath)
    ) {
      try {
        const cachedData = JSON.parse(
          fs.readFileSync(buildCachePath, 'utf8')
        ) as MosaicBuildData;
        if (
          cachedData &&
          cachedData.grid?.length === GRID_SIZE * GRID_SIZE &&
          cachedData.albums?.length > 0
        ) {
          logger?.info(
            `Loaded cached ${GRID_SIZE}x${GRID_SIZE} stats.fm album mosaic (${cachedData.albums.length} unique albums).`
          );
          return cachedData;
        }
      } catch {
        // Recompute on corrupt cache
      }
    }

    // 3. Load or fetch top 1,000 lifetime albums & their 2x2 LAB color signatures
    const sigCachePath = path.join(cacheDir, `albums-sig-${username}.json`);
    let sigMap: Record<string, CachedAlbumSignature> = {};
    if (fs.existsSync(sigCachePath)) {
      try {
        sigMap = JSON.parse(fs.readFileSync(sigCachePath, 'utf8'));
      } catch {
        sigMap = {};
      }
    }

    const topAlbums = await fetchLifetimeTopAlbums(username);
    if (topAlbums.length === 0) {
      logger?.warn(
        'Could not fetch lifetime top albums from stats.fm for mosaic.'
      );
      return undefined;
    }

    const validAlbums: CachedAlbumSignature[] = [];

    await processInBatches(topAlbums, 25, async (alb) => {
      const thumbHash = crypto
        .createHash('md5')
        .update(alb.image)
        .digest('hex')
        .slice(0, 14);
      const rawThumbPath = path.join(thumbsDir, `${thumbHash}-${TILE_PX}.raw`);

      const existingSig = sigMap[alb.image];
      if (existingSig && fs.existsSync(rawThumbPath)) {
        validAlbums.push({
          ...existingSig,
          id: alb.id,
          rank: alb.rank,
          streams: alb.streams,
          title: alb.title,
          artist: alb.artist
        });
        return;
      }

      try {
        const thumbUrl = getSpotifyThumbUrl(alb.image);
        let res = await fetch(thumbUrl);
        if (!res.ok && thumbUrl !== alb.image) {
          res = await fetch(alb.image);
        }
        if (!res.ok) return;

        const imgBuf = Buffer.from(await res.arrayBuffer());

        // Resize to TILE_PX x TILE_PX raw RGB for atlas composition
        const tileRaw = await sharp(imgBuf)
          .resize(TILE_PX, TILE_PX, { fit: 'cover' })
          .removeAlpha()
          .raw()
          .toBuffer();

        fs.writeFileSync(rawThumbPath, tileRaw);

        // Compute 2x2 quadrant average colors by resizing to 2x2 raw RGB
        const quadRaw = await sharp(imgBuf)
          .resize(2, 2, { fit: 'cover' })
          .removeAlpha()
          .raw()
          .toBuffer();

        const quadLab: CachedAlbumSignature['quadLab'] = [
          rgbToLab(quadRaw[0], quadRaw[1], quadRaw[2]),
          rgbToLab(quadRaw[3], quadRaw[4], quadRaw[5]),
          rgbToLab(quadRaw[6], quadRaw[7], quadRaw[8]),
          rgbToLab(quadRaw[9], quadRaw[10], quadRaw[11])
        ];

        const entry: CachedAlbumSignature = {
          id: alb.id,
          rank: alb.rank,
          streams: alb.streams,
          title: alb.title,
          artist: alb.artist,
          image: alb.image,
          thumbHash,
          quadLab
        };
        sigMap[alb.image] = entry;
        validAlbums.push(entry);
      } catch {
        // Skip failed cover download
      }
    });

    // Keep deterministic rank order
    validAlbums.sort((a, b) => a.rank - b.rank);

    try {
      fs.writeFileSync(sigCachePath, JSON.stringify(sigMap));
    } catch {}

    if (validAlbums.length < 50) {
      logger?.warn('Insufficient album covers downloaded for mosaic.');
      return undefined;
    }

    // 4. Analyze source portrait on a 120x120 grid (2x2 quadrants per 60x60 cell)
    const subGridSize = GRID_SIZE * 2; // 120x120
    const portraitSubRaw = await sharp(portraitBytes)
      .rotate()
      .resize(subGridSize, subGridSize, { fit: 'cover', position: 'centre' })
      .removeAlpha()
      .raw()
      .toBuffer();

    const targetCellsLab: Array<CachedAlbumSignature['quadLab']> = new Array(
      GRID_SIZE * GRID_SIZE
    );
    const cellPriority: Array<{ idx: number; priority: number }> = [];

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cellIdx = r * GRID_SIZE + c;
        const sr = r * 2;
        const sc = c * 2;

        // Match directly against the true colors and luminance of the original portrait
        const getSubLab = (
          dr: number,
          dc: number
        ): [number, number, number] => {
          const offset = ((sr + dr) * subGridSize + (sc + dc)) * 3;
          return rgbToLab(
            portraitSubRaw[offset],
            portraitSubRaw[offset + 1],
            portraitSubRaw[offset + 2]
          );
        };

        const q0 = getSubLab(0, 0);
        const q1 = getSubLab(0, 1);
        const q2 = getSubLab(1, 0);
        const q3 = getSubLab(1, 1);
        targetCellsLab[cellIdx] = [q0, q1, q2, q3];

        // Prioritize facial region (centered around upper-middle) + high internal contrast edges
        const distFromFace = Math.hypot(
          (r - GRID_SIZE * 0.36) / (GRID_SIZE * 0.3),
          (c - GRID_SIZE * 0.5) / (GRID_SIZE * 0.3)
        );
        const faceWeight = Math.max(0, 2.5 - distFromFace) * 40;
        const internalContrast =
          Math.abs(q0[0] - q3[0]) + Math.abs(q1[0] - q2[0]);
        cellPriority.push({
          idx: cellIdx,
          priority: faceWeight + internalContrast
        });
      }
    }

    // Solve highest-priority cells (face, sunglasses, smile, silhouette edges) first
    cellPriority.sort((a, b) => b.priority - a.priority);

    // 5. Solve 60x60 grid with max uses = 7, minimum Euclidean distance spacing, and excess-saturation penalty
    const assignedPoolIdx = new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1);
    const placedPositions: Array<Array<[number, number]>> = Array.from(
      { length: validAlbums.length },
      () => []
    );

    const minDistancesSq = [196, 121, 64, 25, 0]; // Prefer 14+, 11+, 8+, 5+ tiles spacing between repeats

    for (const { idx: cellIdx } of cellPriority) {
      const r = Math.floor(cellIdx / GRID_SIZE);
      const c = cellIdx % GRID_SIZE;
      const tQuad = targetCellsLab[cellIdx];

      let chosenAlbumIdx = -1;

      for (const minDistSq of minDistancesSq) {
        let bestScore = Infinity;
        let bestIdx = -1;

        for (let aIdx = 0; aIdx < validAlbums.length; aIdx++) {
          const coords = placedPositions[aIdx];
          if (coords.length >= MAX_USES_PER_ALBUM) continue;

          // Check minimum spacing against already placed instances of this album
          let tooClose = false;
          for (let k = 0; k < coords.length; k++) {
            const dr = r - coords[k][0];
            const dc = c - coords[k][1];
            if (dr * dr + dc * dc < minDistSq) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) continue;

          const aQuad = validAlbums[aIdx].quadLab;
          let colorDist = 0;
          for (let q = 0; q < 4; q++) {
            const dL = (tQuad[q][0] - aQuad[q][0]) * 1.25;
            const da = tQuad[q][1] - aQuad[q][1];
            const db = tQuad[q][2] - aQuad[q][2];

            // Symmetric chroma difference + prevent red/magenta overshoots on skin tones and white fabric
            const tChroma = Math.hypot(tQuad[q][1], tQuad[q][2]);
            const aChroma = Math.hypot(aQuad[q][1], aQuad[q][2]);
            const dChroma = aChroma - tChroma;
            const redOvershoot = Math.max(0, aQuad[q][1] - tQuad[q][1] - 4);

            colorDist +=
              dL * dL +
              da * da * 1.35 +
              db * db * 1.2 +
              dChroma * dChroma * 0.55 +
              redOvershoot * redOvershoot * 2.4;
          }

          // Diversity penalty encourages using more of the 1,000-album pool before repeating a cover
          const rankPenalty = (aIdx / validAlbums.length) * 12;
          const score = colorDist + coords.length * 65 + rankPenalty;
          if (score < bestScore) {
            bestScore = score;
            bestIdx = aIdx;
          }
        }

        if (bestIdx !== -1) {
          chosenAlbumIdx = bestIdx;
          break;
        }
      }

      if (chosenAlbumIdx === -1) {
        // Fallback only if pool size * MAX_USES_PER_ALBUM < 3600
        let LeastUsedIdx = 0;
        for (let aIdx = 1; aIdx < validAlbums.length; aIdx++) {
          if (
            placedPositions[aIdx].length < placedPositions[LeastUsedIdx].length
          ) {
            LeastUsedIdx = aIdx;
          }
        }
        chosenAlbumIdx = LeastUsedIdx;
      }

      assignedPoolIdx[cellIdx] = chosenAlbumIdx;
      placedPositions[chosenAlbumIdx].push([r, c]);
    }

    // 6. Composite the 3000x3000 high-res mosaic image using ONLY per-tile flat DC color shifts
    // (Never overlay the 3000x3000 portrait; each 50x50 square is 100% an intact album cover)
    const fullSizePx = GRID_SIZE * TILE_PX; // 3000
    const portraitCellRaw = await sharp(portraitBytes)
      .rotate()
      .resize(GRID_SIZE, GRID_SIZE, { fit: 'cover', position: 'centre' })
      .removeAlpha()
      .raw()
      .toBuffer();

    const mosaicRaw = Buffer.alloc(fullSizePx * fullSizePx * 3);
    const thumbRawBuffers = new Map<number, Buffer>();
    const thumbMeanRgb = new Map<number, [number, number, number]>();

    // Load only the raw buffers of albums that were actually selected & compute each tile's flat mean RGB
    for (let i = 0; i < assignedPoolIdx.length; i++) {
      const poolIdx = assignedPoolIdx[i];
      if (!thumbRawBuffers.has(poolIdx)) {
        const rawPath = path.join(
          thumbsDir,
          `${validAlbums[poolIdx].thumbHash}-${TILE_PX}.raw`
        );
        if (fs.existsSync(rawPath)) {
          const buf = fs.readFileSync(rawPath);
          thumbRawBuffers.set(poolIdx, buf);

          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          const pixelCount = TILE_PX * TILE_PX;
          for (let p = 0; p < buf.length; p += 3) {
            const r = buf[p];
            const g = buf[p + 1];
            const b = buf[p + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            sumR += lum + (r - lum) * TILE_SATURATION;
            sumG += lum + (g - lum) * TILE_SATURATION;
            sumB += lum + (b - lum) * TILE_SATURATION;
          }
          thumbMeanRgb.set(poolIdx, [
            sumR / pixelCount,
            sumG / pixelCount,
            sumB / pixelCount
          ]);
        }
      }
    }

    const rowStride = fullSizePx * 3;
    const tileRowBytes = TILE_PX * 3;

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cellIdx = r * GRID_SIZE + c;
        const poolIdx = assignedPoolIdx[cellIdx];
        const tileBuf = thumbRawBuffers.get(poolIdx);
        const tileMean = thumbMeanRgb.get(poolIdx);
        if (!tileBuf || !tileMean) continue;

        // Single flat target RGB for this entire 50x50 tile (zero sub-tile portrait detail)
        const cellOffset = cellIdx * 3;
        const cellR = portraitCellRaw[cellOffset];
        const cellG = portraitCellRaw[cellOffset + 1];
        const cellB = portraitCellRaw[cellOffset + 2];

        const [meanR, meanG, meanB] = tileMean;
        const targetMeanR = meanR * (1 - TILE_DC_SHIFT) + cellR * TILE_DC_SHIFT;
        const targetMeanG = meanG * (1 - TILE_DC_SHIFT) + cellG * TILE_DC_SHIFT;
        const targetMeanB = meanB * (1 - TILE_DC_SHIFT) + cellB * TILE_DC_SHIFT;

        const baseRow = r * TILE_PX;
        const baseColBytes = c * tileRowBytes;

        for (let tr = 0; tr < TILE_PX; tr++) {
          const destRowStart = (baseRow + tr) * rowStride + baseColBytes;
          const srcRowStart = tr * tileRowBytes;
          const isBottomSeam = tr === TILE_PX - 1;

          for (let tc = 0; tc < TILE_PX; tc++) {
            const srcIdx = srcRowStart + tc * 3;
            const destIdx = destRowStart + tc * 3;

            const pr = tileBuf[srcIdx];
            const pg = tileBuf[srcIdx + 1];
            const pb = tileBuf[srcIdx + 2];
            const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;

            const sr = lum + (pr - lum) * TILE_SATURATION;
            const sg = lum + (pg - lum) * TILE_SATURATION;
            const sb = lum + (pb - lum) * TILE_SATURATION;

            // Pure album artwork AC detail + per-tile flat DC color shift
            const seamFactor = isBottomSeam || tc === TILE_PX - 1 ? 0.91 : 1.0;
            const outR =
              (targetMeanR + (sr - meanR) * TILE_INTERNAL_CONTRAST) *
              seamFactor;
            const outG =
              (targetMeanG + (sg - meanG) * TILE_INTERNAL_CONTRAST) *
              seamFactor;
            const outB =
              (targetMeanB + (sb - meanB) * TILE_INTERNAL_CONTRAST) *
              seamFactor;

            mosaicRaw[destIdx] = Math.max(0, Math.min(255, Math.round(outR)));
            mosaicRaw[destIdx + 1] = Math.max(
              0,
              Math.min(255, Math.round(outG))
            );
            mosaicRaw[destIdx + 2] = Math.max(
              0,
              Math.min(255, Math.round(outB))
            );
          }
        }
      }
    }

    const webpAtlasBuffer = await sharp(mosaicRaw, {
      raw: { width: fullSizePx, height: fullSizePx, channels: 3 }
    })
      .webp({ quality: 84, effort: 4 })
      .toBuffer();

    fs.writeFileSync(publicAtlasPath, webpAtlasBuffer);
    fs.writeFileSync(srcAtlasPath, webpAtlasBuffer);

    // Clean up any stale mosaic atlas files from previous portrait photos
    for (const dir of [publicNotionDir, srcNotionDir]) {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith('music-mosaic-') && file !== atlasFilename) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch {}
        }
      }
    }

    // 7. Build compact output palette containing only the unique albums used in the 60x60 grid
    const poolToCompactIdx = new Map<number, number>();
    const compactAlbums: MosaicAlbumItem[] = [];
    const compactGrid: number[] = new Array(GRID_SIZE * GRID_SIZE);

    for (let i = 0; i < assignedPoolIdx.length; i++) {
      const poolIdx = assignedPoolIdx[i];
      let cIdx = poolToCompactIdx.get(poolIdx);
      if (cIdx === undefined) {
        cIdx = compactAlbums.length;
        poolToCompactIdx.set(poolIdx, cIdx);
        const alb = validAlbums[poolIdx];
        compactAlbums.push({
          id: alb.id,
          title: alb.title,
          artist: alb.artist,
          image: alb.image,
          rank: alb.rank,
          streams: alb.streams
        });
      }
      compactGrid[i] = cIdx;
    }

    const resultData: MosaicBuildData = {
      atlasUrl: `/assets/notion/${atlasFilename}`,
      gridSize: GRID_SIZE,
      tilePixelSize: TILE_PX,
      albums: compactAlbums,
      grid: compactGrid
    };

    try {
      fs.writeFileSync(buildCachePath, JSON.stringify(resultData));
    } catch {}

    logger?.info(
      `Generated ${GRID_SIZE}x${GRID_SIZE} stats.fm album mosaic (${compactAlbums.length} unique albums used from top ${validAlbums.length}).`
    );

    return resultData;
  } catch (err: any) {
    logger?.warn(`Failed building album mosaic: ${err?.message || err}`);
    return undefined;
  }
}
