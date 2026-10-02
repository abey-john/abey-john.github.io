export interface SiteConfig {
  name: string;
  role: string;
  location: string;
  email: string;
  github: string;
  linkedin: string;
  ratingMax: number;
}

export const siteConfig: SiteConfig = {
  name: 'Abey John',
  role: 'PLACEHOLDER: role line',
  location: 'PLACEHOLDER: location line',
  email: 'PLACEHOLDER: email address',
  github: 'https://github.com/abey-john',
  linkedin: 'PLACEHOLDER: linkedin profile URL',
  ratingMax: 10,
};
