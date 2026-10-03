import type { Loader, LoaderContext } from 'astro/loaders';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import 'dotenv/config';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2022-06-28';

/**
 * Perform an authenticated request to the Notion API.
 */
async function notionRequest(endpoint: string, method: string = 'GET', body: any = null) {
  if (!NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not configured');
  }

  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API Error (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

function stripJpeg(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
  const chunks = [buffer.subarray(0, 2)];
  let offset = 2;
  let modified = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      chunks.push(buffer.subarray(offset));
      break;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      chunks.push(buffer.subarray(offset));
      break;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1) {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return modified ? Buffer.from(Buffer.concat(chunks)) : buffer;
}

function stripPng(buffer: Buffer): Buffer {
  if (buffer.length < 8) return buffer;
  const header = buffer.subarray(0, 8);
  const chunks = [header];
  let offset = 8;
  let modified = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const totalChunkLength = 12 + length;
    if (type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    }
    offset += totalChunkLength;
  }
  return modified ? Buffer.from(Buffer.concat(chunks)) : buffer;
}

function stripWebp(buffer: Buffer): Buffer {
  if (buffer.length < 12) return buffer;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return buffer;
  }
  const chunks = [];
  let offset = 12;
  let modified = false;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const totalChunkLength = 8 + chunkSize + (chunkSize % 2);
    if (chunkType === 'EXIF' || chunkType === 'XMP ') {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    }
    offset += totalChunkLength;
  }
  if (!modified) return buffer;
  const newPayload = Buffer.concat(chunks);
  const newHeader = Buffer.alloc(12);
  newHeader.write('RIFF', 0, 4, 'ascii');
  newHeader.writeUInt32LE(newPayload.length + 4, 4);
  newHeader.write('WEBP', 8, 4, 'ascii');
  return Buffer.from(Buffer.concat([newHeader, newPayload]));
}

function stripExifMetadata(buffer: Buffer, ext: string): Buffer {
  try {
    if (ext === 'jpg' || ext === 'jpeg') return stripJpeg(buffer);
    if (ext === 'png') return stripPng(buffer);
    if (ext === 'webp') return stripWebp(buffer);
  } catch {
    // If parsing fails, preserve original
  }
  return buffer;
}

/**
 * Downloads a remote image from Notion to public/assets/notion/ so it never expires.
 * Automatically strips all EXIF and GPS metadata before saving.
 */
async function downloadRemoteImage(url: string): Promise<string> {
  if (!url || !url.startsWith('http')) return url;

  try {
    const notionDir = path.resolve('public/assets/notion');
    if (!fs.existsSync(notionDir)) {
      fs.mkdirSync(notionDir, { recursive: true });
    }

    // Determine extension
    const cleanUrl = url.split('?')[0];
    const extMatch = cleanUrl.match(/\.(webp|png|jpe?g|svg|gif)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'webp';

    const hash = crypto.createHash('md5').update(cleanUrl).digest('hex').slice(0, 12);
    const filename = `${hash}.${ext}`;
    const targetPath = path.join(notionDir, filename);

    if (!fs.existsSync(targetPath)) {
      const response = await fetch(url);
      if (response.ok) {
        const rawBuffer = Buffer.from(await response.arrayBuffer());
        const cleanBuffer = stripExifMetadata(rawBuffer, ext);
        fs.writeFileSync(targetPath, cleanBuffer);
      } else {
        return url;
      }
    }

    return `/assets/notion/${filename}`;
  } catch (err) {
    console.error('Error downloading Notion image:', err);
    return url;
  }
}

/**
 * Convert Notion rich text array to Markdown formatting.
 */
function richTextToMarkdown(richTexts: any[]): string {
  if (!Array.isArray(richTexts)) return '';

  return richTexts
    .map((t) => {
      let text = t.plain_text || '';
      if (!text) return '';
      if (t.annotations?.code) text = `\`${text}\``;
      if (t.annotations?.bold) text = `**${text}**`;
      if (t.annotations?.italic) text = `*${text}*`;
      if (t.annotations?.strikethrough) text = `~~${text}~~`;
      if (t.href) text = `[${text}](${t.href})`;
      return text;
    })
    .join('');
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert Notion rich text array to safe, formatted HTML.
 * Supports Notion hyperlinks, bold, italics, strikethrough, code, and raw typed Markdown.
 */
function richTextToHtml(richTexts: any[]): string {
  if (!Array.isArray(richTexts) || richTexts.length === 0) return '';

  let html = richTexts
    .map((t) => {
      let text = escapeHtml(t.plain_text || '');
      if (!text) return '';

      // Support Notion's native formatting annotations
      if (t.annotations?.code) text = `<code>${text}</code>`;
      if (t.annotations?.bold) text = `<strong>${text}</strong>`;
      if (t.annotations?.italic) text = `<em>${text}</em>`;
      if (t.annotations?.strikethrough) text = `<s>${text}</s>`;
      if (t.annotations?.underline) text = `<u>${text}</u>`;
      if (t.href) {
        const safeHref = escapeHtml(t.href);
        text = `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return text;
    })
    .join('');

  // 1. Fix [text](<a href="url"...>...</a>) (when Notion auto-hyperlinked the URL inside typed [text](url))
  html = html.replace(
    /\[([^\]]+)\]\(<a\s+href="([^"]+)"[^>]*>.*?<\/a>\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 2. Fix accidentally nested [text]([url](url))
  html = html.replace(
    /\[([^\]]+)\]\(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\)/g,
    '<a href="$3" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 3. Fix standard typed markdown links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 4. Raw markdown bold, italic, code
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  return html;
}

/**
 * Convert Notion page blocks to Markdown text.
 */
async function blocksToMarkdown(blocks: any[]): Promise<string> {
  const lines: string[] = [];

  for (const b of blocks) {
    // Skip instructional callout blocks added during bootstrap
    if (b.type === 'callout') {
      const calloutText = richTextToMarkdown(b.callout?.rich_text || []);
      if (calloutText.startsWith('Edit your bio') || calloutText.startsWith('👋')) {
        continue;
      }
      lines.push(`> ${calloutText}\n`);
      continue;
    }

    switch (b.type) {
      case 'paragraph': {
        const text = richTextToMarkdown(b.paragraph?.rich_text);
        lines.push(text ? `${text}\n` : '');
        break;
      }
      case 'heading_1':
        lines.push(`# ${richTextToMarkdown(b.heading_1?.rich_text)}\n`);
        break;
      case 'heading_2':
        lines.push(`## ${richTextToMarkdown(b.heading_2?.rich_text)}\n`);
        break;
      case 'heading_3':
        lines.push(`### ${richTextToMarkdown(b.heading_3?.rich_text)}\n`);
        break;
      case 'bulleted_list_item':
        lines.push(`* ${richTextToMarkdown(b.bulleted_list_item?.rich_text)}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${richTextToMarkdown(b.numbered_list_item?.rich_text)}`);
        break;
      case 'quote':
        lines.push(`> ${richTextToMarkdown(b.quote?.rich_text)}\n`);
        break;
      case 'divider':
        lines.push('---\n');
        break;
      case 'image': {
        const rawUrl = b.image?.file?.url || b.image?.external?.url;
        const caption = richTextToMarkdown(b.image?.caption || []);
        if (rawUrl) {
          const localUrl = await downloadRemoteImage(rawUrl);
          if (caption) {
            lines.push(`\n![${caption}](${localUrl})\n*${caption}*\n`);
          } else {
            lines.push(`\n![Image](${localUrl})\n`);
          }
        }
        break;
      }
      case 'code': {
        const code = b.code?.rich_text?.map((t: any) => t.plain_text || '').join('') || '';
        const lang = b.code?.language || '';
        lines.push(`\`\`\`${lang}\n${code}\n\`\`\`\n`);
        break;
      }
      case 'to_do': {
        const checked = b.to_do?.checked ? '[x]' : '[ ]';
        lines.push(`- ${checked} ${richTextToMarkdown(b.to_do?.rich_text || [])}`);
        break;
      }
      default:
        break;
    }
  }

  return lines.join('\n').trim();
}

/**
 * Extract an image source from Notion property (uploaded file, external URL, or text path).
 */
async function extractImageSource(filesProp: any, textProp: any): Promise<string> {
  const fileObj = filesProp?.files?.[0];
  if (fileObj) {
    const rawUrl = fileObj.file?.url || fileObj.external?.url;
    if (rawUrl) {
      return await downloadRemoteImage(rawUrl);
    }
  }

  const textVal = textProp?.rich_text?.[0]?.plain_text;
  if (textVal) {
    if (textVal.startsWith('http')) {
      return await downloadRemoteImage(textVal);
    }
    return textVal;
  }

  return '';
}

// ---------------------------------------------------------------------------
// 1. LAUNCHES LOADER
// ---------------------------------------------------------------------------
export function notionLaunchesLoader(): Loader {
  return {
    name: 'notion-launches-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_LAUNCHES_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const res = await notionRequest(`databases/${dbId}/query`, 'POST', {
            page_size: 100,
            sorts: [{ property: 'Order', direction: 'ascending' }],
          });

          store.clear();

          for (const page of res.results) {
            const p = page.properties;
            const title = p.Title?.title?.[0]?.plain_text || 'Untitled';

            const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || page.id;
            const image = (await extractImageSource(p.Image, p.ImagePath)) || undefined;

            const item = {
              id,
              category: (p.Category?.select?.name || 'professional') as 'professional' | 'personal',
              title,
              url: p.URL?.url || '#',
              role: p.Role?.rich_text?.[0]?.plain_text || '',
              date: p.Date?.rich_text?.[0]?.plain_text || undefined,
              image,
            };

            const data = await parseData({ id, data: item });
            store.set({ id, data });
          }

          logger.info(`Loaded ${res.results.length} launches from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading launches from Notion: ${err.message}.`);
        }
      }

      logger.warn('No launches loaded from Notion. Ensure NOTION_API_KEY and NOTION_LAUNCHES_DB_ID are configured.');
      store.clear();
    },
  };
}

/**
 * In-memory cache of geocoded coordinates to avoid redundant network calls.
 */
const geocodeCache = new Map<string, { lat: number; lng: number }>();

/**
 * Infer latitude and longitude from location name and country using Open-Meteo with OpenStreetMap fallback.
 */
async function geocodeLocation(name: string, country?: string): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = `${name.toLowerCase().trim()}|${(country || '').toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  // 1. Try Open-Meteo Geocoding API (fast, worldwide, free, no API key required)
  try {
    const cleanName = name.replace(/,.*$/, '').trim();
    const searchUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanName || name)}&count=5&language=en&format=json`;
    const res = await fetch(searchUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        let match = data.results[0];
        if (country) {
          const countryLower = country.toLowerCase();
          const found = data.results.find((r: any) =>
            r.country?.toLowerCase().includes(countryLower) ||
            countryLower.includes(r.country?.toLowerCase())
          );
          if (found) match = found;
        }
        const coords = { lat: Number(match.latitude), lng: Number(match.longitude) };
        geocodeCache.set(cacheKey, coords);
        return coords;
      }
    }
  } catch {
    // Proceed to fallback
  }

  // 2. Fallback to OpenStreetMap Nominatim
  try {
    const query = [name, country].filter(Boolean).join(', ');
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PersonalWebsiteGeocoding/1.0' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocodeCache.set(cacheKey, coords);
        return coords;
      }
    }
  } catch {
    // Geocode failed
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. PLACES LOADER
// ---------------------------------------------------------------------------
export function notionPlacesLoader(): Loader {
  return {
    name: 'notion-places-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_PLACES_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const res = await notionRequest(`databases/${dbId}/query`, 'POST', {
            page_size: 100,
          });

          store.clear();

          for (const page of res.results) {
            const p = page.properties;
            const name = p.Name?.title?.[0]?.plain_text || 'Untitled';
            const id = page.id;
            const photo = await extractImageSource(p.Photo, p.PhotoPath);
            const country = p.Country?.rich_text?.[0]?.plain_text || '';

            let lat = typeof p.Latitude?.number === 'number' ? p.Latitude.number : null;
            let lng = typeof p.Longitude?.number === 'number' ? p.Longitude.number : null;

            // Auto-infer coordinates if not explicitly provided in Notion
            if (lat === null || lng === null || (lat === 0 && lng === 0)) {
              const geocoded = await geocodeLocation(name, country);
              if (geocoded) {
                lat = geocoded.lat;
                lng = geocoded.lng;
                logger.info(`Auto-geocoded "${name}": [${lat}, ${lng}]`);
              } else {
                logger.warn(`Could not geocode coordinates for "${name}". Defaulting to [0, 0].`);
                lat = lat ?? 0;
                lng = lng ?? 0;
              }
            }

            const item = {
              id,
              name,
              type: (p.Type?.select?.name || 'city') as 'city' | 'park',
              lat,
              lng,
              country,
              blurb: richTextToHtml(p.Blurb?.rich_text) || undefined,
              photo: photo || undefined,
              link: undefined,
            };

            const data = await parseData({ id, data: item });
            store.set({ id, data });
          }

          logger.info(`Loaded ${res.results.length} places from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading places from Notion: ${err.message}.`);
        }
      }

      logger.warn('No places loaded from Notion. Ensure NOTION_API_KEY and NOTION_PLACES_DB_ID are configured.');
      store.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// 3. MUSIC LOADER
// ---------------------------------------------------------------------------
export function notionMusicLoader(): Loader {
  return {
    name: 'notion-music-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_MUSIC_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const res = await notionRequest(`databases/${dbId}/query`, 'POST', {
            page_size: 100,
          });

          store.clear();

          const favoritesList: Array<{ title: string; artist: string; cover: string; blurb?: string; rank: number }> = [];
          const vinylList: Array<{ title: string; artist: string; cover: string }> = [];
          let recommendation: any = null;
          let recentListen: any = null;

          for (const page of res.results) {
            const p = page.properties;
            const title = p.Title?.title?.[0]?.plain_text || 'Untitled';
            const artist = p.Artist?.rich_text?.[0]?.plain_text || 'Unknown Artist';
            const category = p.Category?.select?.name;
            const cover = (await extractImageSource(p.Cover, p.CoverPath)) || '/assets/covers/placeholder-album.svg';
            const blurb = richTextToHtml(p.Blurb?.rich_text) || '';
            const note = richTextToHtml(p.Note?.rich_text) || '';
            const rank = p.Rank?.number ?? 99;
            const rating = p.Rating?.number ?? 8.0;
            const date = p.Date?.rich_text?.[0]?.plain_text || 'October 2026';

            // Support vinyl checkbox property (e.g. "Vinyl", "vinyl", "On Vinyl") or Category = 'Vinyl'
            const vinylProp = p.Vinyl || p.vinyl || Object.entries(p).find(([k]) => k.toLowerCase().includes('vinyl'))?.[1];
            const isVinyl = (vinylProp as any)?.checkbox === true || category === 'Vinyl';

            if (category === 'Top 10') {
              favoritesList.push({ title, artist, cover, blurb, rank });
            } else if (category === 'Recommendation') {
              recommendation = { title, artist, cover, blurb, note, rating, date };
            } else if (category === 'Recent Listen') {
              recentListen = { title, artist, cover, blurb, note, rating, date };
            }

            if (isVinyl) {
              vinylList.push({ title, artist, cover });
            }
          }

          // Sort favorites 1 to 10
          favoritesList.sort((a, b) => a.rank - b.rank);
          const topTen = favoritesList.slice(0, 10).map(({ rank, ...rest }) => rest);

          // Sort vinyl collection: alphabetical by artist (ignoring leading "The "), then by title
          const getArtistSortKey = (name: string) => (name || '').replace(/^the\s+/i, '').trim().toLowerCase();
          vinylList.sort((a, b) => {
            const artistComp = getArtistSortKey(a.artist).localeCompare(getArtistSortKey(b.artist), undefined, {
              sensitivity: 'base',
            });
            if (artistComp !== 0) return artistComp;
            return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
          });

          const fullMusicContent = {
            updated: new Date(),
            favorites: topTen,
            vinyl: vinylList,
            recommendation: recommendation || {
              title: 'Unknown',
              artist: 'Unknown',
              cover: '/assets/covers/placeholder-album.svg',
              rating: 8.0,
            },
            recentListen: recentListen || {
              title: 'Unknown',
              artist: 'Unknown',
              cover: '/assets/covers/placeholder-album.svg',
              rating: 8.0,
            },
          };

          const data = await parseData({ id: 'content', data: fullMusicContent });
          store.set({ id: 'content', data });

          logger.info(`Loaded music collection (${vinylList.length} on vinyl) from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading music from Notion: ${err.message}.`);
        }
      }

      logger.warn('No music loaded from Notion. Ensure NOTION_API_KEY and NOTION_MUSIC_DB_ID are configured.');
      const emptyFavorites = Array.from({ length: 10 }, (_, i) => ({
        title: `Favorite ${i + 1}`,
        artist: 'Artist',
        cover: '/assets/covers/placeholder-album.svg',
        blurb: '',
      }));
      const fallbackMusic = {
        updated: new Date(),
        favorites: emptyFavorites,
        vinyl: [],
        recommendation: {
          title: 'Recommendation',
          artist: 'Artist',
          cover: '/assets/covers/placeholder-album.svg',
          rating: 8.0,
        },
        recentListen: {
          title: 'Recent Listen',
          artist: 'Artist',
          cover: '/assets/covers/placeholder-album.svg',
          rating: 8.0,
        },
      };
      const data = await parseData({ id: 'content', data: fallbackMusic });
      store.set({ id: 'content', data });
    },
  };
}

// ---------------------------------------------------------------------------
// 4. ABOUT LOADER
// ---------------------------------------------------------------------------
export function notionAboutLoader(): Loader {
  return {
    name: 'notion-about-loader',
    load: async ({ store, logger, parseData, renderMarkdown }: LoaderContext) => {
      const pageId = process.env.NOTION_ABOUT_PAGE_ID;

      if (NOTION_API_KEY && pageId) {
        try {
          const pageRes = await notionRequest(`pages/${pageId}`);
          const blocksRes = await notionRequest(`blocks/${pageId}/children?page_size=100`);

          let photoUrl: string | undefined;
          let photoCaption: string | undefined;

          // 1. Look for an image block in the page
          for (const b of blocksRes.results) {
            if (b.type === 'image') {
              const rawUrl = b.image?.file?.url || b.image?.external?.url;
              if (rawUrl) {
                photoUrl = await downloadRemoteImage(rawUrl);
                photoCaption = richTextToMarkdown(b.image?.caption || []);
                break;
              }
            }
          }

          // 2. If no image block, check if page has a Cover image
          if (!photoUrl && pageRes.cover) {
            const rawUrl = pageRes.cover?.file?.url || pageRes.cover?.external?.url;
            if (rawUrl) {
              photoUrl = await downloadRemoteImage(rawUrl);
            }
          }

          // 3. Check if page has an Icon uploaded (for avatar)
          let avatarUrl: string | undefined;
          if (pageRes.icon && (pageRes.icon.type === 'file' || pageRes.icon.type === 'external')) {
            const rawUrl = pageRes.icon.file?.url || pageRes.icon.external?.url;
            if (rawUrl) {
              avatarUrl = await downloadRemoteImage(rawUrl);
            }
          }

          // Exclude the extracted image block from the bio text flow
          const bioBlocks = blocksRes.results.filter((b: any) => b.type !== 'image');
          const markdown = await blocksToMarkdown(bioBlocks);

          store.clear();

          const rendered = await renderMarkdown(markdown);
          const data = await parseData({
            id: 'index',
            data: {
              title: 'About',
              photo: photoUrl,
              photoCaption: photoCaption || undefined,
              photoAlt: photoCaption || 'Profile photo',
              avatar: avatarUrl,
            },
          });

          store.set({
            id: 'index',
            data,
            body: markdown,
            rendered,
          });

          logger.info(`Loaded About bio & photo from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading About from Notion: ${err.message}.`);
        }
      }

      logger.warn('No About bio loaded from Notion. Ensure NOTION_API_KEY and NOTION_ABOUT_PAGE_ID are configured.');
      const markdown = '';
      const rendered = await renderMarkdown(markdown);
      const data = await parseData({ id: 'index', data: { title: 'About' } });
      store.set({ id: 'index', data, body: markdown, rendered });
    },
  };
}

// ---------------------------------------------------------------------------
// 5. NOW LOADER
// ---------------------------------------------------------------------------
export function notionNowLoader(): Loader {
  return {
    name: 'notion-now-loader',
    load: async ({ store, logger, parseData, renderMarkdown }: LoaderContext) => {
      const pageId = process.env.NOTION_NOW_PAGE_ID;

      if (NOTION_API_KEY && pageId) {
        try {
          const pageRes = await notionRequest(`pages/${pageId}`);
          const blocksRes = await notionRequest(`blocks/${pageId}/children?page_size=100`);

          let updatedDate = pageRes.last_edited_time ? new Date(pageRes.last_edited_time) : new Date();

          // Check if there is an explicit "Updated: <date>" block (callout or text)
          const nowBlocks: any[] = [];
          for (const b of (blocksRes.results || [])) {
            const blockContent = b[b.type];
            const text = Array.isArray(blockContent?.rich_text)
              ? blockContent.rich_text.map((t: any) => t.plain_text || '').join('').trim()
              : '';

            const match = text.match(/^updated:\s*(.+)$/i);
            if (match) {
              const rawDateStr = match[1].trim();
              const parsedUtc = new Date(rawDateStr.endsWith('UTC') ? rawDateStr : `${rawDateStr} UTC`);
              if (!isNaN(parsedUtc.getTime())) {
                updatedDate = parsedUtc;
              } else {
                const parsedLocal = new Date(rawDateStr);
                if (!isNaN(parsedLocal.getTime())) {
                  updatedDate = parsedLocal;
                }
              }
              // Skip adding to nowBlocks so it does not render twice
              continue;
            }

            nowBlocks.push(b);
          }

          const markdown = await blocksToMarkdown(nowBlocks);

          store.clear();

          const rendered = await renderMarkdown(markdown);
          const data = await parseData({
            id: 'index',
            data: { updated: updatedDate },
          });

          store.set({
            id: 'index',
            data,
            body: markdown,
            rendered,
          });

          logger.info(`Loaded Now updates from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading Now from Notion: ${err.message}.`);
        }
      }

      logger.warn('No Now updates loaded from Notion. Ensure NOTION_API_KEY and NOTION_NOW_PAGE_ID are configured.');
      const markdown = 'Currently updating...';
      const rendered = await renderMarkdown(markdown);
      const data = await parseData({ id: 'index', data: { updated: new Date() } });
      store.set({ id: 'index', data, body: markdown, rendered });
    },
  };
}

// ---------------------------------------------------------------------------
// 6. SETTINGS LOADER
// ---------------------------------------------------------------------------
export function notionSettingsLoader(): Loader {
  return {
    name: 'notion-settings-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_SETTINGS_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const res = await notionRequest(`databases/${dbId}/query`, 'POST', {
            page_size: 100,
          });

          store.clear();

          const kv: Record<string, string> = {};
          for (const page of res.results) {
            const key = page.properties.Key?.title?.[0]?.plain_text?.trim();
            const value = page.properties.Value?.rich_text?.[0]?.plain_text?.trim() || '';
            if (key) {
              kv[key.toLowerCase()] = value;
            }
          }

          const settingsItem = {
            name: kv['name'] || '',
            role: kv['role'] || '',
            location: kv['location'] || '',
            email: kv['email'] || '',
            github: kv['github'] || '',
            linkedin: kv['linkedin'] || '',
            description: kv['description'] || undefined,
            ratingMax: kv['ratingmax'] ? Number(kv['ratingmax']) : 10,
          };

          const data = await parseData({ id: 'config', data: settingsItem });
          store.set({ id: 'config', data });

          logger.info(`Loaded site settings from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading settings from Notion: ${err.message}.`);
        }
      }

      logger.warn('No settings loaded from Notion. Using default settings.');
      const fallbackItem = {
        name: '',
        role: '',
        location: '',
        email: '',
        github: '',
        linkedin: '',
        ratingMax: 10,
      };
      const data = await parseData({ id: 'config', data: fallbackItem });
      store.set({ id: 'config', data });
    },
  };
}
