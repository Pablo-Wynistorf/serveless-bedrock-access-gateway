const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const SERPER_URL = 'https://google.serper.dev/search';

/**
 * Search the web using Serper.dev (Google Search API).
 * Returns an array of { title, url, snippet } objects.
 */
export async function webSearch(query, count = 5) {
  if (!SERPER_API_KEY) {
    console.error('SERPER_API_KEY not configured');
    return [];
  }

  const res = await fetch(SERPER_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: count }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Serper API error ${res.status}: ${text}`);
    return [];
  }

  const data = await res.json();
  const items = (data.organic || []).slice(0, count);

  return items.map(r => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
  }));
}
