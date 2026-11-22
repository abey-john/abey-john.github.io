export interface AudioPreviewTarget {
  id?: number;
  title: string;
  artist: string;
}

const previewUrlCache = new Map<string, string | null>();

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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function matchesArtistName(
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

export function matchesAlbumTitle(
  itemAlbum: string,
  targetAlbum: string
): boolean {
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

export function getBaseTitle(str: string): string {
  return (str || '')
    .replace(
      /\s*[-–—(\[]\s*(feat\.?|ft\.?|with\s|remaster|deluxe|bonus|explicit|clean|version|edition|stereo|mono)[^)\]]*[)\]]?/gi,
      ''
    )
    .split(/[:(\[\-–—]/)[0]
    .trim();
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

  // Penalize remixes, DJ mixes, sped-up/slowed, instrumentals, commentary unless expected by the album/track context
  const remixChecks: Array<[RegExp, number]> = [
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
  if (previewUrlCache.has(cacheKey)) {
    return previewUrlCache.get(cacheKey) ?? null;
  }

  const primaryArtist = alb.artist.split(',')[0].trim();
  const baseAlbumTitle = getBaseTitle(alb.title) || alb.title;
  let preferredTrackName = '';

  // 1. Query stats.fm for the user's #1 most-streamed studio track on this exact album
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

          // Only use a direct stats.fm preview URL if it is on one of the user's top 2 tracks
          // AND that track has zero remix/live/acoustic penalty (otherwise look up the studio track on iTunes)
          for (const item of userItems.slice(0, 2)) {
            const tName = item?.track?.name || '';
            const directUrl =
              item?.track?.appleMusicPreview || item?.track?.spotifyPreview;
            if (
              directUrl &&
              getAlternatePenalty(tName, alb.title, alb.artist, alb.title) === 0
            ) {
              previewUrlCache.set(cacheKey, directUrl);
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

    for (const sq of songQueries) {
      const songRes = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(sq)}&entity=song&limit=20`,
        { signal }
      );
      if (!songRes.ok) continue;
      const songJson = await songRes.json();
      const candidates = (songJson.results || []).filter(
        (s: any) => s.previewUrl && matchesArtistName(s.artistName, alb.artist)
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
        previewUrlCache.set(cacheKey, url);
        return url;
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
  }

  previewUrlCache.set(cacheKey, null);
  return null;
}
