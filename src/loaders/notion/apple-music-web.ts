import {
  cleanMatchText,
  getAlternatePenalty,
  getBaseTitle,
  matchesAlbumTitle,
  matchesArtistName,
  scoreTrackMatch
} from '../../utils/audio-preview-matching';

const APPLE_WEB_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

interface SearchAlbumCandidate {
  id: string;
  title: string;
  artist: string;
  urlPath: string;
  isExplicit: boolean;
}

export interface AppleWebResolveResult {
  status: 'hit' | 'miss';
  url?: string;
  track?: string;
  transientError: boolean;
}

function extractSerializedServerData(html: string): any | null {
  const match = html.match(
    /<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function slugToTitle(urlPath: string): string {
  const match = urlPath.match(/\/us\/album\/([^/?#]+)\/\d+/);
  if (!match) return '';
  let decoded = match[1];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Use raw slug on malformed URI sequences
  }
  return decoded.replace(/-/g, ' ').trim();
}

function extractArtistFromSubtitle(subtitle?: string): string {
  const trimmed = (subtitle || '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[\s\u00a0\u202f]*[·•][\s\u00a0\u202f]*/);
  if (parts.length >= 2) {
    return parts.slice(1).join(', ').trim();
  }
  if (/^(album|single|ep|compilation)\b/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeAlbumPath(rawUrl: string): {
  id: string;
  urlPath: string;
} | null {
  if (!rawUrl || rawUrl.includes('?i=')) return null;
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl, 'https://music.apple.com').pathname;
  } catch {
    pathname = rawUrl.split('?')[0];
  }
  const match = pathname.match(/(\/us\/album\/[^/?#]+\/(\d+))/);
  if (!match) return null;
  return { urlPath: match[1], id: match[2] };
}

function extractSearchAlbums(json: any): SearchAlbumCandidate[] {
  const sections = json?.data?.[0]?.data?.sections;
  if (!Array.isArray(sections)) return [];

  const byId = new Map<string, SearchAlbumCandidate>();

  const upsert = (cand: SearchAlbumCandidate) => {
    const existing = byId.get(cand.id);
    if (!existing) {
      byId.set(cand.id, cand);
      return;
    }
    byId.set(cand.id, {
      id: cand.id,
      title:
        cand.title.length > existing.title.length ? cand.title : existing.title,
      artist:
        cand.artist.length > existing.artist.length
          ? cand.artist
          : existing.artist,
      urlPath: existing.urlPath,
      isExplicit: existing.isExplicit || cand.isExplicit
    });
  };

  for (const sec of sections) {
    const items = Array.isArray(sec?.items) ? sec.items : [];
    const kind = sec?.itemKind;
    const secId = String(sec?.id || '');

    if (
      kind !== 'topSearchLockup' &&
      !(kind === 'squareLockup' && secId.includes('album'))
    ) {
      continue;
    }

    for (const item of items) {
      if (
        kind === 'topSearchLockup' &&
        item?.contentDescriptor?.kind &&
        item.contentDescriptor.kind !== 'album'
      ) {
        continue;
      }

      const rawUrl = item?.contentDescriptor?.url || '';
      const norm = normalizeAlbumPath(rawUrl);
      if (!norm) continue;

      const title =
        (item?.title || item?.titleLinks?.[0]?.title || '').trim() ||
        slugToTitle(norm.urlPath);
      const artistFromLinks = Array.isArray(item?.subtitleLinks)
        ? item.subtitleLinks
            .map((l: any) => (l?.title || '').trim())
            .filter(Boolean)
            .join(', ')
        : '';
      const artist =
        artistFromLinks || extractArtistFromSubtitle(item?.subtitle) || '';

      if (!title || !artist) continue;

      upsert({
        id: norm.id,
        title,
        artist,
        urlPath: norm.urlPath,
        isExplicit: Boolean(item?.showExplicitBadge)
      });
    }
  }

  return Array.from(byId.values());
}

/**
 * Creates a paced, circuit-broken Apple Music Web (`music.apple.com`) HTML
 * client for build-time preview resolution, returning uncensored `.ep.m4a`
 * explicit previews when available.
 */
export function createAppleMusicWebClient(
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

  const fetchServerData = async (
    url: string
  ): Promise<{ json: any | null; transientError: boolean }> => {
    if (!hasBudget()) {
      return { json: null, transientError: true };
    }

    const elapsedSinceLast = Date.now() - lastReqAt;
    if (lastReqAt > 0 && elapsedSinceLast < delayMs) {
      const waitMs = delayMs - elapsedSinceLast;
      if (Date.now() + waitMs - startedAt >= budgetMs) {
        return { json: null, transientError: true };
      }
      await sleep(waitMs);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!hasBudget()) {
        return { json: null, transientError: true };
      }

      lastReqAt = Date.now();
      try {
        const res = await fetch(url, {
          headers: APPLE_WEB_HEADERS,
          signal: AbortSignal.timeout(6000)
        });

        if (res.status === 429 || res.status === 403) {
          consecutiveRateLimits++;
          if (attempt === 0 && consecutiveRateLimits < 2) {
            const retryWaitMs = 2000;
            if (Date.now() + retryWaitMs - startedAt < budgetMs) {
              await sleep(retryWaitMs);
              continue;
            }
          }
          circuitTripped = true;
          return { json: null, transientError: true };
        }

        if (!res.ok) {
          consecutiveRateLimits = 0;
          return { json: null, transientError: res.status >= 500 };
        }

        consecutiveRateLimits = 0;
        const html = await res.text();
        const json = extractSerializedServerData(html);
        if (!json) {
          return { json: null, transientError: true };
        }
        return { json, transientError: false };
      } catch {
        return { json: null, transientError: true };
      }
    }

    return { json: null, transientError: true };
  };

  const resolveAlbum = async (
    alb: { title: string; artist: string; primaryArtist: string },
    preferredTrack: string
  ): Promise<AppleWebResolveResult> => {
    const baseTitle = getBaseTitle(alb.title) || alb.title;
    const searchQueries = [`${alb.title} ${alb.primaryArtist}`.trim()];
    if (cleanMatchText(baseTitle) !== cleanMatchText(alb.title)) {
      searchQueries.push(`${baseTitle} ${alb.primaryArtist}`.trim());
    }

    let candidates: SearchAlbumCandidate[] = [];
    let searchTransient = false;

    for (const query of searchQueries) {
      if (!hasBudget()) {
        searchTransient = true;
        break;
      }
      const searchUrl = `https://music.apple.com/us/search?term=${encodeURIComponent(query)}`;
      const searchRes = await fetchServerData(searchUrl);
      if (!searchRes.json) {
        if (searchRes.transientError) searchTransient = true;
        continue;
      }

      candidates = extractSearchAlbums(searchRes.json).filter(
        (cand) =>
          matchesArtistName(cand.artist, alb.artist, alb.primaryArtist) &&
          matchesAlbumTitle(cand.title, alb.title)
      );
      if (candidates.length > 0) break;
    }

    if (candidates.length === 0) {
      return { status: 'miss', transientError: searchTransient };
    }

    const targetCleanTitle = cleanMatchText(alb.title);
    candidates.sort((a, b) => {
      const penDiff =
        getAlternatePenalty('', a.title, a.artist, alb.title) -
        getAlternatePenalty('', b.title, b.artist, alb.title);
      if (penDiff !== 0) return penDiff;

      if (a.isExplicit !== b.isExplicit) {
        return a.isExplicit ? -1 : 1;
      }

      const aExact = cleanMatchText(a.title) === targetCleanTitle ? 1 : 0;
      const bExact = cleanMatchText(b.title) === targetCleanTitle ? 1 : 0;
      return bExact - aExact;
    });

    let sawTransient = false;
    const allowedContext = `${alb.title} ${preferredTrack}`.trim();
    let bestOverall: { url: string; track?: string; score: number } | null =
      null;

    for (const cand of candidates.slice(0, 3)) {
      if (!hasBudget()) {
        sawTransient = true;
        break;
      }

      const albumUrl = `https://music.apple.com${cand.urlPath}`;
      const albRes = await fetchServerData(albumUrl);
      if (!albRes.json) {
        if (albRes.transientError) sawTransient = true;
        continue;
      }

      const secs = albRes.json?.data?.[0]?.data?.sections;
      if (!Array.isArray(secs)) {
        sawTransient = true;
        continue;
      }

      const headerItem = secs.find(
        (s: any) => s?.itemKind === 'containerDetailHeaderLockup'
      )?.items?.[0];
      const headerArtist = Array.isArray(headerItem?.subtitleLinks)
        ? headerItem.subtitleLinks
            .map((l: any) => (l?.title || '').trim())
            .filter(Boolean)
            .join(', ')
        : cand.artist;
      const headerTitle = (headerItem?.title || cand.title || alb.title).trim();

      if (
        !matchesArtistName(headerArtist, alb.artist, alb.primaryArtist) ||
        !matchesAlbumTitle(headerTitle, alb.title)
      ) {
        continue;
      }

      const tracks = secs
        .filter((s: any) => s?.itemKind === 'trackLockup')
        .flatMap((s: any) => (Array.isArray(s?.items) ? s.items : []))
        .filter((t: any) => typeof t?.previewUrl === 'string' && t.previewUrl);

      if (tracks.length === 0) continue;

      const scored = tracks
        .map((t: any) => {
          const baseScore = scoreTrackMatch(
            t.title || '',
            headerTitle,
            t.artistName || headerArtist,
            preferredTrack,
            alb.title,
            allowedContext
          );
          const explicitBonus =
            t.showExplicitBadge || String(t.previewUrl).includes('.ep.m4a')
              ? 15
              : 0;
          return {
            track: t,
            baseScore,
            score: baseScore + explicitBonus
          };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best && best.score > 0 && best.track?.previewUrl) {
        const candResult = {
          url: best.track.previewUrl,
          track: preferredTrack || best.track.title || undefined,
          score: best.score
        };
        if (!bestOverall || candResult.score > bestOverall.score) {
          bestOverall = candResult;
        }
        if (!preferredTrack || best.baseScore >= 65) {
          return {
            status: 'hit',
            url: candResult.url,
            track: candResult.track,
            transientError: false
          };
        }
      }
    }

    if (bestOverall) {
      return {
        status: 'hit',
        url: bestOverall.url,
        track: bestOverall.track,
        transientError: false
      };
    }

    return { status: 'miss', transientError: sawTransient };
  };

  return {
    hasBudget,
    isTripped: () => circuitTripped,
    resolveAlbum
  };
}
