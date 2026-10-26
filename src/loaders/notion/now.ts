import type { Loader, LoaderContext } from 'astro/loaders';
import { NOTION_API_KEY, notionRequest } from './client';
import { blocksToMarkdown, makeExternalLinksOpenInNewTab } from './text';

export function notionNowLoader(): Loader {
  return {
    name: 'notion-now-loader',
    load: async ({ store, logger, parseData, renderMarkdown }: LoaderContext) => {
      const pageId = process.env.NOTION_NOW_PAGE_ID;

      if (NOTION_API_KEY && pageId) {
        try {
          const pageRes = await notionRequest(`pages/${pageId}`);
          const blocksRes = await notionRequest(`blocks/${pageId}/children?page_size=100`);

          let updatedDate = pageRes.last_edited_time
            ? new Date(pageRes.last_edited_time)
            : new Date();

          // Check if there is an explicit "Updated: <date>" block (callout or text)
          const nowBlocks: any[] = [];
          for (const b of blocksRes.results || []) {
            const blockContent = b[b.type];
            const text = Array.isArray(blockContent?.rich_text)
              ? blockContent.rich_text.map((t: any) => t.plain_text || '').join('').trim()
              : '';

            const match = text.match(/^updated:\s*(.+)$/i);
            if (match) {
              const rawDateStr = match[1].trim();
              const parsedUtc = new Date(
                rawDateStr.endsWith('UTC') ? rawDateStr : `${rawDateStr} UTC`
              );
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
          if (rendered && typeof rendered.html === 'string') {
            rendered.html = makeExternalLinksOpenInNewTab(rendered.html);
          }
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

      logger.warn(
        'No Now updates loaded from Notion. Ensure NOTION_API_KEY and NOTION_NOW_PAGE_ID are configured.'
      );
      const markdown = 'Currently updating...';
      const rendered = await renderMarkdown(markdown);
      const data = await parseData({ id: 'index', data: { updated: new Date() } });
      store.set({ id: 'index', data, body: markdown, rendered });
    },
  };
}
