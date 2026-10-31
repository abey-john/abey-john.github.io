import type { Loader, LoaderContext } from 'astro/loaders';
import fs from 'node:fs';
import path from 'node:path';
import { NOTION_API_KEY, queryNotionDatabase } from './client';
import { extractImageSource } from './images';
import { richTextToHtml } from './text';
import { fetchAudioPreview, processInBatches } from './music-previews';

export function notionMusicLoader(): Loader {
  return {
    name: 'notion-music-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_MUSIC_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const results = await queryNotionDatabase(dbId);

          store.clear();

          const favoritesList: Array<{
            title: string;
            artist: string;
            cover: string;
            blurb?: string;
            rank: number;
            preferredTrack?: string;
            spotifyUrl?: string;
            appleMusicUrl?: string;
            bandcampUrl?: string;
            previewUrl?: string;
            previewTrack?: string;
          }> = [];
          const vinylList: Array<{
            title: string;
            artist: string;
            cover: string;
            preferredTrack?: string;
            previewUrl?: string;
            previewTrack?: string;
          }> = [];
          let recommendation: any = null;
          let recentListen: any = null;
          let latestEditedMs = 0;

          for (const page of results) {
            if ((page as any).last_edited_time) {
              const editedMs = new Date(
                (page as any).last_edited_time
              ).getTime();
              if (!isNaN(editedMs) && editedMs > latestEditedMs) {
                latestEditedMs = editedMs;
              }
            }

            const p = page.properties;
            const title = p.Title?.title?.[0]?.plain_text || 'Untitled';
            const artist =
              p.Artist?.rich_text?.[0]?.plain_text || 'Unknown Artist';
            const category = p.Category?.select?.name;
            const cover =
              (await extractImageSource(p.Cover, p.CoverPath)) ||
              '/assets/covers/placeholder-album.svg';
            const blurb = richTextToHtml(p.Blurb?.rich_text) || '';
            const note = richTextToHtml(p.Note?.rich_text) || '';
            const rank = p.Rank?.number ?? 99;
            const rating = p.Rating?.number ?? 8.0;
            const date = p.Date?.rich_text?.[0]?.plain_text || 'October 2026';

            // Support custom preferred track name from Notion
            const preferredTrack =
              p.Track?.rich_text?.[0]?.plain_text ||
              p.Song?.rich_text?.[0]?.plain_text ||
              p.Sample?.rich_text?.[0]?.plain_text ||
              p['Preview Track']?.rich_text?.[0]?.plain_text ||
              undefined;

            const spotifyUrl = p.Spotify?.url || p.spotify?.url || undefined;
            const appleMusicUrl =
              p['Apple Music']?.url ||
              p.Apple?.url ||
              p.appleMusic?.url ||
              undefined;
            const bandcampUrl = p.Bandcamp?.url || p.bandcamp?.url || undefined;

            // Support vinyl checkbox property or Category = 'Vinyl'
            const vinylProp =
              p.Vinyl ||
              p.vinyl ||
              Object.entries(p).find(([k]) =>
                k.toLowerCase().includes('vinyl')
              )?.[1];
            const isVinyl =
              (vinylProp as any)?.checkbox === true || category === 'Vinyl';

            if (category === 'Top 10') {
              favoritesList.push({
                title,
                artist,
                cover,
                blurb,
                rank,
                preferredTrack,
                spotifyUrl,
                appleMusicUrl,
                bandcampUrl
              });
            } else if (category === 'Recommendation') {
              recommendation = {
                title,
                artist,
                cover,
                blurb,
                note,
                rating,
                date,
                preferredTrack,
                spotifyUrl,
                appleMusicUrl,
                bandcampUrl
              };
            } else if (category === 'Recent Listen') {
              recentListen = {
                title,
                artist,
                cover,
                blurb,
                note,
                rating,
                date,
                preferredTrack,
                spotifyUrl,
                appleMusicUrl,
                bandcampUrl
              };
            }

            if (isVinyl) {
              vinylList.push({ title, artist, cover, preferredTrack });
            }
          }

          // Sort favorites 1 to 10
          favoritesList.sort((a, b) => a.rank - b.rank);
          const topTen = favoritesList
            .slice(0, 10)
            .map(({ rank, ...rest }) => rest);

          // Persistent build cache in node_modules/.cache/ (git-ignored)
          const cachePath = path.resolve(
            'node_modules/.cache/audio-cache.json'
          );
          let diskCache: Record<
            string,
            { previewUrl?: string; previewTrack?: string }
          > = {};
          try {
            if (fs.existsSync(cachePath)) {
              diskCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            }
          } catch {
            diskCache = {};
          }

          const previewCache = new Map<
            string,
            Promise<{ previewUrl?: string; previewTrack?: string }>
          >();
          const getPreviewCached = async (
            albumTitle: string,
            artistName: string,
            trackTarget?: string
          ) => {
            const key = `${albumTitle.toLowerCase()}:::${artistName.toLowerCase()}:::${(trackTarget || '').toLowerCase()}`;
            const cached = diskCache[key];
            if (cached?.previewUrl) {
              return cached;
            }
            if (!previewCache.has(key)) {
              const promise = (async () => {
                const result = await fetchAudioPreview(
                  albumTitle,
                  artistName,
                  trackTarget
                );
                if (result.previewUrl) {
                  diskCache[key] = result;
                  try {
                    const dir = path.dirname(cachePath);
                    if (!fs.existsSync(dir))
                      fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(
                      cachePath,
                      JSON.stringify(diskCache, null, 2)
                    );
                  } catch {}
                }
                return result;
              })();
              previewCache.set(key, promise);
            }
            return previewCache.get(key)!;
          };

          try {
            const allItems = [
              ...topTen,
              ...(recommendation ? [recommendation] : []),
              ...(recentListen ? [recentListen] : []),
              ...vinylList
            ];

            await processInBatches(allItems, 4, async (item: any) => {
              const preview = await getPreviewCached(
                item.title,
                item.artist,
                item.preferredTrack
              );
              item.previewUrl = preview.previewUrl;
              item.previewTrack = preview.previewTrack;
            });
          } catch (e) {
            logger.warn('Failed resolving some audio previews at build time.');
          }

          // Sort vinyl collection: alphabetical by artist (ignoring leading "The "), then by title
          const getArtistSortKey = (name: string) =>
            (name || '')
              .replace(/^the\s+/i, '')
              .trim()
              .toLowerCase();
          vinylList.sort((a, b) => {
            const artistComp = getArtistSortKey(a.artist).localeCompare(
              getArtistSortKey(b.artist),
              undefined,
              {
                sensitivity: 'base'
              }
            );
            if (artistComp !== 0) return artistComp;
            return (a.title || '').localeCompare(b.title || '', undefined, {
              sensitivity: 'base'
            });
          });

          const fullMusicContent = {
            updated: latestEditedMs > 0 ? new Date(latestEditedMs) : new Date(),
            favorites: topTen,
            vinyl: vinylList,
            recommendation: recommendation || {
              title: 'Unknown',
              artist: 'Unknown',
              cover: '/assets/covers/placeholder-album.svg',
              rating: 8.0
            },
            recentListen: recentListen || {
              title: 'Unknown',
              artist: 'Unknown',
              cover: '/assets/covers/placeholder-album.svg',
              rating: 8.0
            }
          };

          const data = await parseData({
            id: 'content',
            data: fullMusicContent
          });
          store.set({ id: 'content', data });

          logger.info(
            `Loaded music collection (${vinylList.length} on vinyl) from Notion.`
          );
          return;
        } catch (err: any) {
          logger.warn(`Failed loading music from Notion: ${err.message}.`);
        }
      }

      logger.warn(
        'No music loaded from Notion. Ensure NOTION_API_KEY and NOTION_MUSIC_DB_ID are configured.'
      );
      const emptyFavorites = Array.from({ length: 10 }, (_, i) => ({
        title: `Favorite ${i + 1}`,
        artist: 'Artist',
        cover: '/assets/covers/placeholder-album.svg',
        blurb: ''
      }));
      const fallbackMusic = {
        updated: new Date(),
        favorites: emptyFavorites,
        vinyl: [],
        recommendation: {
          title: 'Recommendation',
          artist: 'Artist',
          cover: '/assets/covers/placeholder-album.svg',
          rating: 8.0
        },
        recentListen: {
          title: 'Recent Listen',
          artist: 'Artist',
          cover: '/assets/covers/placeholder-album.svg',
          rating: 8.0
        }
      };
      const data = await parseData({ id: 'content', data: fallbackMusic });
      store.set({ id: 'content', data });
    }
  };
}
