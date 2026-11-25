import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { processInBatches } from './music-previews';
import type { TimelineYearData } from './timeline';

export const TIMELINE_COVERS_CACHE_DIR = path.resolve(
  'node_modules/.cache/timeline-covers'
);
export const TIMELINE_COVERS_DIRTY_MARKER = path.join(
  TIMELINE_COVERS_CACHE_DIR,
  '.dirty'
);

const PUBLIC_COVERS_DIR = path.resolve('public/assets/notion/timeline-covers');
const PUBLIC_COVERS_URL_PREFIX = '/assets/notion/timeline-covers';
const COVER_SIZE_PX = 300;
const COVER_WEBP_QUALITY = 82;
const CACHE_PRUNE_BUFFER = 60;

function getCoverFilename(remoteUrl: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(remoteUrl)
    .digest('hex')
    .slice(0, 12);
  return `${hash}.webp`;
}

function fileExistsNonEmpty(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function ensurePublicCopy(cachePath: string, publicPath: string): void {
  if (!fileExistsNonEmpty(publicPath)) {
    fs.copyFileSync(cachePath, publicPath);
  }
}

/**
 * Downloads and converts unique Timeline album covers into gitignored
 * `public/assets/notion/timeline-covers/<hash>.webp` with persistent caching
 * under `node_modules/.cache/timeline-covers/`. Fault-isolated per cover:
 * any failed download gracefully falls back to the remote CDN URL.
 */
export async function syncTimelineCovers(
  years: TimelineYearData[],
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<void> {
  const urlToFile = new Map<string, string>();
  for (const yr of years) {
    for (const tile of yr.tiles) {
      if (tile.image && /^https?:\/\//i.test(tile.image)) {
        if (!urlToFile.has(tile.image)) {
          urlToFile.set(tile.image, getCoverFilename(tile.image));
        }
      }
    }
  }

  if (urlToFile.size === 0) return;

  const skipNetwork =
    process.argv.some((a) => a === 'check' || a === 'sync') ||
    process.env.SKIP_TIMELINE_COVER_DOWNLOAD === '1';

  fs.mkdirSync(PUBLIC_COVERS_DIR, { recursive: true });
  fs.mkdirSync(TIMELINE_COVERS_CACHE_DIR, { recursive: true });

  if (!skipNetwork) {
    try {
      if (fs.existsSync(TIMELINE_COVERS_DIRTY_MARKER)) {
        fs.unlinkSync(TIMELINE_COVERS_DIRTY_MARKER);
      }
    } catch {
      // Non-fatal marker cleanup error
    }
  }

  const resolvedUrls = new Map<string, string>();
  const activeFilenames = new Set(urlToFile.values());
  let cachedCount = 0;
  let downloadedCount = 0;
  let failedCount = 0;
  let cacheDirty = false;

  if (skipNetwork) {
    for (const [remoteUrl, filename] of urlToFile) {
      const cachePath = path.join(TIMELINE_COVERS_CACHE_DIR, filename);
      if (!fileExistsNonEmpty(cachePath)) continue;
      const publicPath = path.join(PUBLIC_COVERS_DIR, filename);
      try {
        ensurePublicCopy(cachePath, publicPath);
        resolvedUrls.set(remoteUrl, `${PUBLIC_COVERS_URL_PREFIX}/${filename}`);
        cachedCount++;
      } catch {
        // Keep remote URL if copy fails during check
      }
    }
  } else {
    const entries = Array.from(urlToFile.entries());
    await processInBatches(entries, 12, async ([remoteUrl, filename]) => {
      const cachePath = path.join(TIMELINE_COVERS_CACHE_DIR, filename);
      const publicPath = path.join(PUBLIC_COVERS_DIR, filename);

      if (fileExistsNonEmpty(cachePath)) {
        try {
          ensurePublicCopy(cachePath, publicPath);
          resolvedUrls.set(
            remoteUrl,
            `${PUBLIC_COVERS_URL_PREFIX}/${filename}`
          );
          cachedCount++;
          return;
        } catch {
          // Fall through and re-fetch if cached file could not be copied
        }
      }

      try {
        const res = await fetch(remoteUrl, {
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) {
          failedCount++;
          return;
        }
        const rawBuf = Buffer.from(await res.arrayBuffer());
        const webpBuf = await sharp(rawBuf)
          .resize(COVER_SIZE_PX, COVER_SIZE_PX, { fit: 'cover' })
          .webp({ quality: COVER_WEBP_QUALITY })
          .toBuffer();

        if (webpBuf.length === 0) {
          failedCount++;
          return;
        }

        fs.writeFileSync(cachePath, webpBuf);
        fs.writeFileSync(publicPath, webpBuf);
        resolvedUrls.set(remoteUrl, `${PUBLIC_COVERS_URL_PREFIX}/${filename}`);
        downloadedCount++;
        cacheDirty = true;
      } catch {
        failedCount++;
      }
    });

    // Prune stale public files so dist/ only ships currently rendered covers
    try {
      for (const file of fs.readdirSync(PUBLIC_COVERS_DIR)) {
        if (file.endsWith('.webp') && !activeFilenames.has(file)) {
          fs.unlinkSync(path.join(PUBLIC_COVERS_DIR, file));
        }
      }
    } catch {
      // Non-fatal public directory prune failure
    }

    // Prune unbounded stale files from disk cache when far above active set
    try {
      const cachedWebps = fs
        .readdirSync(TIMELINE_COVERS_CACHE_DIR)
        .filter((f) => f.endsWith('.webp'));
      if (cachedWebps.length > activeFilenames.size + CACHE_PRUNE_BUFFER) {
        for (const file of cachedWebps) {
          if (!activeFilenames.has(file)) {
            fs.unlinkSync(path.join(TIMELINE_COVERS_CACHE_DIR, file));
            cacheDirty = true;
          }
        }
      }
    } catch {
      // Non-fatal cache prune failure
    }

    if (cacheDirty) {
      try {
        fs.writeFileSync(TIMELINE_COVERS_DIRTY_MARKER, String(Date.now()));
      } catch {
        // Non-fatal dirty marker write failure
      }
    }
  }

  for (const yr of years) {
    for (const tile of yr.tiles) {
      const localUrl = resolvedUrls.get(tile.image);
      if (localUrl) {
        tile.image = localUrl;
      }
    }
  }

  const parts = [
    downloadedCount > 0 ? `+${downloadedCount} downloaded` : '',
    cachedCount > 0 ? `${cachedCount} cached` : '',
    failedCount > 0 ? `${failedCount} fallback` : ''
  ].filter(Boolean);

  logger?.info(
    `Synced timeline covers: ${resolvedUrls.size}/${urlToFile.size} self-hosted${parts.length ? ` (${parts.join(', ')})` : ''}.`
  );
}
