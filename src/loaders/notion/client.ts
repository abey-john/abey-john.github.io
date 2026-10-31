import 'dotenv/config';

export const NOTION_API_KEY = process.env.NOTION_API_KEY;
export const NOTION_VERSION = '2022-06-28';

/**
 * Perform an authenticated request to the Notion API.
 */
export async function notionRequest(
  endpoint: string,
  method: string = 'GET',
  body: any = null
): Promise<any> {
  if (!NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not configured');
  }

  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Notion API Error (${res.status}): ${data.message || JSON.stringify(data)}`
    );
  }
  return data;
}

/**
 * Query a Notion database and automatically paginate through all result pages.
 */
export async function queryNotionDatabase(
  dbId: string,
  queryBody: Record<string, any> = {}
): Promise<any[]> {
  const allResults: any[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, any> = { page_size: 100, ...queryBody };
    if (startCursor) body.start_cursor = startCursor;
    const res = await notionRequest(`databases/${dbId}/query`, 'POST', body);
    if (Array.isArray(res.results)) {
      allResults.push(...res.results);
    }
    hasMore = Boolean(res.has_more && res.next_cursor);
    startCursor = res.next_cursor || undefined;
  }

  return allResults;
}
