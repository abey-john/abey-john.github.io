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
  role: 'Software Development Engineer II at AWS',
  location: 'Seattle, WA',
  email: 'abeyjohnv@gmail.com',
  github: 'https://github.com/abey-john',
  linkedin: 'https://www.linkedin.com/in/abey-john/',
  ratingMax: 10,
};
