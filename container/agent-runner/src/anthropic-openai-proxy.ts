import http from 'http';
import { AddressInfo } from 'net';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, JsonValue>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, JsonValue>;
}

interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?:
    | { type: 'auto' | 'any' }
    | { type: 'tool'; name: string }
    | { type: 'none' };
  stream?: boolean;
  metadata?: Record<string, JsonValue>;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: OpenAiChatMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function toJsonValue<T>(value: T): JsonValue {
  return value as unknown as JsonValue;
}

interface ProxyHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function resolveBaseUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\//, ''), normalizedBase).toString();
}

function contentBlocksFromText(text: string): AnthropicTextBlock[] {
  return text ? [{ type: 'text', text }] : [];
}

function anthropicContentToText(
  content: string | AnthropicTextBlock[] | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function parseJsonObject(
  input: string | undefined,
): Record<string, JsonValue> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as JsonValue;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : { value: parsed };
  } catch {
    return { raw: input };
  }
}

function stringifyToolResultContent(
  content: AnthropicToolResultBlock['content'],
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

export function anthropicRequestToOpenAiChat(
  request: AnthropicRequest,
): Record<string, JsonValue> {
  const messages: OpenAiChatMessage[] = [];

  const systemText =
    typeof request.system === 'string'
      ? request.system
      : anthropicContentToText(request.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({
        role: message.role,
        content: message.content,
      });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAiToolCall[] = [];

    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        continue;
      }

      if (block.type === 'tool_use' && message.role === 'assistant') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
        continue;
      }

      if (block.type === 'tool_result' && message.role === 'user') {
        const text = stringifyToolResultContent(block.content);
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: text || (block.is_error ? 'Tool execution failed' : ''),
        });
      }
    }

    if (message.role === 'assistant') {
      if (textParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join('\n').trim() || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    const userText = textParts.join('\n').trim();
    if (userText) {
      messages.push({
        role: 'user',
        content: userText,
      });
    }
  }

  const tools = request.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));

  let toolChoice: JsonValue | undefined;
  if (request.tool_choice?.type === 'any') {
    toolChoice = 'required';
  } else if (request.tool_choice?.type === 'tool') {
    toolChoice = {
      type: 'function',
      function: {
        name: request.tool_choice.name,
      },
    };
  } else if (request.tool_choice?.type === 'none') {
    toolChoice = 'none';
  } else if (request.tool_choice?.type === 'auto') {
    toolChoice = 'auto';
  }

  return {
    model: request.model,
    messages: toJsonValue(messages),
    ...(typeof request.max_tokens === 'number'
      ? { max_tokens: request.max_tokens }
      : {}),
    ...(typeof request.temperature === 'number'
      ? { temperature: request.temperature }
      : {}),
    ...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
    ...(Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0
      ? { stop: request.stop_sequences }
      : {}),
    ...(tools && tools.length > 0 ? { tools: toJsonValue(tools) } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    stream: false,
  };
}

export function openAiResponseToAnthropic(
  response: OpenAiChatResponse,
  fallbackModel: string,
): Record<string, JsonValue> {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const content: AnthropicContentBlock[] = [];

  if (typeof message?.content === 'string' && message.content.trim()) {
    content.push(...contentBlocksFromText(message.content));
  }

  for (const toolCall of message?.tool_calls || []) {
    const name = toolCall.function?.name;
    if (!name) continue;
    content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name,
      input: parseJsonObject(toolCall.function?.arguments),
    });
  }

  const finishReason = choice?.finish_reason || 'stop';
  const stopReason =
    finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return {
    id: response.id || `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: response.model || fallbackModel,
    content: toJsonValue(content),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function proxyPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBaseUrl: string,
): Promise<void> {
  const body = await readRequestBody(req);
  const upstreamUrl = resolveBaseUrl(upstreamBaseUrl, req.url || '/');
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  headers.delete('host');
  headers.delete('content-length');

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body:
      req.method === 'GET' || req.method === 'HEAD' || body.length === 0
        ? undefined
        : body,
  });

  res.statusCode = upstreamResponse.status;
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (key.toLowerCase() === 'content-length') continue;
    res.setHeader(key, value);
  }

  const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.end(buffer);
}

export function shouldEnableAnthropicOpenAiProxy(
  upstreamBaseUrl: string | undefined,
): boolean {
  if (!upstreamBaseUrl) return false;
  if (process.env.NANOCLAW_DISABLE_OPENAI_CHAT_PROXY === '1') return false;
  return !upstreamBaseUrl.includes('api.anthropic.com');
}

export async function startAnthropicOpenAiProxy(
  upstreamBaseUrl: string,
): Promise<ProxyHandle> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        const rawBody = await readRequestBody(req);
        const request = JSON.parse(rawBody) as AnthropicRequest;
        const openAiRequest = anthropicRequestToOpenAiChat(request);
        const upstreamUrl = resolveBaseUrl(
          upstreamBaseUrl,
          '/v1/chat/completions',
        );

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          if (Array.isArray(value)) {
            for (const entry of value) headers.append(key, entry);
          } else {
            headers.set(key, value);
          }
        }
        headers.set('content-type', 'application/json');
        headers.delete('content-length');
        headers.delete('host');

        const upstreamResponse = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(openAiRequest),
        });
        const responseText = await upstreamResponse.text();

        res.statusCode = upstreamResponse.status;
        if (!upstreamResponse.ok) {
          res.setHeader('content-type', 'application/json');
          res.end(responseText);
          return;
        }

        const openAiResponse = JSON.parse(responseText) as OpenAiChatResponse;
        const anthropicResponse = openAiResponseToAnthropic(
          openAiResponse,
          request.model,
        );
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(anthropicResponse));
        return;
      }

      await proxyPassthrough(req, res, upstreamBaseUrl);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            type: 'proxy_error',
            message:
              error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
