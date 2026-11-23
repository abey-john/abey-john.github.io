import fs from 'node:fs';
import path from 'node:path';
import type { MosaicBuildData } from './mosaic';
import type { TimelineBuildData } from './timeline';
import { createAppleMusicWebClient } from './apple-music-web';
import {
  cleanMatchText,
  extractPrimaryArtist,
  getAlternatePenalty,
  getBaseTitle,
  getNormalizedAlbumArtistKey,
  getPreviewCacheKey,
  matchesAlbumTitle,
  matchesArtistName,
  pickPreferredStatsFmTrack,
  scoreScopedSongCandidate,
  scoreTrackMatch,
  splitCreditArtists
} from '../../utils/audio-preview-matching';

export const MUSIC_PREVIEWS_CACHE_DIR = path.resolve(
  'node_modules/.cache/music-previews'
);
export const MUSIC_PREVIEWS_DIRTY_MARKER = path.join(
  MUSIC_PREVIEWS_CACHE_DIR,
  '.dirty'
);

const CACHE_FILE_PATH = path.join(MUSIC_PREVIEWS_CACHE_DIR, 'cache.json');
const MANIFEST_OUTPUT_PATH = path.resolve(
  'public/assets/notion/music-previews.json'
);
const CACHE_VERSION = 2;
const NEGATIVE_MISS_TTL_MS = 30 * 86_400_000;
const CURRENT_YEAR_REFRESH_TTL_MS = 21 * 86_400_000;
const PRUNE_UNSEEN_TTL_MS = 90 * 86_400_000;
const CHUNK_SIZE = 3;

interface PreviewCacheEntry {
  status: 'hit' | 'miss';
  url?: string;
  track?: string;
  resolvedAt: number;
  lastSeenAt: number;
}

interface PreviewDiskCache {
  version: number;
  entries: Record<string, PreviewCacheEntry>;
}

interface OverviewSeedItem {
  title: string;
  artist: string;
  previewUrl?: string;
  previewTrack?: string;
}

interface CandidateAlbum {
  key: string;
  normKey: string;
  id?: number;
  title: string;
  artist: string;
  primaryArtist: string;
  isCurrentYear: boolean;
  timelineYear: number;
  timelineRank: number;
  timelineSpan: 0 | 1 | 2 | 3;
  mosaicRank: number;
  priorityTier: number;
}

interface BulkTrackInfo {
  trackName: string;
  spotifyPreview?: string;
  isClean: boolean;
}

interface ItunesFetchResult {
  ok: boolean;
  rateLimited: boolean;
  transientError: boolean;
  data: any | null;
}

export interface BuildMusicPreviewManifestParams {
  username?: string;
  mosaic?: MosaicBuildData;
  timeline?: TimelineBuildData;
  overviewItems?: OverviewSeedItem[];
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export function markMusicPreviewCacheDirty(): void {
  try {
    fs.mkdirSync(MUSIC_PREVIEWS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(MUSIC_PREVIEWS_DIRTY_MARKER, String(Date.now()));
  } catch {
    // Ignore non-fatal CI marker write failures
  }
}

function parseEnvInt(
  name: string,
  fallback: number,
  allowZero = false
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  if (allowZero ? parsed < 0 : parsed <= 0) return fallback;
  return parsed;
}

function loadDiskCache(): PreviewDiskCache {
  try {
    if (!fs.existsSync(CACHE_FILE_PATH)) {
      return { version: CACHE_VERSION, entries: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE_PATH, 'utf8'));
    if (
      parsed &&
      parsed.version === CACHE_VERSION &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return parsed as PreviewDiskCache;
    }
  } catch {
    // Rebuild corrupt cache cleanly
  }
  return { version: CACHE_VERSION, entries: {} };
}

function saveDiskCache(cache: PreviewDiskCache): void {
  fs.mkdirSync(MUSIC_PREVIEWS_CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache));
  markMusicPreviewCacheDirty();
}

function writeBrowserManifest(
  entries: Record<string, PreviewCacheEntry>,
  activeKeys: Set<string>
): number {
  const manifest: Record<string, string> = {};
  let hitCount = 0;

  for (const key of activeKeys) {
    const entry = entries[key];
    if (entry?.status === 'hit' && entry.url) {
      manifest[key] = entry.url;
      hitCount++;
    }
  }

  fs.mkdirSync(path.dirname(MANIFEST_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_OUTPUT_PATH, JSON.stringify(manifest));
  return hitCount;
}

function computePriorityTier(c: CandidateAlbum): number {
  if (c.isCurrentYear) return 1;
  if (c.timelineSpan >= 2) return 2;
  if (c.mosaicRank <= 100) return 3;
  if (c.timelineYear > 0) return 4;
  return 5;
}

function compareCandidates(a: CandidateAlbum, b: CandidateAlbum): number {
  if (a.priorityTier !== b.priorityTier) {
    return a.priorityTier - b.priorityTier;
  }
  switch (a.priorityTier) {
    case 1:
      return (
        b.timelineSpan - a.timelineSpan ||
        a.timelineRank - b.timelineRank ||
        a.mosaicRank - b.mosaicRank
      );
    case 2:
      return (
        b.timelineYear - a.timelineYear ||
        b.timelineSpan - a.timelineSpan ||
        a.timelineRank - b.timelineRank
      );
    case 3:
      return a.mosaicRank - b.mosaicRank;
    case 4:
      return b.timelineYear - a.timelineYear || a.timelineRank - b.timelineRank;
    default:
      return a.mosaicRank - b.mosaicRank;
  }
}

function collectUniqueCandidates(
  mosaic?: MosaicBuildData,
  timeline?: TimelineBuildData
): CandidateAlbum[] {
  const map = new Map<string, CandidateAlbum>();

  const upsert = (
    item: {
      id?: number;
      title: string;
      artist: string;
      primaryArtist?: string;
    },
    meta: Partial<CandidateAlbum>
  ) => {
    const key = getPreviewCacheKey({
      id: item.id,
      title: item.title,
      artist: item.artist,
      primaryArtist: item.primaryArtist
    });
    const existing = map.get(key);
    if (existing) {
      existing.isCurrentYear =
        existing.isCurrentYear || Boolean(meta.isCurrentYear);
      if ((meta.timelineYear ?? 0) > existing.timelineYear) {
        existing.timelineYear = meta.timelineYear!;
        existing.timelineRank = meta.timelineRank ?? existing.timelineRank;
        existing.timelineSpan = meta.timelineSpan ?? existing.timelineSpan;
      } else if (
        meta.timelineYear &&
        meta.timelineYear === existing.timelineYear
      ) {
        existing.timelineRank = Math.min(
          existing.timelineRank,
          meta.timelineRank ?? Infinity
        );
        existing.timelineSpan = Math.max(
          existing.timelineSpan,
          meta.timelineSpan ?? 0
        ) as 0 | 1 | 2 | 3;
      }
      if ((meta.mosaicRank ?? Infinity) < existing.mosaicRank) {
        existing.mosaicRank = meta.mosaicRank!;
      }
      if (!existing.id && item.id) {
        existing.id = item.id;
      }
      return;
    }

    map.set(key, {
      key,
      normKey: getNormalizedAlbumArtistKey(item.title, item.artist),
      id: item.id,
      title: item.title,
      artist: item.artist,
      primaryArtist: extractPrimaryArtist(item.artist, item.primaryArtist),
      isCurrentYear: Boolean(meta.isCurrentYear),
      timelineYear: meta.timelineYear ?? 0,
      timelineRank: meta.timelineRank ?? Infinity,
      timelineSpan: meta.timelineSpan ?? 0,
      mosaicRank: meta.mosaicRank ?? Infinity,
      priorityTier: 5
    });
  };

  if (timeline?.years?.length) {
    for (const yr of timeline.years) {
      for (const tile of yr.tiles) {
        upsert(tile, {
          isCurrentYear: yr.isCurrentYear,
          timelineYear: yr.year,
          timelineRank: tile.rank,
          timelineSpan: tile.span
        });
      }
    }
  }

  if (mosaic?.albums?.length) {
    for (const alb of mosaic.albums) {
      upsert(alb, {
        mosaicRank: alb.rank
      });
    }
  }

  const list = Array.from(map.values());
  for (const c of list) {
    c.priorityTier = computePriorityTier(c);
  }
  return list;
}

function getArtistTokenSet(
  artist: string,
  explicitPrimary?: string
): Set<string> {
  const tokens = new Set<string>();
  const rawCandidates = [
    extractPrimaryArtist(artist, explicitPrimary),
    ...splitCreditArtists(artist),
    ...(explicitPrimary?.trim() ? [explicitPrimary.trim()] : []),
    artist
  ];
  for (const raw of rawCandidates) {
    const clean = cleanMatchText(raw);
    if (clean) tokens.add(clean);
  }
  return tokens;
}

function hasSharedArtistToken(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

function seedEntriesFromOverview(
  candidates: CandidateAlbum[],
  overviewItems: OverviewSeedItem[],
  entries: Record<string, PreviewCacheEntry>,
  now: number
): number {
  if (overviewItems.length === 0) return 0;

  interface IndexedSeed {
    item: OverviewSeedItem;
    artists: Set<string>;
  }

  const byExactTitle = new Map<string, IndexedSeed[]>();
  const byBaseTitle = new Map<string, IndexedSeed[]>();

  const pushSeed = (
    map: Map<string, IndexedSeed[]>,
    key: string,
    seed: IndexedSeed
  ) => {
    const list = map.get(key);
    if (list) list.push(seed);
    else map.set(key, [seed]);
  };

  for (const item of overviewItems) {
    if (!item.previewUrl) continue;
    const seed: IndexedSeed = {
      item,
      artists: getArtistTokenSet(item.artist)
    };
    const exactKey =
      cleanMatchText(item.title) || item.title.trim().toLowerCase();
    if (exactKey) {
      pushSeed(byExactTitle, exactKey, seed);
    }
    const baseKey = cleanMatchText(getBaseTitle(item.title) || item.title);
    if (baseKey) {
      pushSeed(byBaseTitle, baseKey, seed);
    }
  }

  let seededCount = 0;
  for (const c of candidates) {
    const existing = entries[c.key];
    if (existing?.status === 'hit' && existing.url) continue;

    const candArtists = getArtistTokenSet(c.artist, c.primaryArtist);
    const exactKey = cleanMatchText(c.title) || c.title.trim().toLowerCase();
    let matched = byExactTitle
      .get(exactKey)
      ?.find((seed) => hasSharedArtistToken(candArtists, seed.artists));

    if (!matched) {
      const baseKey = cleanMatchText(getBaseTitle(c.title) || c.title);
      if (baseKey) {
        matched = byBaseTitle
          .get(baseKey)
          ?.find(
            (seed) =>
              hasSharedArtistToken(candArtists, seed.artists) &&
              getAlternatePenalty('', c.title, c.artist, seed.item.title) ===
                0 &&
              getAlternatePenalty(
                '',
                seed.item.title,
                seed.item.artist,
                c.title
              ) === 0
          );
      }
    }

    if (!matched) continue;

    entries[c.key] = {
      status: 'hit',
      url: matched.item.previewUrl!,
      track: matched.item.previewTrack,
      resolvedAt: now,
      lastSeenAt: now
    };
    seededCount++;
  }
  return seededCount;
}

async function fetchBulkStatsFmTopTracks(
  username: string
): Promise<Map<number, BulkTrackInfo>> {
  const offsets = [0, 500, 1000, 1500];
  const byAlbumId = new Map<number, BulkTrackInfo>();

  const pages = await Promise.all(
    offsets.map(async (offset) => {
      try {
        const res = await fetch(
          `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/top/tracks?limit=500&offset=${offset}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.items) ? data.items : [];
      } catch {
        return [];
      }
    })
  );

  for (const item of pages.flat()) {
    const trk = item?.track;
    const trkName = (trk?.name || '').trim();
    if (!trkName || !Array.isArray(trk?.albums)) continue;

    const artistName = Array.isArray(trk.artists)
      ? trk.artists.map((a: any) => a?.name || '').join(', ')
      : '';
    const spotifyPreview =
      typeof trk.spotifyPreview === 'string' && trk.spotifyPreview
        ? trk.spotifyPreview
        : undefined;

    for (const albObj of trk.albums) {
      const albId = Number(albObj?.id);
      if (!albId || Number.isNaN(albId)) continue;

      const isClean =
        getAlternatePenalty(trkName, albObj?.name || '', artistName, '') === 0;
      const existing = byAlbumId.get(albId);

      if (!existing || (!existing.isClean && isClean)) {
        byAlbumId.set(albId, {
          trackName: trkName,
          spotifyPreview: isClean ? spotifyPreview : undefined,
          isClean
        });
      }
    }
  }

  return byAlbumId;
}

async function fetchPerAlbumStatsFmTrack(
  username: string,
  alb: CandidateAlbum
): Promise<{ trackName: string; spotifyPreview?: string }> {
  if (!alb.id) return { trackName: '' };

  try {
    const userRes = await fetch(
      `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/top/albums/${alb.id}/tracks`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => null);

    if (userRes?.ok) {
      const userData = await userRes.json();
      const userItems = Array.isArray(userData.items) ? userData.items : [];
      if (userItems.length > 0) {
        return pickPreferredStatsFmTrack(userItems, alb.title, alb.artist);
      }
    }

    const albRes = await fetch(
      `https://api.stats.fm/api/v1/albums/${alb.id}/tracks`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => null);

    if (albRes?.ok) {
      const albData = await albRes.json();
      const albItems = Array.isArray(albData.items) ? albData.items : [];
      if (albItems.length > 0) {
        const mapped = albItems.map((t: any) => ({ track: t }));
        const picked = pickPreferredStatsFmTrack(mapped, alb.title, alb.artist);
        return { trackName: picked.trackName };
      }
    }
  } catch {
    // Graceful fallback when stats.fm album tracks fail
  }

  return { trackName: '' };
}

function createPacedItunesClient(
  budgetMs: number,
  delayMs: number,
  startedAt: number
) {
  let lastReqAt = 0;
  let consecutiveRateLimits = 0;
  let circuitTripped = false;

  const hasBudget = () => !circuitTripped && Date.now() - startedAt < budgetMs;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const fetchJson = async (url: string): Promise<ItunesFetchResult> => {
    if (!hasBudget()) {
      return {
        ok: false,
        rateLimited: circuitTripped,
        transientError: true,
        data: null
      };
    }

    const elapsedSinceLast = Date.now() - lastReqAt;
    if (lastReqAt > 0 && elapsedSinceLast < delayMs) {
      const waitMs = delayMs - elapsedSinceLast;
      if (Date.now() + waitMs - startedAt >= budgetMs) {
        return {
          ok: false,
          rateLimited: false,
          transientError: true,
          data: null
        };
      }
      await sleep(waitMs);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!hasBudget()) {
        return {
          ok: false,
          rateLimited: circuitTripped,
          transientError: true,
          data: null
        };
      }

      lastReqAt = Date.now();
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(6000)
        });

        if (res.status === 429 || res.status === 403) {
          consecutiveRateLimits++;
          if (attempt === 0 && consecutiveRateLimits < 2) {
            const retryHeader = Number(res.headers.get('retry-after'));
            const retryWaitMs =
              Number.isFinite(retryHeader) && retryHeader > 0
                ? Math.min(3000, retryHeader * 1000)
                : 2500;
            if (Date.now() + retryWaitMs - startedAt < budgetMs) {
              await sleep(retryWaitMs);
              continue;
            }
          }
          circuitTripped = true;
          return {
            ok: false,
            rateLimited: true,
            transientError: true,
            data: null
          };
        }

        if (!res.ok) {
          consecutiveRateLimits = 0;
          return {
            ok: false,
            rateLimited: false,
            transientError: res.status >= 500,
            data: null
          };
        }

        consecutiveRateLimits = 0;
        const data = await res.json();
        return {
          ok: true,
          rateLimited: false,
          transientError: false,
          data
        };
      } catch {
        return {
          ok: false,
          rateLimited: false,
          transientError: true,
          data: null
        };
      }
    }

    return {
      ok: false,
      rateLimited: circuitTripped,
      transientError: true,
      data: null
    };
  };

  return {
    hasBudget,
    isTripped: () => circuitTripped,
    fetchJson
  };
}

/**
 * Incrementally resolves and caches iTunes 30-second album preview URLs into
 * gitignored disk storage (`node_modules/.cache/music-previews/cache.json`) and
 * writes a pruned client manifest to `public/assets/notion/music-previews.json`.
 */
export async function buildMusicPreviewManifest({
  username = 'itseebo',
  mosaic,
  timeline,
  overviewItems = [],
  logger
}: BuildMusicPreviewManifestParams): Promise<void> {
  const candidates = collectUniqueCandidates(mosaic, timeline);
  if (candidates.length === 0) return;

  const activeKeys = new Set(candidates.map((c) => c.key));
  const now = Date.now();
  const skipNetwork =
    process.argv.some((a) => a === 'check' || a === 'sync') ||
    process.env.SKIP_PREVIEW_RESOLUTION === '1';

  const diskCache = loadDiskCache();

  if (skipNetwork) {
    const seededEntries: Record<string, PreviewCacheEntry> = {
      ...diskCache.entries
    };
    const seededCount = seedEntriesFromOverview(
      candidates,
      overviewItems,
      seededEntries,
      now
    );
    const manifestHits = writeBrowserManifest(seededEntries, activeKeys);
    logger?.info(
      `Loaded music preview manifest (${manifestHits}/${candidates.length} cached${seededCount > 0 ? `, +${seededCount} from Overview` : ''}; skipped network check).`
    );
    return;
  }

  let cacheChanged = false;

  // Refresh lastSeenAt for existing active entries
  for (const c of candidates) {
    const existing = diskCache.entries[c.key];
    if (existing) {
      existing.lastSeenAt = now;
    }
  }

  // Prune stale cache entries unseen for > 90 days
  let prunedCount = 0;
  for (const [key, entry] of Object.entries(diskCache.entries)) {
    if (
      !activeKeys.has(key) &&
      now - (entry.lastSeenAt || 0) > PRUNE_UNSEEN_TTL_MS
    ) {
      delete diskCache.entries[key];
      prunedCount++;
      cacheChanged = true;
    }
  }

  // Seed free matches from Overview before making any network requests
  const seededCount = seedEntriesFromOverview(
    candidates,
    overviewItems,
    diskCache.entries,
    now
  );
  if (seededCount > 0) {
    cacheChanged = true;
  }

  // Bulk stats.fm top-tracks fetch to avoid per-album calls and detect #1 track changes
  const bulkTopTracks = await fetchBulkStatsFmTopTracks(username);

  interface EligibleItem {
    candidate: CandidateAlbum;
    refreshBucket: 0 | 1 | 2;
    alreadyHasValidHit: boolean;
  }

  const eligible: EligibleItem[] = [];
  for (const c of candidates) {
    const entry = diskCache.entries[c.key];
    if (!entry) {
      eligible.push({
        candidate: c,
        refreshBucket: 0,
        alreadyHasValidHit: false
      });
      continue;
    }

    if (entry.status === 'miss') {
      if (now - entry.resolvedAt > NEGATIVE_MISS_TTL_MS) {
        eligible.push({
          candidate: c,
          refreshBucket: 0,
          alreadyHasValidHit: false
        });
      }
      continue;
    }

    const bulkTop = c.id ? bulkTopTracks.get(c.id) : undefined;
    if (
      bulkTop &&
      entry.track &&
      (cleanMatchText(bulkTop.trackName) ||
        bulkTop.trackName.trim().toLowerCase()) !==
        (cleanMatchText(entry.track) || entry.track.trim().toLowerCase())
    ) {
      eligible.push({
        candidate: c,
        refreshBucket: 1,
        alreadyHasValidHit: true
      });
      continue;
    }

    if (
      c.isCurrentYear &&
      (!c.id || !bulkTopTracks.has(c.id)) &&
      now - entry.resolvedAt > CURRENT_YEAR_REFRESH_TTL_MS
    ) {
      eligible.push({
        candidate: c,
        refreshBucket: 2,
        alreadyHasValidHit: true
      });
    }
  }

  eligible.sort((a, b) => {
    if (a.refreshBucket !== b.refreshBucket) {
      return a.refreshBucket - b.refreshBucket;
    }
    return compareCandidates(a.candidate, b.candidate);
  });

  const limit = parseEnvInt('PREVIEW_RESOLVE_LIMIT', 10, true);
  const budgetMs = parseEnvInt('PREVIEW_RESOLVE_BUDGET_MS', 18000);
  const delayMs = parseEnvInt('PREVIEW_REQUEST_DELAY_MS', 1500);
  const appleWebDelayMs = parseEnvInt('PREVIEW_APPLE_WEB_DELAY_MS', 450);
  const startedAt = Date.now();
  const appleWebClient = createAppleMusicWebClient(
    budgetMs,
    appleWebDelayMs,
    startedAt
  );
  const itunesClient = createPacedItunesClient(budgetMs, delayMs, startedAt);

  const toResolve = eligible.slice(0, limit);
  let resolvedHits = 0;
  let recordedMisses = 0;

  for (let i = 0; i < toResolve.length; i += CHUNK_SIZE) {
    if (!appleWebClient.hasBudget() && !itunesClient.hasBudget()) break;
    const chunk = toResolve.slice(i, i + CHUNK_SIZE);

    // Phase A: resolve preferred tracks (from bulk map or per-album stats.fm fallback)
    const trackMeta = await Promise.all(
      chunk.map(async (item) => {
        const alb = item.candidate;
        const bulk = alb.id ? bulkTopTracks.get(alb.id) : undefined;
        if (bulk) {
          return {
            preferredTrack: bulk.trackName,
            spotifyPreview: bulk.spotifyPreview
          };
        }
        const perAlb = await fetchPerAlbumStatsFmTrack(username, alb);
        return {
          preferredTrack: perAlb.trackName,
          spotifyPreview: perAlb.spotifyPreview
        };
      })
    );

    interface ChunkState {
      item: EligibleItem;
      preferredTrack: string;
      spotifyPreview?: string;
      collectionId?: number;
      collectionName?: string;
      resolved: boolean;
      appleTransientError: boolean;
      itunesTransientError: boolean;
    }

    const states: ChunkState[] = chunk.map((item, idx) => ({
      item,
      preferredTrack: trackMeta[idx].preferredTrack,
      spotifyPreview: trackMeta[idx].spotifyPreview,
      resolved: false,
      appleTransientError: false,
      itunesTransientError: false
    }));

    // Phase A.5 (Primary): Apple Music Web HTML resolution for uncensored .ep.m4a explicit previews
    for (const st of states) {
      if (!appleWebClient.hasBudget()) {
        st.appleTransientError = true;
        continue;
      }
      const alb = st.item.candidate;
      const webRes = await appleWebClient.resolveAlbum(alb, st.preferredTrack);
      if (webRes.status === 'hit' && webRes.url) {
        diskCache.entries[alb.key] = {
          status: 'hit',
          url: webRes.url,
          track: webRes.track || st.preferredTrack || undefined,
          resolvedAt: now,
          lastSeenAt: now
        };
        st.resolved = true;
        resolvedHits++;
        cacheChanged = true;
      } else if (webRes.transientError) {
        st.appleTransientError = true;
      }
    }

    // Phase B (Fallback): search iTunes albums cleanly within paced budget for unresolved items
    for (const st of states) {
      if (st.resolved) continue;
      if (!itunesClient.hasBudget()) {
        st.itunesTransientError = true;
        continue;
      }
      const alb = st.item.candidate;
      const res = await itunesClient.fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(`${alb.title} ${alb.primaryArtist}`)}&entity=album&limit=10`
      );
      if (res.transientError || res.rateLimited) {
        st.itunesTransientError = true;
        continue;
      }
      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      const matchingCols = results
        .filter(
          (c: any) =>
            c.collectionId &&
            matchesArtistName(c.artistName, alb.artist, alb.primaryArtist) &&
            matchesAlbumTitle(c.collectionName, alb.title)
        )
        .sort(
          (a: any, b: any) =>
            getAlternatePenalty('', a.collectionName, a.artistName, alb.title) -
            getAlternatePenalty('', b.collectionName, b.artistName, alb.title)
        );

      if (matchingCols.length > 0) {
        st.collectionId = Number(matchingCols[0].collectionId);
        st.collectionName = matchingCols[0].collectionName || alb.title;
      }
    }

    // Phase C: batched iTunes lookup for unresolved items with matched collectionIds
    const colIds = Array.from(
      new Set(
        states
          .filter((s) => !s.resolved && s.collectionId)
          .map((s) => s.collectionId as number)
      )
    );

    if (colIds.length > 0 && itunesClient.hasBudget()) {
      const lookupRes = await itunesClient.fetchJson(
        `https://itunes.apple.com/lookup?id=${colIds.join(',')}&entity=song`
      );

      if (lookupRes.transientError || lookupRes.rateLimited) {
        for (const st of states) {
          if (!st.resolved && st.collectionId) st.itunesTransientError = true;
        }
      } else if (lookupRes.ok) {
        const tracksByCol = new Map<number, any[]>();
        for (const row of lookupRes.data?.results || []) {
          if (row?.wrapperType !== 'track' || !row?.previewUrl) continue;
          const cid = Number(row.collectionId);
          if (!cid) continue;
          const list = tracksByCol.get(cid);
          if (list) list.push(row);
          else tracksByCol.set(cid, [row]);
        }

        for (const st of states) {
          if (st.resolved || !st.collectionId) continue;
          const tracks = tracksByCol.get(st.collectionId);
          if (!tracks?.length) continue;

          const alb = st.item.candidate;
          const allowedContext = `${alb.title} ${st.preferredTrack}`.trim();
          const scored = tracks
            .map((t: any) => ({
              track: t,
              score: scoreTrackMatch(
                t.trackName,
                st.collectionName || alb.title,
                t.artistName || alb.artist,
                st.preferredTrack,
                alb.title,
                allowedContext
              )
            }))
            .sort((a, b) => b.score - a.score);

          const best = scored[0];
          if (best && best.score > 0 && best.track?.previewUrl) {
            diskCache.entries[alb.key] = {
              status: 'hit',
              url: best.track.previewUrl,
              track: st.preferredTrack || best.track.trackName || undefined,
              resolvedAt: now,
              lastSeenAt: now
            };
            st.resolved = true;
            resolvedHits++;
            cacheChanged = true;
          }
        }
      }
    }

    // Phase D: scoped song fallback (or spotifyPreview / clean negative miss)
    for (const st of states) {
      if (st.resolved || st.itunesTransientError) continue;
      if (!itunesClient.hasBudget()) break;

      const alb = st.item.candidate;
      const baseAlbumTitle = getBaseTitle(alb.title) || alb.title;
      const cleanPrefTrack = getBaseTitle(st.preferredTrack);
      const allowedContext = `${alb.title} ${st.preferredTrack}`.trim();

      const songQuery = cleanPrefTrack
        ? `${cleanPrefTrack} ${alb.primaryArtist} ${baseAlbumTitle}`
        : `${baseAlbumTitle} ${alb.primaryArtist}`;

      const songRes = await itunesClient.fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(songQuery)}&entity=song&limit=15`
      );
      if (songRes.transientError || songRes.rateLimited) {
        continue;
      }

      const songResults = Array.isArray(songRes.data?.results)
        ? songRes.data.results
        : [];
      const scoredSongs = songResults
        .filter(
          (s: any) =>
            s.previewUrl &&
            matchesArtistName(s.artistName, alb.artist, alb.primaryArtist)
        )
        .map((s: any) => ({
          song: s,
          score: scoreScopedSongCandidate(
            s,
            st.preferredTrack,
            alb.title,
            allowedContext
          )
        }))
        .sort((a: any, b: any) => b.score - a.score);

      if (scoredSongs.length > 0 && scoredSongs[0].score > 25) {
        const best = scoredSongs[0].song;
        diskCache.entries[alb.key] = {
          status: 'hit',
          url: best.previewUrl,
          track: st.preferredTrack || best.trackName || undefined,
          resolvedAt: now,
          lastSeenAt: now
        };
        resolvedHits++;
        cacheChanged = true;
        continue;
      }

      if (st.spotifyPreview) {
        diskCache.entries[alb.key] = {
          status: 'hit',
          url: st.spotifyPreview,
          track: st.preferredTrack || undefined,
          resolvedAt: now,
          lastSeenAt: now
        };
        resolvedHits++;
        cacheChanged = true;
        continue;
      }

      if (
        !st.item.alreadyHasValidHit &&
        !st.appleTransientError &&
        !appleWebClient.isTripped() &&
        !itunesClient.isTripped()
      ) {
        diskCache.entries[alb.key] = {
          status: 'miss',
          resolvedAt: now,
          lastSeenAt: now
        };
        recordedMisses++;
        cacheChanged = true;
      }
    }
  }

  if (cacheChanged) {
    saveDiskCache(diskCache);
  }

  const manifestHits = writeBrowserManifest(diskCache.entries, activeKeys);
  const trippedSources = [
    appleWebClient.isTripped() ? 'Apple Music Web' : '',
    itunesClient.isTripped() ? 'iTunes' : ''
  ].filter(Boolean);
  const circuitNote =
    trippedSources.length > 0
      ? `; rate-limit circuit breaker tripped (${trippedSources.join(', ')})`
      : '';
  const extraNotes = [
    resolvedHits > 0 ? `+${resolvedHits} resolved` : '',
    seededCount > 0 ? `+${seededCount} from Overview` : '',
    recordedMisses > 0 ? `${recordedMisses} negative misses` : '',
    prunedCount > 0 ? `pruned ${prunedCount}` : ''
  ]
    .filter(Boolean)
    .join(', ');

  logger?.info(
    `Built music preview manifest: ${manifestHits}/${candidates.length} cached${extraNotes ? ` (${extraNotes})` : ''}${circuitNote}.`
  );
}
