import type { APIRoute } from 'astro';

const routes = ['', '/development', '/travel', '/music', '/now'];

export const GET: APIRoute = async ({ site }) => {
  const baseUrl = site ? site.href.replace(/\/$/, '') : 'https://abey-john.github.io';

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (route) => `  <url>
    <loc>${baseUrl}${route}</loc>
    <changefreq>monthly</changefreq>
  </url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml',
    },
  });
};
