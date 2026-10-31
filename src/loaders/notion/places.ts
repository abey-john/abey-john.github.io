import type { Loader, LoaderContext } from 'astro/loaders';
import { NOTION_API_KEY, queryNotionDatabase } from './client';
import { extractImageSource } from './images';
import { richTextToHtml } from './text';
import { geocodeLocation } from './geo';

export function notionPlacesLoader(): Loader {
  return {
    name: 'notion-places-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_PLACES_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const allResults = await queryNotionDatabase(dbId);

          store.clear();

          for (const page of allResults) {
            const p = page.properties;
            const name = (p.Name?.title?.[0]?.plain_text || 'Untitled').trim();
            const id = page.id;
            const photo = await extractImageSource(p.Photo, p.PhotoPath);
            const country = (
              p.Country?.rich_text?.[0]?.plain_text ||
              p.Country?.select?.name ||
              ''
            ).trim();
            const state = (
              p.State?.rich_text?.[0]?.plain_text ||
              p.State?.select?.name ||
              ''
            ).trim();

            let lat = typeof p.Latitude?.number === 'number' ? p.Latitude.number : null;
            let lng = typeof p.Longitude?.number === 'number' ? p.Longitude.number : null;

            // Auto-infer coordinates if not explicitly provided in Notion
            if (lat === null || lng === null || (lat === 0 && lng === 0)) {
              const geocoded = await geocodeLocation(name, country, state);
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

            const rawType = (p.Type?.select?.name || '').toLowerCase();
            let placeType: 'city' | 'park' | 'landmark' | 'venue' = 'city';

            if (
              rawType.includes('venue') ||
              rawType.includes('stadium') ||
              rawType.includes('concert') ||
              rawType.includes('arena')
            ) {
              placeType = 'venue';
            } else if (rawType.includes('landmark')) {
              placeType = 'landmark';
            } else if (rawType.includes('park') || rawType.includes('nature')) {
              placeType = 'park';
            } else if (rawType.includes('city')) {
              placeType = 'city';
            }

            const item = {
              id,
              name,
              type: placeType,
              lat,
              lng,
              country,
              state: state || undefined,
              blurb: richTextToHtml(p.Blurb?.rich_text) || undefined,
              photo: photo || undefined,
              link: undefined,
            };

            const data = await parseData({ id, data: item });
            store.set({ id, data });
          }

          logger.info(`Loaded ${allResults.length} places from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading places from Notion: ${err.message}.`);
        }
      }

      logger.warn(
        'No places loaded from Notion. Ensure NOTION_API_KEY and NOTION_PLACES_DB_ID are configured.'
      );
      store.clear();
    },
  };
}
