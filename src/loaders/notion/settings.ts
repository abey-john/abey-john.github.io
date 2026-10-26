import type { Loader, LoaderContext } from 'astro/loaders';
import { NOTION_API_KEY, notionRequest } from './client';

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
            timezone: kv['timezone'] || 'America/Los_Angeles',
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
        timezone: 'America/Los_Angeles',
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
