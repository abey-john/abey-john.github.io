import 'dotenv/config';

export const NOTION_API_KEY = process.env.NOTION_API_KEY;
export const NOTION_VERSION = '2022-06-28';

/**
 * Perform an authenticated request to the Notion API.
 */
export async function notionRequest(endpoint: string, method: string = 'GET', body: any = null): Promise<any> {
  if (!NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not configured');
  }

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
