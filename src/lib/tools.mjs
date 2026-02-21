import { webSearch } from './search.mjs';

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const MAX_SEARCH_CALLS = 3;
const MAX_FETCH_CALLS = 5;

export const FETCH_URL_TOOL = {
  toolSpec: {
    name: 'fetch_url',
    description:
      'Fetch and read the content of a web page. Use when you need detailed content from a specific URL. When citing, use inline clickable markdown links like [[1]](URL).',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (must start with http:// or https://)',
          },
        },
        required: ['url'],
      },
    },
  },
};

export const WEB_SEARCH_TOOL = {
  toolSpec: {
    name: 'web_search',
    description:
      'Search Google for information. Use when you need to discover relevant pages. LIMITED to 3 calls per message — this is a paid API so be strategic. Search snippets often contain enough info, only fetch a page if you truly need more detail. When citing, use inline clickable markdown links like [[1]](URL), [[2]](URL).',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up on Google',
          },
        },
        required: ['query'],
      },
    },
  },
};

/**
 * Returns toolConfig for Bedrock.
 * - fetch_url is always available (headless Chromium)
 * - web_search only when SERPER_API_KEY is set
 * - mcpTools are appended when MCP servers are configured
 * @param {Array} mcpTools - Optional array of Bedrock-compatible MCP tool specs
 */
export function getToolConfig(mcpTools = []) {
  const tools = [FETCH_URL_TOOL];
  if (SERPER_API_KEY) tools.push(WEB_SEARCH_TOOL);
  tools.push(...mcpTools);
  return { tools };
}

/**
 * Citation instruction to append to system messages when tools are available.
 * Citations use inline clickable markdown links so users can click the number directly.
 */
export const CITATION_SYSTEM_PROMPT = {
  text: `You have access to tools including web_search, fetch_url, and possibly MCP server tools. Be efficient and cost-conscious: web_search is a paid API limited to 3 calls per message, so make each search count. Prefer using search snippets directly over fetching full pages. For MCP tools, use them as needed but don't over-complicate — answer the question directly with minimal tool calls. When citing sources, use inline clickable markdown links: [[n]](URL). Do NOT add a separate Sources section.`
};

/**
 * Creates a tool executor with a per-request call counter.
 * @param {Function|null} mcpExecutor - Optional MCP tool executor from initMcpServers()
 */
export function createToolExecutor(mcpExecutor = null) {
  let searchCallCount = 0;
  let fetchCallCount = 0;

  return {
    async run(name, input) {
      if (name === 'web_search') {
        if (searchCallCount >= MAX_SEARCH_CALLS) {
          return { text: `Search limit reached (max ${MAX_SEARCH_CALLS} per message). Summarize your findings now using the information you already have.` };
        }
        if (!SERPER_API_KEY) {
          return { text: 'Web search is not available (SERPER_API_KEY not configured).' };
        }
        searchCallCount++;
        const results = await webSearch(input.query, 5);
        const formatted = results
          .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
          .join('\n\n');
        return { text: formatted || 'No results found.' };
      }

      if (name === 'fetch_url') {
        if (fetchCallCount >= MAX_FETCH_CALLS) {
          return { text: `Fetch limit reached (max ${MAX_FETCH_CALLS} per message). Summarize your findings now using the information you already have.` };
        }
        fetchCallCount++;
        const content = await fetchUrl(input.url);
        return { text: content };
      }

      // Route to MCP executor for any mcp_ prefixed tools
      if (name.startsWith('mcp_') && mcpExecutor) {
        return await mcpExecutor(name, input);
      }

      return { text: `Unknown tool: ${name}` };
    },
    get searchCalls() { return searchCallCount; },
    get fetchCalls() { return fetchCallCount; },
  };
}

const MAX_FETCH_SIZE = 12_000;

async function fetchUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Invalid URL: must start with http:// or https://';
  }

  // Try headless Chromium first
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = (await import('puppeteer-core')).default;

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (compatible; BedrockGateway/1.0)');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15_000 });
      await new Promise(r => setTimeout(r, 1000));

      const text = await page.evaluate(() => {
        const remove = document.querySelectorAll('script, style, nav, footer, header, iframe, noscript');
        remove.forEach(el => el.remove());
        return document.body?.innerText || '';
      });

      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 100) {
        return cleaned.slice(0, MAX_FETCH_SIZE);
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn('Chromium fetch failed, falling back to plain fetch:', err.message);
  }

  // Fallback: plain HTTP fetch
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BedrockGateway/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!res.ok) return `Failed to fetch URL (HTTP ${res.status})`;

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    if (contentType.includes('html')) {
      const cleaned = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      return cleaned.slice(0, MAX_FETCH_SIZE);
    }

    return text.slice(0, MAX_FETCH_SIZE);
  } catch (err) {
    if (err.name === 'AbortError') return 'Request timed out (10s limit)';
    return `Fetch error: ${err.message}`;
  } finally {
    clearTimeout(timeout);
  }
}
