import type { Loader, LoaderContext } from 'astro/loaders';
import dotenv from 'dotenv';
import { NOTION_API_KEY, notionRequest, queryNotionDatabase } from './client';
import { extractImageSource } from './images';
import { blocksToMarkdown, makeExternalLinksOpenInNewTab } from './text';

/**
 * Fetch all block children for a given Notion page, paginating until exhausted.
 */
async function fetchAllPageBlocks(pageId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const endpoint = `blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const res = await notionRequest(endpoint);
    if (Array.isArray(res.results)) {
      blocks.push(...res.results);
    }
    hasMore = Boolean(res.has_more && res.next_cursor);
    cursor = res.next_cursor || undefined;
  }

  return blocks;
}

export function notionNowLoader(): Loader {
  return {
    name: 'notion-now-loader',
    load: async ({
      store,
      logger,
      parseData,
      renderMarkdown
    }: LoaderContext) => {
      dotenv.config();
      const dbId = process.env.NOTION_NOW_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          const results = await queryNotionDatabase(dbId, {
            sorts: [{ property: 'Date', direction: 'descending' }]
          });

          if (results.length > 0) {
            store.clear();

            // Exclude entries explicitly marked hidden (via Status="Hidden" or Hidden checkbox/select)
            const visiblePages = results.filter((page: any) => {
              const p = page.properties;
              const statusName = p?.Status?.select?.name?.toLowerCase()?.trim();
              if (statusName === 'hidden') return false;
              if (p?.Hidden?.checkbox === true) return false;
              if (p?.Hidden?.select?.name?.toLowerCase()?.trim() === 'hidden')
                return false;
              return true;
            });

            if (visiblePages.length > 0) {
              // Prefer row with Status = "Now" or "Current", fallback to newest row by Date
              let currentIndex = visiblePages.findIndex((page: any) => {
                const statusName =
                  page.properties?.Status?.select?.name?.toLowerCase();
                return statusName === 'now' || statusName === 'current';
              });
              if (currentIndex === -1) {
                currentIndex = 0;
              }

              for (let i = 0; i < visiblePages.length; i++) {
                const page = visiblePages[i];
                try {
                  const p = page.properties;
                  const title = p.Title?.title?.[0]?.plain_text?.trim() || '';
                  const isCurrent = i === currentIndex;
                  const status = p.Status?.select?.name || undefined;
                  const caption =
                    p.Caption?.rich_text?.[0]?.plain_text?.trim() || undefined;

                  // Date parsing with timezone safety for date-only strings (YYYY-MM-DD)
                  let date: Date;
                  const rawDateStr = p.Date?.date?.start;
                  if (rawDateStr) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDateStr)) {
                      date = new Date(`${rawDateStr}T12:00:00Z`);
                    } else {
                      date = new Date(rawDateStr);
                    }
                  } else if (page.last_edited_time) {
                    date = new Date(page.last_edited_time);
                  } else {
                    date = new Date();
                  }

                  // Extract featured snapshot photo if present
                  let photo: string | undefined;
                  const photoSrc = await extractImageSource(p.Photo, undefined);
                  if (photoSrc) {
                    photo = photoSrc;
                  }

                  // Fetch page body blocks and convert to Markdown
                  const pageBlocks = await fetchAllPageBlocks(page.id);
                  const markdown = await blocksToMarkdown(pageBlocks);

                  const rendered = await renderMarkdown(markdown);
                  if (rendered && typeof rendered.html === 'string') {
                    rendered.html = makeExternalLinksOpenInNewTab(
                      rendered.html
                    );
                  }

                  const item = {
                    id: page.id,
                    title: title || undefined,
                    date,
                    photo,
                    caption,
                    status,
                    isCurrent
                  };

                  const data = await parseData({
                    id: page.id,
                    data: item
                  });

                  store.set({
                    id: page.id,
                    data,
                    body: markdown,
                    rendered
                  });
                } catch (itemErr: any) {
                  logger.warn(
                    `Failed loading Now snapshot ${page.id}: ${itemErr.message}. Skipping snapshot.`
                  );
                }
              }

              logger.info(
                `Loaded ${store.keys().length} Now & Then snapshots from Notion database.`
              );
              return;
            }
          }
        } catch (err: any) {
          logger.warn(
            `Failed loading Now snapshots from Notion database: ${err.message}.`
          );
        }
      }

      logger.warn(
        'No Now snapshots loaded from Notion database. Ensure NOTION_API_KEY and NOTION_NOW_DB_ID are configured.'
      );
      store.clear();
      const markdown = 'Currently updating...';
      const rendered = await renderMarkdown(markdown);
      const fallbackItem = {
        id: 'index',
        title: 'Now',
        date: new Date(),
        isCurrent: true
      };
      const data = await parseData({
        id: 'index',
        data: fallbackItem
      });
      store.set({ id: 'index', data, body: markdown, rendered });
    }
  };
}
