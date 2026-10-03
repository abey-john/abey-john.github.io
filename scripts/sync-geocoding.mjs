#!/usr/bin/env node
import 'dotenv/config';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PLACES_DB_ID = process.env.NOTION_PLACES_DB_ID;
const NOTION_VERSION = '2022-06-28';

if (!NOTION_API_KEY || !NOTION_PLACES_DB_ID) {
  console.error('Error: NOTION_API_KEY and NOTION_PLACES_DB_ID must be set in your .env file.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function notionRequest(endpoint, method = 'GET', body = null) {
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API Error (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

async function geocodeLocation(name, country) {
  // 1. Try Open-Meteo Geocoding API
  try {
    const cleanName = name.replace(/,.*$/, '').trim();
    const searchUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanName || name)}&count=5&language=en&format=json`;
    const res = await fetch(searchUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        let match = data.results[0];
        if (country) {
          const countryLower = country.toLowerCase();
          const found = data.results.find((r) =>
            r.country?.toLowerCase().includes(countryLower) ||
            countryLower.includes(r.country?.toLowerCase())
          );
          if (found) match = found;
        }
        return {
          lat: Math.round(Number(match.latitude) * 100000) / 100000,
          lng: Math.round(Number(match.longitude) * 100000) / 100000,
          source: 'Open-Meteo',
        };
      }
    }
  } catch {}

  // 2. Fallback to OpenStreetMap Nominatim
  try {
    const query = [name, country].filter(Boolean).join(', ');
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PersonalWebsiteGeocoding/1.0' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return {
          lat: Math.round(parseFloat(data[0].lat) * 100000) / 100000,
          lng: Math.round(parseFloat(data[0].lon) * 100000) / 100000,
          source: 'Nominatim',
        };
      }
    }
  } catch {}

  return null;
}

async function main() {
  console.log('Fetching places from Notion database...');

  let pages = [];
  let cursor = undefined;

  do {
    const res = await notionRequest(`databases/${NOTION_PLACES_DB_ID}/query`, 'POST', {
      page_size: 100,
      start_cursor: cursor,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log(`Retrieved ${pages.length} total places from Notion.\n`);

  const missing = [];
  for (const page of pages) {
    const p = page.properties;
    const name = p.Name?.title?.[0]?.plain_text || 'Untitled';
    const country = p.Country?.rich_text?.[0]?.plain_text || '';
    const lat = typeof p.Latitude?.number === 'number' ? p.Latitude.number : null;
    const lng = typeof p.Longitude?.number === 'number' ? p.Longitude.number : null;

    if (lat === null || lng === null || (lat === 0 && lng === 0)) {
      missing.push({ id: page.id, name, country });
    }
  }

  if (missing.length === 0) {
    console.log('✓ All places in Notion already have Latitude and Longitude coordinates!');
    console.log('  Builds will be instantaneous.');
    return;
  }

  console.log(`Found ${missing.length} place(s) missing coordinates in Notion.`);
  console.log('Geocoding and saving coordinates directly to Notion...\n');

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];
    const progress = `[${i + 1}/${missing.length}]`;

    process.stdout.write(`${progress} Geocoding "${item.name}"... `);

    const coords = await geocodeLocation(item.name, item.country);

    if (!coords) {
      console.log('❌ Failed to locate');
      failCount++;
      await sleep(350);
      continue;
    }

    try {
      await notionRequest(`pages/${item.id}`, 'PATCH', {
        properties: {
          Latitude: { number: coords.lat },
          Longitude: { number: coords.lng },
        },
      });

      console.log(`✓ [${coords.lat}, ${coords.lng}] via ${coords.source} (saved to Notion)`);
      successCount++;
    } catch (err) {
      console.log(`❌ Error saving to Notion: ${err.message}`);
      failCount++;
    }

    // Rate-limit pause between Notion updates (safe 350ms)
    await sleep(350);
  }

  console.log('\n--- Sync Complete ---');
  console.log(`Successfully updated: ${successCount}`);
  if (failCount > 0) {
    console.log(`Failed or not found:  ${failCount}`);
  }
  console.log('All future local and GitHub Actions builds will now load coordinates instantly!');
}

main().catch((err) => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
