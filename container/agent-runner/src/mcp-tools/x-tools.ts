/**
 * X (Twitter) MCP tools — post, like, reply, retweet, quote.
 *
 * Uses cookie-based auth via X_AUTH_TOKEN env var (no X API key needed).
 * Tools are only registered if X_AUTH_TOKEN is set.
 *
 * The host-side handler reads IPC task files written by the container and
 * dispatches them to the x-integration skill. Result files are written back
 * by the host for the container to read.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN || '';

// IPC directories — v2 session layout: session dir is mounted at /workspace
const X_TASKS_DIR = path.join('/workspace', 'x_tasks');
const X_RESULTS_DIR = path.join('/workspace', 'x_results');

function generateId(): string {
  return `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

async function writeXTask(type: string, payload: Record<string, unknown>): Promise<string> {
  fs.mkdirSync(X_TASKS_DIR, { recursive: true });
  const requestId = generateId();
  const taskFile = path.join(X_TASKS_DIR, `${requestId}.json`);
  fs.writeFileSync(taskFile, JSON.stringify({ type, requestId, ...payload }), 'utf8');
  return requestId;
}

async function waitForXResult(
  requestId: string,
  maxWait = 60_000,
): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(X_RESULTS_DIR, `${requestId}.json`);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const raw = fs.readFileSync(resultFile, 'utf8');
        const result = JSON.parse(raw) as { success: boolean; message: string };
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        // malformed — keep waiting
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { success: false, message: 'X operation timed out after 60s' };
}

async function xAction(
  type: string,
  payload: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const requestId = await writeXTask(type, payload);
    const result = await waitForXResult(requestId);
    return result.success ? ok(result.message) : err(result.message);
  } catch (e) {
    return err(`X operation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const xPost: McpToolDefinition = {
  tool: {
    name: 'x_post',
    description: 'Post a tweet on X (Twitter). Max 280 characters. Always confirm with the user before posting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Tweet text (max 280 chars)' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text?.trim()) return err('text is required');
    if (text.length > 280) return err('Tweet exceeds 280 characters');
    return xAction('x_post', { text });
  },
};

const xLike: McpToolDefinition = {
  tool: {
    name: 'x_like',
    description: 'Like a tweet on X (Twitter) by its URL or tweet ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tweet_id: { type: 'string', description: 'Tweet ID or full tweet URL' },
      },
      required: ['tweet_id'],
    },
  },
  async handler(args) {
    const tweetId = args.tweet_id as string;
    if (!tweetId?.trim()) return err('tweet_id is required');
    return xAction('x_like', { tweet_id: tweetId });
  },
};

const xReply: McpToolDefinition = {
  tool: {
    name: 'x_reply',
    description: 'Reply to a tweet on X (Twitter).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tweet_id: { type: 'string', description: 'Tweet ID or URL to reply to' },
        text: { type: 'string', description: 'Reply text (max 280 chars)' },
      },
      required: ['tweet_id', 'text'],
    },
  },
  async handler(args) {
    const tweetId = args.tweet_id as string;
    const text = args.text as string;
    if (!tweetId?.trim()) return err('tweet_id is required');
    if (!text?.trim()) return err('text is required');
    if (text.length > 280) return err('Reply exceeds 280 characters');
    return xAction('x_reply', { tweet_id: tweetId, text });
  },
};

const xRetweet: McpToolDefinition = {
  tool: {
    name: 'x_retweet',
    description: 'Retweet a tweet on X (Twitter).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tweet_id: { type: 'string', description: 'Tweet ID or URL to retweet' },
      },
      required: ['tweet_id'],
    },
  },
  async handler(args) {
    const tweetId = args.tweet_id as string;
    if (!tweetId?.trim()) return err('tweet_id is required');
    return xAction('x_retweet', { tweet_id: tweetId });
  },
};

const xQuote: McpToolDefinition = {
  tool: {
    name: 'x_quote',
    description: 'Quote-tweet a tweet on X (Twitter).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tweet_id: { type: 'string', description: 'Tweet ID or URL to quote' },
        text: { type: 'string', description: 'Quote tweet text (max 280 chars)' },
      },
      required: ['tweet_id', 'text'],
    },
  },
  async handler(args) {
    const tweetId = args.tweet_id as string;
    const text = args.text as string;
    if (!tweetId?.trim()) return err('tweet_id is required');
    if (!text?.trim()) return err('text is required');
    if (text.length > 280) return err('Quote text exceeds 280 characters');
    return xAction('x_quote', { tweet_id: tweetId, text });
  },
};

if (X_AUTH_TOKEN) {
  registerTools([xPost, xLike, xReply, xRetweet, xQuote]);
}
