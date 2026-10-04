import { getEntry } from 'astro:content';

export interface SiteConfig {
  name: string;
  role: string;
  location: string;
  timezone: string;
  email: string;
  github: string;
  linkedin: string;
  ratingMax: number;
  description?: string;
}

export const defaultSiteConfig: SiteConfig = {
  name: '',
  role: '',
  location: '',
  timezone: 'America/Los_Angeles',
  email: '',
  github: '',
  linkedin: '',
  ratingMax: 10,
  description: '',
};

export const siteConfig = defaultSiteConfig;

/**
 * Fetch dynamic site config from Notion with graceful fallback to defaultSiteConfig.
 */
export async function getSiteConfig(): Promise<SiteConfig> {
  try {
    const entry = await getEntry('settings', 'config');
    if (entry?.data) {
      return {
        name: entry.data.name || defaultSiteConfig.name,
        role: entry.data.role || defaultSiteConfig.role,
        location: entry.data.location || defaultSiteConfig.location,
        timezone: (entry.data as any).timezone || defaultSiteConfig.timezone,
        email: entry.data.email || defaultSiteConfig.email,
        github: entry.data.github || defaultSiteConfig.github,
        linkedin: entry.data.linkedin || defaultSiteConfig.linkedin,
        ratingMax: entry.data.ratingMax ?? defaultSiteConfig.ratingMax,
        description: entry.data.description || defaultSiteConfig.description,
      };
    }
  } catch {
    // Return fallback
  }
  return defaultSiteConfig;
}

