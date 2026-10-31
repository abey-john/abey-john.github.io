export const defaultTrackOverrides: Record<string, string> = {
  'American Idiot': 'Holiday',
  'Where the Light Is: Live in Los Angeles':
    "Free Fallin' (Live at the Nokia Theatre",
  'To Pimp a Butterfly': 'Alright'
};

export function cleanText(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function matchesArtist(
  itemArtist: string,
  targetArtist: string
): boolean {
  const ia = cleanText(itemArtist);
  const a = cleanText(targetArtist);
  return ia.includes(a) || a.includes(ia);
}

export function matchesAlbum(itemAlbum: string, targetAlbum: string): boolean {
  const ia = cleanText(itemAlbum);
  const a = cleanText(targetAlbum);
  if (ia.includes(a) || a.includes(ia)) return true;
  const aSimp = cleanText(targetAlbum.split(/[:(]/)[0]);
  if (aSimp.length >= 4 && (ia.includes(aSimp) || aSimp.includes(ia)))
    return true;
  return false;
}

export function slugMatchesAlbum(
  slug: string,
  albumTitle: string,
  artist: string
): boolean {
  const cleanSlug = cleanText(slug);
  const cleanAlbum = cleanText(albumTitle);
  const cleanSimplified = cleanText(albumTitle.split(/[:(]/)[0]);
  const cleanArt = cleanText(artist);

  // 1. Direct match with full album title
  if (cleanSlug.includes(cleanAlbum) || cleanAlbum.includes(cleanSlug))
    return true;

  // 2. Artist embedded in slug (e.g. "where-the-light-is-john-mayer-live-in-los-angeles")
  if (cleanArt) {
    const slugWithoutArtist = cleanSlug.replace(new RegExp(cleanArt, 'g'), '');
    if (
      slugWithoutArtist.includes(cleanAlbum) ||
      cleanAlbum.includes(slugWithoutArtist)
    )
      return true;
    if (
      slugWithoutArtist.includes(cleanSimplified) ||
      cleanSimplified.includes(slugWithoutArtist)
    )
      return true;
    if (cleanSlug.includes(cleanSimplified) && cleanSlug.includes(cleanArt))
      return true;
  }

  // 3. Simplified album match if slug contains artist
  if (cleanSimplified.length >= 6 && cleanSlug.includes(cleanSimplified)) {
    if (!cleanArt || cleanSlug.includes(cleanArt)) return true;
  }

  return false;
}

export async function safeItunesFetch(
  url: string,
  retries = 2
): Promise<any | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 429) {
        // Rate limited by Apple: wait and retry
        await new Promise((resolve) =>
          setTimeout(resolve, 1500 * (attempt + 1))
        );
        continue;
      }
      if (!res.ok) return null;
      const rawText = await res.text();
      const text = rawText.trim();
      if (!text.startsWith('{')) return null;
      return JSON.parse(text);
    } catch {
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return null;
}

export function findBestTrackInList(
  tracks: any[],
  trackTarget: string,
  getTrackName: (t: any) => string
): any | null {
  const cleanTarget = cleanText(trackTarget);
  if (!cleanTarget) return null;

  // 1. Strict exact match: "neosurf" === "neosurf"
  const exact = tracks.find((t) => cleanText(getTrackName(t)) === cleanTarget);
  if (exact) return exact;

  // 2. Base title match before parenthesis, brackets, hyphen, colon (e.g. "Holiday - Remastered" or "Holiday (Live)")
  const baseMatch = tracks.find((t) => {
    const raw = getTrackName(t);
    const base = raw.split(/[\(\[\-–—:]/)[0];
    return cleanText(base) === cleanTarget;
  });
  if (baseMatch) return baseMatch;

  // 3. Track name starts with target followed by space or separator
  const startsWith = tracks.find((t) => {
    const raw = getTrackName(t).toLowerCase();
    const target = trackTarget.toLowerCase();
    return (
      raw.startsWith(target + ' ') ||
      raw.startsWith(target + '-') ||
      raw.startsWith(target + ':')
    );
  });
  if (startsWith) return startsWith;

  // 4. Substring match as fallback
  const substringMatch = tracks.find((t) => {
    const ct = cleanText(getTrackName(t));
    return ct.includes(cleanTarget) || cleanTarget.includes(ct);
  });
  return substringMatch || null;
}

export async function fetchAppleMusicWeb(
  albumTitle: string,
  artist: string,
  trackTarget?: string
): Promise<{ previewUrl?: string; previewTrack?: string } | null> {
  try {
    const searchUrl = `https://music.apple.com/us/search?term=${encodeURIComponent(`${albumTitle} ${artist}`)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    const albumLinks = [
      ...text.matchAll(/\/us\/album\/([a-z0-9-]+)\/(\d+)/g)
    ].map((m) => ({
      slug: m[1],
      id: m[2],
      path: m[0]
    }));
    if (albumLinks.length === 0) return null;

    const cleanAlbum = cleanText(albumTitle);
    const candidate = albumLinks.find((a) =>
      slugMatchesAlbum(a.slug, albumTitle, artist)
    );
    if (!candidate) return null;

    const albRes = await fetch(`https://music.apple.com${candidate.path}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!albRes.ok) return null;
    const albText = await albRes.text();
    const m = albText.match(
      /<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/
    );
    if (!m) return null;

    const json = JSON.parse(m[1]);
    const sections = json.data?.[0]?.data?.sections || [];
    const trackSecs = sections.filter((s: any) => s.itemKind === 'trackLockup');
    const tracks = trackSecs
      .flatMap((s: any) => s.items || [])
      .filter((t: any) => t.previewUrl);
    if (tracks.length === 0) return null;

    if (trackTarget) {
      const best = findBestTrackInList(
        tracks,
        trackTarget,
        (t: any) => t.title
      );
      if (best) {
        return {
          previewUrl: best.previewUrl,
          previewTrack: best.title
        };
      }
    } else {
      const titleMatch = tracks.find((t: any) =>
        cleanText(t.title).includes(cleanAlbum)
      );
      const chosen =
        titleMatch ||
        tracks.find((t: any) => !t.title.toLowerCase().includes('intro')) ||
        tracks[0];
      return {
        previewUrl: chosen.previewUrl,
        previewTrack: chosen.title
      };
    }
  } catch {}
  return null;
}

export async function fetchAudioPreview(
  albumTitle: string,
  artist: string,
  preferredTrack?: string
): Promise<{ previewUrl?: string; previewTrack?: string }> {
  try {
    const trackTarget = preferredTrack || defaultTrackOverrides[albumTitle];
    const simplifiedAlbum = albumTitle.split(':')[0].split('(')[0].trim();

    // 1. PRIMARY STRATEGY: Apple Music Web (Direct album tracklist, permanent non-expiring M4A previews)
    const webResult = await fetchAppleMusicWeb(albumTitle, artist, trackTarget);
    if (webResult?.previewUrl) {
      return webResult;
    }

    // 2. ALBUM-FIRST STRATEGY: Look up the verified album via iTunes search API
    const albumQueries = [
      `${albumTitle} ${artist}`,
      ...(simplifiedAlbum !== albumTitle
        ? [`${simplifiedAlbum} ${artist}`]
        : [])
    ];

    for (const q of albumQueries) {
      const albumData = await safeItunesFetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`
      );

      if (albumData?.results) {
        const matchingAlbums = albumData.results.filter(
          (a: any) =>
            matchesArtist(a.artistName, artist) &&
            (matchesAlbum(a.collectionName, albumTitle) ||
              matchesAlbum(a.collectionName, simplifiedAlbum))
        );

        // Sort albums: standard studio releases first, penalize remix/tribute/lullaby/single collections
        matchingAlbums.sort((a: any, b: any) => {
          const getPenalty = (name: string) => {
            const l = (name || '').toLowerCase();
            if (
              l.includes('tribute') ||
              l.includes('lullaby') ||
              l.includes('karaoke')
            )
              return 100;
            if (l.includes('single') || l.includes(' - ep')) return 50;
            if (
              l.includes('remix') &&
              !albumTitle.toLowerCase().includes('remix')
            )
              return 40;
            return 0;
          };
          return getPenalty(a.collectionName) - getPenalty(b.collectionName);
        });

        for (const alb of matchingAlbums.slice(0, 4)) {
          const tracksData = await safeItunesFetch(
            `https://itunes.apple.com/lookup?id=${alb.collectionId}&entity=song`
          );

          if (tracksData?.results) {
            const tracks = tracksData.results.filter(
              (x: any) => x.wrapperType === 'track' && x.previewUrl
            );

            if (tracks.length > 0) {
              if (trackTarget) {
                const found = findBestTrackInList(
                  tracks,
                  trackTarget,
                  (t) => t.trackName
                );
                if (found) {
                  return {
                    previewUrl: found.previewUrl,
                    previewTrack: found.trackName
                  };
                }
              } else {
                // Find title track or first lead track on album
                const titleMatch = tracks.find((t: any) =>
                  cleanText(t.trackName).includes(cleanText(albumTitle))
                );
                const chosen =
                  titleMatch ||
                  tracks.find(
                    (t: any) => !t.trackName.toLowerCase().includes('intro')
                  ) ||
                  tracks[0];
                return {
                  previewUrl: chosen.previewUrl,
                  previewTrack: chosen.trackName
                };
              }
            }
          }
        }
      }
    }

    // 3. FALLBACK STRATEGY: Scoped song search with strict album and anti-remix scoring
    const baseTrack = trackTarget
      ? trackTarget.split(/[\(\[\-–—:]/)[0].trim()
      : undefined;
    const songQueries = trackTarget
      ? [
          `${trackTarget} ${simplifiedAlbum} ${artist}`,
          `${trackTarget} ${artist}`,
          ...(baseTrack && baseTrack !== trackTarget
            ? [
                `${baseTrack} ${simplifiedAlbum} ${artist}`,
                `${baseTrack} ${artist}`
              ]
            : [])
        ]
      : [`${albumTitle} ${artist}`];

    for (const q of songQueries) {
      const data = await safeItunesFetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=25`
      );

      if (data?.results) {
        const songs = data.results.filter(
          (t: any) => t.previewUrl && matchesArtist(t.artistName, artist)
        );

        const scored = songs.map((s: any) => {
          let score = 0;
          const col = s.collectionName || '';
          const trk = s.trackName || '';

          // Album match bonus
          if (
            matchesAlbum(col, albumTitle) ||
            matchesAlbum(col, simplifiedAlbum)
          ) {
            score += 100;
          }

          // Track match bonus
          if (trackTarget) {
            const ct = cleanText(trk);
            const ctar = cleanText(trackTarget);
            if (ct === ctar)
              score += 100; // Big bonus for exact match
            else if (cleanText(trk.split(/[\(\[\-–—:]/)[0]) === ctar)
              score += 60;
            else if (ct.includes(ctar)) score += 20;
          }

          // Anti-remix penalty: do not pick remixes unless the user's requested track name has "remix"
          const targetWantsRemix = (trackTarget || '')
            .toLowerCase()
            .includes('remix');
          const isRemix =
            trk.toLowerCase().includes('remix') ||
            col.toLowerCase().includes('remix');
          if (isRemix && !targetWantsRemix) {
            score -= 80;
          }

          // Anti-tribute/lullaby penalty
          const isTribute =
            trk.toLowerCase().includes('tribute') ||
            col.toLowerCase().includes('tribute') ||
            s.artistName.toLowerCase().includes('tribute') ||
            s.artistName.toLowerCase().includes('lullaby');
          if (isTribute) {
            score -= 150;
          }

          // Penalize greatest hits / compilations if target album is a specific studio album
          const isComp =
            col.toLowerCase().includes('greatest hits') ||
            col.toLowerCase().includes('the best of');
          if (isComp) {
            score -= 25;
          }

          return { song: s, score };
        });

        scored.sort((a: any, b: any) => b.score - a.score);
        if (scored.length > 0 && scored[0].score > 0) {
          const best = scored[0].song;
          return {
            previewUrl: best.previewUrl,
            previewTrack: best.trackName
          };
        }
      }
    }
  } catch (e) {
    // Ignore errors gracefully
  }

  return {};
}

// Helper to process async operations in bounded concurrency pools
export async function processInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
