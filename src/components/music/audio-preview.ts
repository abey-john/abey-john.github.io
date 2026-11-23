export interface AudioPreviewTarget {
  id?: number;
  title: string;
  artist: string;
  primaryArtist?: string;
}

export interface TrackPreviewTarget {
  id?: string | number;
  title: string;
  artist: string;
  album?: string;
  fallbackSpotifyPreview?: string | null;
}

const previewUrlCache = new Map<string, string>();

const COMMA_ARTIST_PREFIX =
  /^(tyler,\s*the creator|black country,\s*new road|earth,\s*wind\s*&\s*fire|crosby,\s*stills,\s*nash(?:\s*&\s*young)?|emerson,\s*lake\s*&\s*palmer|peter,\s*paul\s*and\s*mary|blood,\s*sweat\s*&\s*tears)/i;

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

export function cleanMatchText(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    .replace(/[ø]/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function extractPrimaryArtist(
  artist: string,
  explicitPrimary?: string
): string {
  if (explicitPrimary?.trim()) {
    return explicitPrimary.trim();
  }
  const trimmed = (artist || '').trim();
  const known = trimmed.match(COMMA_ARTIST_PREFIX);
  if (known) {
    return known[1];
  }
  return trimmed.split(',')[0].trim();
}

export function matchesArtistName(
  itemArtist: string,
  targetArtist: string,
  explicitPrimary?: string
): boolean {
  const ia = cleanMatchText(itemArtist);
  const primaryTarget = cleanMatchText(
    extractPrimaryArtist(targetArtist, explicitPrimary)
  );
  const fullTarget = cleanMatchText(targetArtist);
  if (!ia || !primaryTarget) return false;
  return (
    ia.includes(primaryTarget) ||
    primaryTarget.includes(ia) ||
    (fullTarget.length > 0 && ia.includes(fullTarget))
  );
}

export function matchesAlbumTitle(
  itemAlbum: string,
  targetAlbum: string
): boolean {
  const rawBaseItem = getBaseTitle(itemAlbum).toLowerCase();
  const rawBaseTarget = getBaseTitle(targetAlbum).toLowerCase();
  const taBase = cleanMatchText(rawBaseTarget);

  // Handle symbol-only album titles like Ed Sheeran's "÷", "+", "=", "-"
  if (!taBase && rawBaseTarget) {
    return rawBaseItem === rawBaseTarget;
  }

  const ia = cleanMatchText(itemAlbum);
  const ta = cleanMatchText(targetAlbum);
  if (!ia || !ta) return false;
  const baseTarget = cleanMatchText(rawBaseTarget);
  const baseItem = cleanMatchText(rawBaseItem);

  if (ia === ta || (baseItem.length >= 1 && baseItem === baseTarget)) {
    return true;
  }
  if (
    Math.min(ia.length, ta.length) >= 3 &&
    (ia.includes(ta) || ta.includes(ia))
  ) {
    return true;
  }
  if (
    baseTarget.length >= 3 &&
    baseItem.length >= 3 &&
    (baseItem.includes(baseTarget) || baseTarget.includes(baseItem))
  ) {
    return true;
  }
  return false;
}

export function getBaseTitle(str: string): string {
  const stripped = (str || '')
    .replace(
      /\s*[-–—(\[]\s*(feat\.?|ft\.?|with\s|remaster|deluxe|bonus|explicit|clean|version|edition|stereo|mono|expanded|anniversary|special|standard|complete|original)[^)\]]*[)\]]?/gi,
      ''
    )
    .trim();
  if (!stripped) return '';
  if (stripped.startsWith('(') || stripped.startsWith('[')) {
    return stripped.split(/\s+[-–—:]\s+/)[0].trim() || stripped;
  }
  return stripped.split(/[:(\[\-–—]/)[0].trim() || stripped;
}

export function getAlternatePenalty(
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

  // Heavy penalty for Broadway / musical cast recordings unless expected by context
  if (
    /\b(broadway|cast recording|original cast|musical cast|motion picture cast)\b/.test(
      `${trk} ${col} ${art}`
    ) &&
    !/\b(broadway|cast|musical|soundtrack)\b/.test(ctx)
  ) {
    penalty += 220;
  }

  // Penalize remixes, DJ mixes, covers, genre-qualified remixes, sped-up/slowed, instrumentals, commentary unless expected
  const remixChecks: Array<[RegExp, number]> = [
    [
      /\b(cover|covers|piano version|guitar version|orchestral version|(?:edm|dubstep|hardstyle|techno|trance|lofi|lo-fi)\s+(?:remix|mix|version|edit|cover))\b/,
      140
    ],
    [/\b(remix|remixes|re-mix|megamix|club mix|vip mix|dub mix)\b/, 130],
    [/\b(sped up|slowed|chopped|screwed|nightcore)\b/, 130],
    [/\b(instrumental|acapella|a cappella|karaoke|commentary)\b/, 120],
    [/\b(live|concert|unplugged|mtv unplugged)\b/, 90],
    [/\b(acoustic|stripped|demo|voice memo|session|sessions|rehearsal)\b/, 85],
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

function scoreTrackMatch(
  candidateTrackName: string,
  candidateCollectionName: string,
  candidateArtistName: string,
  targetTrackName: string,
  targetAlbumTitle: string,
  allowedContext: string
): number {
  const cleanPrefFull = cleanMatchText(targetTrackName);
  const cleanPrefBase = cleanMatchText(getBaseTitle(targetTrackName));
  const cleanAlbumBase = cleanMatchText(
    getBaseTitle(targetAlbumTitle) || targetAlbumTitle
  );
  const cTrkFull = cleanMatchText(candidateTrackName);
  const cTrkBase = cleanMatchText(getBaseTitle(candidateTrackName));
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
    candidateTrackName,
    candidateCollectionName,
    candidateArtistName,
    allowedContext
  );
  return score;
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
      .map((s: any) => {
        let score = scoreTrackMatch(
          s.trackName || '',
          s.collectionName || '',
          s.artistName || '',
          targetTrackName,
          albumTitle,
          allowedContext
        );
        if (
          albumTitle &&
          matchesAlbumTitle(s.collectionName || '', albumTitle)
        ) {
          score += 90;
        }
        return { song: s, score };
      })
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

function getPreviewCacheKey(alb: AudioPreviewTarget): string {
  if (alb.id) return `id:${alb.id}`;
  return `${cleanMatchText(alb.title)}:::${cleanMatchText(alb.artist)}`;
}

export async function resolveAlbumPreview(
  alb: AudioPreviewTarget,
  signal: AbortSignal,
  username = 'itseebo'
): Promise<string | null> {
  const cacheKey = getPreviewCacheKey(alb);
  const cached = previewUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const primaryArtist = extractPrimaryArtist(alb.artist, alb.primaryArtist);
  const baseAlbumTitle = getBaseTitle(alb.title) || alb.title;
  const retryBudget = { left: 2 };
  let preferredTrackName = '';
  let fallbackSpotifyPreview: string | null = null;

  // 1. Query stats.fm for the user's #1 most-streamed studio track on this exact album.
  //    Do NOT trust stats.fm's appleMusicPreview directly (often mismatched to covers/remixes);
  //    resolve the verified studio track via iTunes first and keep Spotify's preview only as fallback.
  if (alb.id) {
    try {
      const [userTracksRes, albumTracksRes] = await Promise.all([
        fetch(
          `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/top/albums/${alb.id}/tracks`,
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

          for (const item of userItems.slice(0, 2)) {
            const tName = item?.track?.name || '';
            const directSpotify = item?.track?.spotifyPreview;
            if (
              directSpotify &&
              getAlternatePenalty(tName, alb.title, alb.artist, alb.title) === 0
            ) {
              fallbackSpotifyPreview = directSpotify;
              break;
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

  // 2. Album-First iTunes Lookup: Find the verified studio album collectionId, then score its tracks
  try {
    const albumQueries = [
      `${alb.title} ${primaryArtist}`,
      ...(baseAlbumTitle !== alb.title
        ? [`${baseAlbumTitle} ${primaryArtist}`]
        : [])
    ];

    for (const q of albumQueries) {
      const albJson = await fetchItunesJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`,
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

      // Sort standard studio albums ahead of Remix / Live / Single / Tribute editions
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
            previewUrlCache.set(cacheKey, best.track.previewUrl);
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
      previewUrlCache.set(cacheKey, fallbackUrl);
      return fallbackUrl;
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  if (fallbackSpotifyPreview) {
    previewUrlCache.set(cacheKey, fallbackSpotifyPreview);
    return fallbackSpotifyPreview;
  }

  return null;
}
