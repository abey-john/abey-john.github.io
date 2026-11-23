export interface AudioPreviewTarget {
  id?: number;
  title: string;
  artist: string;
  primaryArtist?: string;
}

const COMMA_ARTIST_PREFIX =
  /^(tyler,\s*the creator|black country,\s*new road|earth,\s*wind\s*&\s*fire|crosby,\s*stills,\s*nash(?:\s*&\s*young)?|emerson,\s*lake\s*&\s*palmer|peter,\s*paul\s*and\s*mary|blood,\s*sweat\s*&\s*tears)/i;

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

export function getNormalizedAlbumArtistKey(
  title: string,
  artist: string
): string {
  return `${cleanMatchText(title)}:::${cleanMatchText(artist)}`;
}

export function getPreviewCacheKey(alb: AudioPreviewTarget): string {
  if (alb.id) return `id:${alb.id}`;
  return getNormalizedAlbumArtistKey(alb.title, alb.artist);
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

export function scoreTrackMatch(
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

/**
 * Scores a standalone song search result, awarding a strong bonus when its
 * parent collection matches the target studio album.
 */
export function scoreScopedSongCandidate(
  candidate: {
    trackName?: string;
    collectionName?: string;
    artistName?: string;
  },
  targetTrackName: string,
  albumTitle: string,
  allowedContext: string
): number {
  let score = scoreTrackMatch(
    candidate.trackName || '',
    candidate.collectionName || '',
    candidate.artistName || '',
    targetTrackName,
    albumTitle,
    allowedContext
  );
  if (
    albumTitle &&
    matchesAlbumTitle(candidate.collectionName || '', albumTitle)
  ) {
    score += 90;
  }
  return score;
}

/**
 * Picks the highest-priority non-remix track item from a stats.fm track list.
 */
export function pickPreferredStatsFmTrack(
  items: any[],
  albumTitle: string,
  albumArtist: string
): { trackName: string; spotifyPreview?: string } {
  if (!Array.isArray(items) || items.length === 0) {
    return { trackName: '' };
  }

  const bestItem =
    items.find(
      (item: any) =>
        item?.track?.name &&
        getAlternatePenalty(
          item.track.name,
          albumTitle,
          albumArtist,
          albumTitle
        ) === 0
    ) || items[0];

  let spotifyPreview: string | undefined;
  for (const item of items.slice(0, 2)) {
    const tName = item?.track?.name || '';
    const directSpotify = item?.track?.spotifyPreview;
    if (
      directSpotify &&
      getAlternatePenalty(tName, albumTitle, albumArtist, albumTitle) === 0
    ) {
      spotifyPreview = directSpotify;
      break;
    }
  }

  return {
    trackName: bestItem?.track?.name || '',
    spotifyPreview
  };
}
