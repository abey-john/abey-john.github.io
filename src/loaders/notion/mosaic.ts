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
  gridCols: number;
  gridRows: number;
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

const MAX_GRID_AXIS = 120; // Longest axis of the auto-cropped cutout grid (up to 120 tiles)
const TILE_PX = 45; // 45x45px per tile in the transparent RGBA WebP atlas
const MAX_ALBUM_POOL = 2000; // Candidate pool of top lifetime unique albums
const MAX_USES_PER_ALBUM = 7; // Up to 7 uses per album across active cutout tiles
const TILE_DC_SHIFT = 0.0; // 0.0 = pure un-tinted album covers (all matching comes from the LAB solver)
const TILE_INTERNAL_CONTRAST = 0.92; // Keep 92% of the album cover's own crisp internal artwork contrast
const TILE_SATURATION = 0.92; // Preserve vibrant original album cover colors
const ALPHA_THRESHOLD = 115; // Minimum cell average alpha (0..255, ~45%) to place a whole square album tile
const CACHE_VERSION = 'v14-cutout-axis120-45px-pool2000-max7-dc000';

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
  const offsets = [0, 500, 1000, 1500, 2000, 2500];
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
          cachedData.gridCols > 0 &&
          cachedData.gridRows > 0 &&
          cachedData.grid?.length ===
            cachedData.gridCols * cachedData.gridRows &&
          cachedData.albums?.length > 0
        ) {
          logger?.info(
            `Loaded cached ${cachedData.gridCols}x${cachedData.gridRows} stats.fm cutout mosaic (${cachedData.albums.length} unique albums).`
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

    // 4. Decode portrait with alpha channel, auto-crop to non-transparent bounding box, and size rectangular grid
    const decoded = await sharp(portraitBytes)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fullRgba = decoded.data;
    const srcW = decoded.info.width;
    const srcH = decoded.info.height;

    let minX = srcW;
    let minY = srcH;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < srcH; y++) {
      const rowOff = y * srcW * 4;
      for (let x = 0; x < srcW; x++) {
        const a = fullRgba[rowOff + x * 4 + 3];
        if (a >= 128) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX <= minX || maxY <= minY) {
      minX = 0;
      minY = 0;
      maxX = srcW - 1;
      maxY = srcH - 1;
    }

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    let gridCols: number;
    let gridRows: number;
    if (cropH >= cropW) {
      gridRows = MAX_GRID_AXIS;
      gridCols = Math.max(24, Math.round((cropW / cropH) * MAX_GRID_AXIS));
    } else {
      gridCols = MAX_GRID_AXIS;
      gridRows = Math.max(24, Math.round((cropH / cropW) * MAX_GRID_AXIS));
    }
    const totalCells = gridCols * gridRows;

    // Sample alpha-weighted RGB directly from the cropped region so transparent edge pixels never darken silhouette tiles
    const isCellActive = new Uint8Array(totalCells);
    const cellMeanRgb = new Float32Array(totalCells * 3);
    const targetCellsLab: Array<CachedAlbumSignature['quadLab']> = new Array(
      totalCells
    );

    for (let r = 0; r < gridRows; r++) {
      const y0 = minY + Math.floor((r * cropH) / gridRows);
      const y1 = Math.max(
        y0 + 1,
        minY + Math.floor(((r + 1) * cropH) / gridRows)
      );
      const yMid = Math.floor((y0 + y1) / 2);

      for (let c = 0; c < gridCols; c++) {
        const cellIdx = r * gridCols + c;
        const x0 = minX + Math.floor((c * cropW) / gridCols);
        const x1 = Math.max(
          x0 + 1,
          minX + Math.floor(((c + 1) * cropW) / gridCols)
        );
        const xMid = Math.floor((x0 + x1) / 2);

        let totalAlphaSum = 0;
        let pixelCount = 0;
        const qSumR = [0, 0, 0, 0];
        const qSumG = [0, 0, 0, 0];
        const qSumB = [0, 0, 0, 0];
        const qSumW = [0, 0, 0, 0];

        for (let py = y0; py < y1 && py <= maxY; py++) {
          const rowOff = py * srcW * 4;
          const qRow = py >= yMid ? 2 : 0;
          for (let px = x0; px < x1 && px <= maxX; px++) {
            const idx = rowOff + px * 4;
            const a = fullRgba[idx + 3];
            totalAlphaSum += a;
            pixelCount++;

            if (a >= 165) {
              const weight = a * a;
              const qIdx = qRow + (px >= xMid ? 1 : 0);
              qSumR[qIdx] += fullRgba[idx] * weight;
              qSumG[qIdx] += fullRgba[idx + 1] * weight;
              qSumB[qIdx] += fullRgba[idx + 2] * weight;
              qSumW[qIdx] += weight;
            }
          }
        }

        const meanAlpha = pixelCount > 0 ? totalAlphaSum / pixelCount : 0;
        const cellSumW = qSumW[0] + qSumW[1] + qSumW[2] + qSumW[3];
        if (meanAlpha < ALPHA_THRESHOLD || cellSumW <= 0) {
          isCellActive[cellIdx] = 0;
          continue;
        }

        isCellActive[cellIdx] = 1;
        const cR = (qSumR[0] + qSumR[1] + qSumR[2] + qSumR[3]) / cellSumW;
        const cG = (qSumG[0] + qSumG[1] + qSumG[2] + qSumG[3]) / cellSumW;
        const cB = (qSumB[0] + qSumB[1] + qSumB[2] + qSumB[3]) / cellSumW;
        cellMeanRgb[cellIdx * 3] = cR;
        cellMeanRgb[cellIdx * 3 + 1] = cG;
        cellMeanRgb[cellIdx * 3 + 2] = cB;

        const quads: CachedAlbumSignature['quadLab'] = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0]
        ];
        for (let q = 0; q < 4; q++) {
          if (qSumW[q] > 0) {
            quads[q] = rgbToLab(
              qSumR[q] / qSumW[q],
              qSumG[q] / qSumW[q],
              qSumB[q] / qSumW[q]
            );
          } else {
            quads[q] = rgbToLab(cR, cG, cB);
          }
        }
        targetCellsLab[cellIdx] = quads;
      }
    }

    // Automatically locate horizontal center of the head (top 20% of active silhouette rows)
    let headSumC = 0;
    let headSumR = 0;
    let headCount = 0;
    const headMaxRow = Math.max(1, Math.ceil(gridRows * 0.2));
    for (let r = 0; r < headMaxRow; r++) {
      for (let c = 0; c < gridCols; c++) {
        if (isCellActive[r * gridCols + c]) {
          headSumC += c;
          headSumR += r;
          headCount++;
        }
      }
    }
    const headCenterC = headCount > 0 ? headSumC / headCount : gridCols * 0.5;
    const headCenterR = headCount > 0 ? headSumR / headCount : gridRows * 0.11;
    const headRadius = Math.max(gridCols, gridRows) * 0.12;

    const cellPriority: Array<{ idx: number; priority: number }> = [];

    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        const cellIdx = r * gridCols + c;
        if (!isCellActive[cellIdx]) continue;

        const [q0, q1, q2, q3] = targetCellsLab[cellIdx];
        const distFromFace = Math.hypot(
          (r - headCenterR) / headRadius,
          (c - headCenterC) / headRadius
        );
        const faceWeight = Math.max(0, 2.5 - distFromFace) * 40;
        const internalContrast =
          Math.abs(q0[0] - q3[0]) + Math.abs(q1[0] - q2[0]);

        // Slight priority boost for silhouette contour edge cells
        const isEdge =
          r === 0 ||
          r === gridRows - 1 ||
          c === 0 ||
          c === gridCols - 1 ||
          !isCellActive[(r - 1) * gridCols + c] ||
          !isCellActive[(r + 1) * gridCols + c] ||
          !isCellActive[r * gridCols + (c - 1)] ||
          !isCellActive[r * gridCols + (c + 1)];
        const edgeWeight = isEdge ? 16 : 0;

        cellPriority.push({
          idx: cellIdx,
          priority: faceWeight + internalContrast + edgeWeight
        });
      }
    }

    // Solve highest-priority cells (face, features, silhouette contour) first
    cellPriority.sort((a, b) => b.priority - a.priority);

    // 5. Solve active cutout cells with max uses = 7, minimum Euclidean distance spacing, and excess-saturation penalty
    const assignedPoolIdx = new Int32Array(totalCells).fill(-1);
    const placedPositions: Array<Array<[number, number]>> = Array.from(
      { length: validAlbums.length },
      () => []
    );

    const minDistancesSq = [196, 121, 64, 25, 0]; // Prefer 14+, 11+, 8+, 5+ tiles spacing between repeats

    for (const { idx: cellIdx } of cellPriority) {
      const r = Math.floor(cellIdx / gridCols);
      const c = cellIdx % gridCols;
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

          // Diversity penalty encourages using more of the 2,000-album pool before repeating a cover
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
        let leastUsedIdx = 0;
        for (let aIdx = 1; aIdx < validAlbums.length; aIdx++) {
          if (
            placedPositions[aIdx].length < placedPositions[leastUsedIdx].length
          ) {
            leastUsedIdx = aIdx;
          }
        }
        chosenAlbumIdx = leastUsedIdx;
      }

      assignedPoolIdx[cellIdx] = chosenAlbumIdx;
      placedPositions[chosenAlbumIdx].push([r, c]);
    }

    // 6. Composite the transparent RGBA WebP mosaic atlas (inactive cells remain 100% transparent)
    const fullWidthPx = gridCols * TILE_PX;
    const fullHeightPx = gridRows * TILE_PX;

    const mosaicRgba = Buffer.alloc(fullWidthPx * fullHeightPx * 4);
    const thumbRawBuffers = new Map<number, Buffer>();
    const thumbMeanRgb = new Map<number, [number, number, number]>();

    // Load only the raw buffers of albums that were actually selected & compute each tile's flat mean RGB
    for (let i = 0; i < assignedPoolIdx.length; i++) {
      const poolIdx = assignedPoolIdx[i];
      if (poolIdx < 0) continue;
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

    const rowStride = fullWidthPx * 4;
    const tileRowRgbaBytes = TILE_PX * 4;
    const tileRowRgbBytes = TILE_PX * 3;

    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        const cellIdx = r * gridCols + c;
        const poolIdx = assignedPoolIdx[cellIdx];
        if (poolIdx < 0) continue;

        const tileBuf = thumbRawBuffers.get(poolIdx);
        const tileMean = thumbMeanRgb.get(poolIdx);
        if (!tileBuf || !tileMean) continue;

        const cellOffset = cellIdx * 3;
        const cellR = cellMeanRgb[cellOffset];
        const cellG = cellMeanRgb[cellOffset + 1];
        const cellB = cellMeanRgb[cellOffset + 2];

        const [meanR, meanG, meanB] = tileMean;
        const targetMeanR = meanR * (1 - TILE_DC_SHIFT) + cellR * TILE_DC_SHIFT;
        const targetMeanG = meanG * (1 - TILE_DC_SHIFT) + cellG * TILE_DC_SHIFT;
        const targetMeanB = meanB * (1 - TILE_DC_SHIFT) + cellB * TILE_DC_SHIFT;

        const baseRow = r * TILE_PX;
        const baseColBytes = c * tileRowRgbaBytes;

        for (let tr = 0; tr < TILE_PX; tr++) {
          const destRowStart = (baseRow + tr) * rowStride + baseColBytes;
          const srcRowStart = tr * tileRowRgbBytes;
          const isBottomSeam = tr === TILE_PX - 1;

          for (let tc = 0; tc < TILE_PX; tc++) {
            const srcIdx = srcRowStart + tc * 3;
            const destIdx = destRowStart + tc * 4;

            const pr = tileBuf[srcIdx];
            const pg = tileBuf[srcIdx + 1];
            const pb = tileBuf[srcIdx + 2];
            const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;

            const sr = lum + (pr - lum) * TILE_SATURATION;
            const sg = lum + (pg - lum) * TILE_SATURATION;
            const sb = lum + (pb - lum) * TILE_SATURATION;

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

            mosaicRgba[destIdx] = Math.max(0, Math.min(255, Math.round(outR)));
            mosaicRgba[destIdx + 1] = Math.max(
              0,
              Math.min(255, Math.round(outG))
            );
            mosaicRgba[destIdx + 2] = Math.max(
              0,
              Math.min(255, Math.round(outB))
            );
            mosaicRgba[destIdx + 3] = 255;
          }
        }
      }
    }

    const webpAtlasBuffer = await sharp(mosaicRgba, {
      raw: { width: fullWidthPx, height: fullHeightPx, channels: 4 }
    })
      .webp({ quality: 84, alphaQuality: 95, effort: 4 })
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

    // 7. Build compact output palette containing only the unique albums used in active silhouette cells
    const poolToCompactIdx = new Map<number, number>();
    const compactAlbums: MosaicAlbumItem[] = [];
    const compactGrid: number[] = new Array(totalCells).fill(-1);

    for (let i = 0; i < assignedPoolIdx.length; i++) {
      const poolIdx = assignedPoolIdx[i];
      if (poolIdx < 0) {
        compactGrid[i] = -1;
        continue;
      }
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
      gridSize: Math.max(gridCols, gridRows),
      gridCols,
      gridRows,
      tilePixelSize: TILE_PX,
      albums: compactAlbums,
      grid: compactGrid
    };

    try {
      fs.writeFileSync(buildCachePath, JSON.stringify(resultData));
    } catch {}

    logger?.info(
      `Generated ${gridCols}x${gridRows} stats.fm cutout mosaic (${cellPriority.length} active tiles, ${compactAlbums.length} unique albums used from top ${validAlbums.length}).`
    );

    return resultData;
  } catch (err: any) {
    logger?.warn(`Failed building album mosaic: ${err?.message || err}`);
    return undefined;
  }
}
