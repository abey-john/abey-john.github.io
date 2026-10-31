import type { Loader, LoaderContext } from 'astro/loaders';
import { NOTION_API_KEY, notionRequest } from './client';
import { downloadRemoteImage } from './images';
import {
  richTextToMarkdown,
  blocksToMarkdown,
  makeExternalLinksOpenInNewTab
} from './text';

export function notionAboutLoader(): Loader {
  return {
    name: 'notion-about-loader',
    load: async ({
      store,
      logger,
      parseData,
      renderMarkdown
    }: LoaderContext) => {
      const pageId = process.env.NOTION_ABOUT_PAGE_ID;

      if (NOTION_API_KEY && pageId) {
        try {
          const pageRes = await notionRequest(`pages/${pageId}`);
          const blocksRes = await notionRequest(
            `blocks/${pageId}/children?page_size=100`
          );

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
            const rawUrl =
              pageRes.cover?.file?.url || pageRes.cover?.external?.url;
            if (rawUrl) {
              photoUrl = await downloadRemoteImage(rawUrl);
            }
          }

          // 3. Check if page has an Icon uploaded (for avatar)
          let avatarUrl: string | undefined;
          if (
            pageRes.icon &&
            (pageRes.icon.type === 'file' || pageRes.icon.type === 'external')
          ) {
            const rawUrl = pageRes.icon.file?.url || pageRes.icon.external?.url;
            if (rawUrl) {
              avatarUrl = await downloadRemoteImage(rawUrl);
            }
          }

          // Exclude the extracted image block from the bio text flow
          const bioBlocks = blocksRes.results.filter(
            (b: any) => b.type !== 'image'
          );
          const markdown = await blocksToMarkdown(bioBlocks);

          store.clear();

          const rendered = await renderMarkdown(markdown);
          if (rendered && typeof rendered.html === 'string') {
            rendered.html = makeExternalLinksOpenInNewTab(rendered.html);
          }
          const data = await parseData({
            id: 'index',
            data: {
              title: 'About',
              photo: photoUrl,
              photoCaption: photoCaption || undefined,
              photoAlt: photoCaption || 'Profile photo',
              avatar: avatarUrl
            }
          });

          store.set({
            id: 'index',
            data,
            body: markdown,
            rendered
          });

          logger.info(`Loaded About bio & photo from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading About from Notion: ${err.message}.`);
        }
      }

      logger.warn(
        'No About bio loaded from Notion. Ensure NOTION_API_KEY and NOTION_ABOUT_PAGE_ID are configured.'
      );
      const markdown = '';
      const rendered = await renderMarkdown(markdown);
      const data = await parseData({ id: 'index', data: { title: 'About' } });
      store.set({ id: 'index', data, body: markdown, rendered });
    }
  };
}
