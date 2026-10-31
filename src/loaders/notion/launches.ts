import type { Loader, LoaderContext } from 'astro/loaders';
import { NOTION_API_KEY, queryNotionDatabase } from './client';
import { extractImageSource } from './images';

export function notionLaunchesLoader(): Loader {
  return {
    name: 'notion-launches-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_LAUNCHES_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const results = await queryNotionDatabase(dbId, {
            sorts: [{ property: 'Order', direction: 'ascending' }],
          });

          store.clear();

          for (const page of results) {
            try {
              const p = page.properties;
              const title = p.Title?.title?.[0]?.plain_text || 'Untitled';

              const id =
                title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/(^-|-$)/g, '') || page.id;
              const image = (await extractImageSource(p.Image, p.ImagePath)) || undefined;

              let itemUrl = p.URL?.url || p.URL?.rich_text?.[0]?.plain_text || '';
              if (
                itemUrl &&
                !/^https?:\/\//i.test(itemUrl) &&
                !itemUrl.startsWith('#') &&
                !itemUrl.startsWith('/')
              ) {
                itemUrl = `https://${itemUrl}`;
              }
              if (!itemUrl) itemUrl = '#';

              const item = {
                id,
                category: (p.Category?.select?.name || 'professional') as
                  | 'professional'
                  | 'personal',
                title,
                url: itemUrl,
                role: p.Role?.rich_text?.[0]?.plain_text || '',
                date: p.Date?.rich_text?.[0]?.plain_text || undefined,
                image,
                order: p.Order?.number ?? 0,
              };

              const data = await parseData({ id, data: item });
              store.set({ id, data });
            } catch (itemErr: any) {
              logger.warn(`Failed loading launch item ${page.id}: ${itemErr.message}. Skipping item.`);
            }
          }

          logger.info(`Loaded ${results.length} launches from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading launches from Notion: ${err.message}.`);
        }
      }

      logger.warn(
        'No launches loaded from Notion. Ensure NOTION_API_KEY and NOTION_LAUNCHES_DB_ID are configured.'
      );
      store.clear();
    },
  };
}
