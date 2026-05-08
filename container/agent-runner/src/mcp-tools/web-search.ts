/**
 * web_search MCP tool — DuckDuckGo HTML scraping, no API key required.
 *
 * Fallback search for agent groups not using Anthropic's native WebSearch.
 * Returns top 5 results + fetched plain text of the top result (max 5000 chars).
 */
import https from 'https';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

async function httpGet(url: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function httpPost(
  url: string,
  body: string,
  headers?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ddgSearch(query: string): Promise<Array<{ url: string; title: string }>> {
  const body = `q=${encodeURIComponent(query)}&kl=kr`;
  const html = await httpPost('https://html.duckduckgo.com/html/', body, {
    'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/2.0)',
    Referer: 'https://duckduckgo.com/',
  });

  const results: Array<{ url: string; title: string }> = [];
  // Parse result links: <a class="result__a" href="...">title</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < 5) {
    const rawUrl = m[1];
    const title = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const uddUrl = /uddg=([^&]+)/.exec(rawUrl);
    const finalUrl = uddUrl ? decodeURIComponent(uddUrl[1]) : rawUrl;
    if (finalUrl.startsWith('http')) {
      results.push({ url: finalUrl, title });
    }
  }
  return results;
}

async function fetchPlainText(url: string, maxChars = 5000): Promise<string> {
  try {
    const html = await httpGet(url, {
      'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/2.0)',
    });
    // Strip tags, collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

export const webSearch: McpToolDefinition = {
  tool: {
    name: 'web_search',
    description:
      'Search the web using DuckDuckGo. Returns up to 5 results and the plain text of the top result. No API key required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = args.query as string;
    if (!query?.trim()) return err('query is required');

    let results: Array<{ url: string; title: string }>;
    try {
      results = await ddgSearch(query);
    } catch (e) {
      return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (results.length === 0) {
      return ok('No results found.');
    }

    const lines: string[] = results.map((r, i) => `${i + 1}. [${r.title}](${r.url})`);

    // Fetch top result text
    const topText = await fetchPlainText(results[0].url);
    if (topText) {
      lines.push('', `Top result content (${results[0].url}):`, topText);
    }

    return ok(lines.join('\n'));
  },
};

registerTools([webSearch]);
