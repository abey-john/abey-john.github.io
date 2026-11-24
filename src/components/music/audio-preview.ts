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
  type AudioPreviewTarget
} from '../../utils/audio-preview-matching';

export {
  cleanMatchText,
  extractPrimaryArtist,
  getAlternatePenalty,
  getBaseTitle,
  getPreviewCacheKey,
  matchesAlbumTitle,
  matchesArtistName,
  scoreTrackMatch,
  type AudioPreviewTarget
};

export interface TrackPreviewTarget {
  id?: string | number;
  title: string;
  artist: string;
  album?: string;
  fallbackSpotifyPreview?: string | null;
}

export interface ResolveAlbumPreviewOptions {
  bypassCache?: boolean;
}

const MANIFEST_URL = '/assets/notion/music-previews.json';
const LS_CACHE_KEY = 'eebo:music-previews:v1';
const LS_MAX_ENTRIES = 600;
const LS_TTL_MS = 30 * 86_400_000;

interface LocalPreviewEntry {
  u: string;
  t: number;
}

const previewUrlCache = new Map<string, string>();
const manifestUrlCache = new Map<string, string>();
let manifestPromise: Promise<void> | null = null;
let manifestLoaded = false;

function readLocalStorageMap(): Record<string, LocalPreviewEntry> {
  try {
    const raw = globalThis.localStorage?.getItem(LS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalStorageMap(map: Record<string, LocalPreviewEntry>): void {
  try {
    globalThis.localStorage?.setItem(LS_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota / private-browsing errors
  }
}

function getLocalCachedPreview(cacheKey: string): string | null {
  const map = readLocalStorageMap();
  const entry = map[cacheKey];
  if (!entry?.u || typeof entry.t !== 'number') return null;
  if (Date.now() - entry.t > LS_TTL_MS) {
    delete map[cacheKey];
    writeLocalStorageMap(map);
    return null;
  }
  return entry.u;
}

function setLocalCachedPreview(cacheKey: string, url: string): void {
  const map = readLocalStorageMap();
  const now = Date.now();
  for (const [k, v] of Object.entries(map)) {
    if (!v?.u || typeof v.t !== 'number' || now - v.t > LS_TTL_MS) {
      delete map[k];
    }
  }
  map[cacheKey] = { u: url, t: now };
  const keys = Object.keys(map);
  if (keys.length > LS_MAX_ENTRIES) {
    keys.sort((a, b) => map[a].t - map[b].t);
    const excess = keys.length - LS_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete map[keys[i]];
    }
  }
  writeLocalStorageMap(map);
}

/**
 * Lazy-fetches the build-time preview URL manifest once and caches it in memory.
 */
export function preloadPreviewManifest(): Promise<void> {
  if (manifestLoaded) return Promise.resolve();
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetch(MANIFEST_URL, { credentials: 'same-origin' });
        if (res.ok) {
          const data = (await res.json()) as Record<string, string>;
          if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              if (typeof v === 'string' && v) {
                manifestUrlCache.set(k, v);
              }
            }
          }
        }
      } catch {
        // Fall back seamlessly to live client resolution
      } finally {
        manifestLoaded = true;
      }
    })();
  }
  return manifestPromise;
}

/**
 * Clears cached preview URLs for an album across memory, manifest, and localStorage
 * so a failed/stale audio playback can self-heal with a fresh live lookup.
 */
export function invalidateCachedAlbumPreview(alb: AudioPreviewTarget): void {
  const keys = [
    getPreviewCacheKey(alb),
    getNormalizedAlbumArtistKey(alb.title, alb.artist)
  ];
  for (const k of keys) {
    previewUrlCache.delete(k);
    manifestUrlCache.delete(k);
  }
  const map = readLocalStorageMap();
  let changed = false;
  for (const k of keys) {
    if (k in map) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) {
    writeLocalStorageMap(map);
  }
}

async function awaitManifestBounded(signal?: AbortSignal): Promise<void> {
  if (manifestLoaded) return;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  let timerId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      preloadPreviewManifest(),
      new Promise<void>((resolve, reject) => {
        timerId = globalThis.setTimeout(resolve, 1500);
        if (signal) {
          onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })
    ]);
  } finally {
    if (timerId !== undefined) globalThis.clearTimeout(timerId);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function raceWithCap<T>(
  promise: Promise<T>,
  fallback: T,
  capMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  let timerId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timerId = globalThis.setTimeout(() => resolve(fallback), capMs);
        if (signal) {
          onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })
    ]);
  } finally {
    if (timerId !== undefined) globalThis.clearTimeout(timerId);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

async function fetchItunesJson(
  url: string,
  signal?: AbortSignal,
  retryBudget?: { left: number }
): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { signal });
    if (res.status === 403 || res.status === 429) {
      if (retryBudget && retryBudget.left > 0) {
        retryBudget.left--;
        await sleepWithAbort(500, signal);
        continue;
      }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  }
  return null;
}

export function getMediumThumbUrl(url: string): string {
  if (url.includes('i.scdn.co/image/ab67616d0000b273')) {
    return url.replace('ab67616d0000b273', 'ab67616d00001e02');
  }
  return url;
}

async function searchItunesSongPreview(
  songQueries: string[],
  artist: string,
  albumTitle: string,
  targetTrackName: string,
  allowedContext: string,
  signal?: AbortSignal,
  explicitPrimary?: string,
  retryBudget?: { left: number }
): Promise<string | null> {
  let bestAcrossQueries: { url: string; score: number } | null = null;

  for (const sq of songQueries) {
    const songJson = await fetchItunesJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(sq)}&entity=song&limit=20`,
      signal,
      retryBudget
    );
    if (!songJson) continue;
    const candidates = (songJson.results || []).filter(
      (s: any) =>
        s.previewUrl && matchesArtistName(s.artistName, artist, explicitPrimary)
    );

    const scoredSongs = candidates
      .map((s: any) => ({
        song: s,
        score: scoreScopedSongCandidate(
          s,
          targetTrackName,
          albumTitle,
          allowedContext
        )
      }))
      .sort((a: any, b: any) => b.score - a.score);

    if (scoredSongs.length > 0 && scoredSongs[0].score > 25) {
      const top = scoredSongs[0];
      if (!bestAcrossQueries || top.score > bestAcrossQueries.score) {
        bestAcrossQueries = { url: top.song.previewUrl, score: top.score };
      }
      if (!targetTrackName || top.score >= 130) {
        return top.song.previewUrl;
      }
    }
  }
  return bestAcrossQueries ? bestAcrossQueries.url : null;
}

export async function resolveTrackPreview(
  track: TrackPreviewTarget,
  signal?: AbortSignal
): Promise<string | null> {
  const cacheKey = `track:${cleanMatchText(track.title)}:::${cleanMatchText(track.artist)}:::${cleanMatchText(track.album || '')}`;
  const cached = previewUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const primaryArtist = extractPrimaryArtist(track.artist);
  const baseTrack = getBaseTitle(track.title) || track.title;
  const baseAlbum = track.album ? getBaseTitle(track.album) || track.album : '';
  const allowedContext = `${track.title} ${track.album || ''}`.trim();
  const retryBudget = { left: 1 };

  const songQueries = [
    ...(baseAlbum ? [`${baseTrack} ${primaryArtist} ${baseAlbum}`] : []),
    `${baseTrack} ${primaryArtist}`,
    ...(track.title !== baseTrack ? [`${track.title} ${primaryArtist}`] : [])
  ];

  try {
    const url = await searchItunesSongPreview(
      songQueries,
      track.artist,
      track.album || '',
      track.title,
      allowedContext,
      signal,
      undefined,
      retryBudget
    );
    if (url) {
      previewUrlCache.set(cacheKey, url);
      return url;
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  if (track.fallbackSpotifyPreview) {
    previewUrlCache.set(cacheKey, track.fallbackSpotifyPreview);
    return track.fallbackSpotifyPreview;
  }

  return null;
}

async function fetchStatsFmPreferredTrack(
  alb: AudioPreviewTarget,
  username: string,
  signal: AbortSignal
): Promise<{ trackName: string; spotifyPreview: string | null }> {
  if (!alb.id) {
    return { trackName: '', spotifyPreview: null };
  }

  try {
    const userTracksRes = await fetch(
      `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/top/albums/${alb.id}/tracks`,
      { signal }
    ).catch((err) => {
      if (err?.name === 'AbortError') throw err;
      return null;
    });

    if (userTracksRes?.ok) {
      const userData = await userTracksRes.json();
      const userItems = Array.isArray(userData.items) ? userData.items : [];
      if (userItems.length > 0) {
        const picked = pickPreferredStatsFmTrack(
          userItems,
          alb.title,
          alb.artist
        );
        return {
          trackName: picked.trackName,
          spotifyPreview: picked.spotifyPreview || null
        };
      }
    }

    const albumTracksRes = await fetch(
      `https://api.stats.fm/api/v1/albums/${alb.id}/tracks`,
      { signal }
    ).catch((err) => {
      if (err?.name === 'AbortError') throw err;
      return null;
    });

    if (albumTracksRes?.ok) {
      const albData = await albumTracksRes.json();
      const albTracks = Array.isArray(albData.items) ? albData.items : [];
      if (albTracks.length > 0) {
        const mapped = albTracks.map((trk: any) => ({ track: trk }));
        const picked = pickPreferredStatsFmTrack(mapped, alb.title, alb.artist);
        return {
          trackName: picked.trackName,
          spotifyPreview: null
        };
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  return { trackName: '', spotifyPreview: null };
}

export async function resolveAlbumPreview(
  alb: AudioPreviewTarget,
  signal: AbortSignal,
  username = 'itseebo',
  options?: ResolveAlbumPreviewOptions
): Promise<string | null> {
  const cacheKey = getPreviewCacheKey(alb);
  const normKey = getNormalizedAlbumArtistKey(alb.title, alb.artist);

  if (!options?.bypassCache) {
    const cached = previewUrlCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    await awaitManifestBounded(signal);
    const manifestHit =
      manifestUrlCache.get(cacheKey) || manifestUrlCache.get(normKey);
    if (manifestHit) {
      previewUrlCache.set(cacheKey, manifestHit);
      return manifestHit;
    }

    const localHit = getLocalCachedPreview(cacheKey);
    if (localHit) {
      previewUrlCache.set(cacheKey, localHit);
      return localHit;
    }
  }

  const primaryArtist = extractPrimaryArtist(alb.artist, alb.primaryArtist);
  const baseAlbumTitle = getBaseTitle(alb.title) || alb.title;
  const retryBudget = { left: 2 };

  const rememberHit = (url: string) => {
    previewUrlCache.set(cacheKey, url);
    setLocalCachedPreview(cacheKey, url);
    return url;
  };

  // Fire stats.fm top-track lookup in parallel with the primary iTunes album search
  const statsFmPromise = fetchStatsFmPreferredTrack(alb, username, signal);
  const primarySearchPromise = fetchItunesJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(`${alb.title} ${primaryArtist}`)}&entity=album&limit=10`,
    signal,
    retryBudget
  );

  const albumQueries = [
    `${alb.title} ${primaryArtist}`,
    ...(baseAlbumTitle !== alb.title
      ? [`${baseAlbumTitle} ${primaryArtist}`]
      : [])
  ];

  let bestFallback: { url: string; score: number } | null = null;

  try {
    for (let qIdx = 0; qIdx < albumQueries.length; qIdx++) {
      const albJson =
        qIdx === 0
          ? await primarySearchPromise
          : await fetchItunesJson(
              `https://itunes.apple.com/search?term=${encodeURIComponent(albumQueries[qIdx])}&entity=album&limit=10`,
              signal,
              retryBudget
            );

      if (!albJson) continue;
      const matchingCollections = (albJson.results || []).filter(
        (c: any) =>
          c.collectionId &&
          matchesArtistName(c.artistName, alb.artist, alb.primaryArtist) &&
          matchesAlbumTitle(c.collectionName, alb.title)
      );

      matchingCollections.sort(
        (a: any, b: any) =>
          getAlternatePenalty('', a.collectionName, a.artistName, alb.title) -
          getAlternatePenalty('', b.collectionName, b.artistName, alb.title)
      );

      for (const col of matchingCollections.slice(0, 3)) {
        const lookupJson = await fetchItunesJson(
          `https://itunes.apple.com/lookup?id=${col.collectionId}&entity=song`,
          signal,
          retryBudget
        );
        if (!lookupJson) continue;
        const tracks = (lookupJson.results || []).filter(
          (t: any) => t.wrapperType === 'track' && t.previewUrl
        );
        if (tracks.length > 0) {
          // Cap waiting for slow stats.fm track preference once album tracks are already ready
          const statsMeta = await raceWithCap(
            statsFmPromise,
            { trackName: '', spotifyPreview: null },
            800,
            signal
          );
          const preferredTrackName = statsMeta.trackName;
          const allowedContext = `${alb.title} ${preferredTrackName}`;

          const scoredTracks = tracks
            .map((t: any) => ({
              track: t,
              score: scoreTrackMatch(
                t.trackName,
                col.collectionName || alb.title,
                t.artistName || alb.artist,
                preferredTrackName,
                alb.title,
                allowedContext
              )
            }))
            .sort((a: any, b: any) => b.score - a.score);

          const best = scoredTracks[0];
          if (best && best.score > 0 && best.track?.previewUrl) {
            if (!preferredTrackName || best.score >= 65) {
              return rememberHit(best.track.previewUrl);
            }
            if (!bestFallback || best.score > bestFallback.score) {
              bestFallback = {
                url: best.track.previewUrl,
                score: best.score
              };
            }
          }
        }
      }
    }

    const statsMeta = await raceWithCap(
      statsFmPromise,
      { trackName: '', spotifyPreview: null },
      1200,
      signal
    );
    const preferredTrackName = statsMeta.trackName;
    const allowedContext = `${alb.title} ${preferredTrackName}`;
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

    const fallbackUrl = await searchItunesSongPreview(
      songQueries,
      alb.artist,
      alb.title,
      preferredTrackName,
      allowedContext,
      signal,
      alb.primaryArtist,
      retryBudget
    );
    if (fallbackUrl) {
      return rememberHit(fallbackUrl);
    }

    if (bestFallback) {
      return rememberHit(bestFallback.url);
    }

    if (statsMeta.spotifyPreview) {
      return rememberHit(statsMeta.spotifyPreview);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  try {
    const lateStats = await raceWithCap(
      statsFmPromise,
      { trackName: '', spotifyPreview: null },
      400,
      signal
    );
    if (lateStats.spotifyPreview) {
      return rememberHit(lateStats.spotifyPreview);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  return null;
}
