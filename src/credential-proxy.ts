/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { gunzip } from 'zlib';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'auth-token' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface AnthropicMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function resolveUpstreamPath(
  upstreamUrl: URL,
  requestUrl: string | undefined,
): string {
  const normalizedBase = upstreamUrl.href.endsWith('/')
    ? upstreamUrl.href
    : `${upstreamUrl.href}/`;
  const resolved = new URL(
    (requestUrl || '/').replace(/^\//, ''),
    normalizedBase,
  );
  return `${resolved.pathname}${resolved.search}`;
}

function normalizeAnthropicMessageResponse(
  requestUrl: string | undefined,
  responseBody: Buffer,
  logMissingUsage: (body: string) => void,
): Buffer {
  if (!(requestUrl || '').startsWith('/v1/messages')) {
    return responseBody;
  }

  try {
    const parsed = JSON.parse(responseBody.toString('utf8')) as {
      usage?: AnthropicMessageUsage;
    };

    if (
      !parsed.usage ||
      typeof parsed.usage.input_tokens !== 'number' ||
      typeof parsed.usage.output_tokens !== 'number'
    ) {
      logMissingUsage(responseBody.toString('utf8').slice(0, 2000));
    }

    parsed.usage = {
      input_tokens: parsed.usage?.input_tokens ?? 0,
      output_tokens: parsed.usage?.output_tokens ?? 0,
      cache_creation_input_tokens:
        parsed.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
    };

    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return responseBody;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : secrets.ANTHROPIC_AUTH_TOKEN
      ? 'auth-token'
      : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // Native Anthropic API key: inject x-api-key on every request.
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (authMode === 'auth-token') {
          // OpenRouter-style auth token: preserve the SDK's bearer flow.
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.ANTHROPIC_AUTH_TOKEN}`;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Strip Anthropic-specific query params unsupported by third-party providers
        const isThirdParty = upstreamUrl.hostname !== 'api.anthropic.com';
        let upstreamPath = resolveUpstreamPath(upstreamUrl, req.url);
        if (isThirdParty) {
          const [pathPart, queryPart] = upstreamPath.split('?');
          if (queryPart) {
            const filtered = new URLSearchParams(queryPart);
            filtered.delete('beta');
            const remaining = filtered.toString();
            upstreamPath = remaining ? `${pathPart}?${remaining}` : pathPart;
          }
        }

        // Mock Anthropic-only endpoints for third-party providers
        if (isThirdParty && (req.url || '').includes('/v1/messages/count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 0 }));
          return;
        }

        // Strip Anthropic-native tools unsupported by third-party providers;
        // also log the resolved model for every /v1/messages call.
        let forwardBody = body;
        if (
          isThirdParty &&
          (req.url || '').includes('/v1/messages') &&
          req.method === 'POST'
        ) {
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed.model) {
              logger.info(
                { model: parsed.model, path: req.url },
                'Credential proxy forwarding API call',
              );
            }
            if (Array.isArray(parsed.tools)) {
              const filtered = parsed.tools.filter(
                (t: { type?: string; name?: string }) =>
                  t.type !== 'web_search_20250305' &&
                  !/^web_search/.test(t.name ?? ''),
              );
              if (filtered.length !== parsed.tools.length) {
                parsed.tools = filtered;
                forwardBody = Buffer.from(JSON.stringify(parsed), 'utf8');
                headers['content-length'] = forwardBody.length;
              }
            }
          } catch {
            // not valid JSON — pass through unchanged
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const responseChunks: Buffer[] = [];
            upRes.on('data', (chunk) => {
              responseChunks.push(
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
              );
            });
            upRes.on('end', () => {
              const rawResponseBody = Buffer.concat(responseChunks);
              const responseBody =
                (upRes.statusCode || 500) < 400
                  ? normalizeAnthropicMessageResponse(
                      req.url,
                      rawResponseBody,
                      (body) =>
                        logger.warn(
                          {
                            method: req.method,
                            path: req.url,
                            upstreamPath: resolveUpstreamPath(
                              upstreamUrl,
                              req.url,
                            ),
                            body,
                          },
                          'Credential proxy upstream success response missing Anthropic usage fields',
                        ),
                    )
                  : rawResponseBody;
              if ((upRes.statusCode || 500) >= 400) {
                const logError = (bodyText: string) =>
                  logger.warn(
                    {
                      statusCode: upRes.statusCode,
                      method: req.method,
                      path: req.url,
                      upstreamPath,
                      body: bodyText.slice(0, 2000),
                    },
                    'Credential proxy upstream returned error response',
                  );
                const encoding = upRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                  gunzip(rawResponseBody, (_err, buf) => {
                    logError(_err ? rawResponseBody.toString('utf8') : buf.toString('utf8'));
                  });
                } else {
                  logError(rawResponseBody.toString('utf8'));
                }
              }

              res.writeHead(upRes.statusCode!, upRes.headers);
              res.end(responseBody);
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(forwardBody);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);

  if (secrets.ANTHROPIC_API_KEY) {
    return 'api-key';
  }

  if (secrets.ANTHROPIC_AUTH_TOKEN) {
    return 'auth-token';
  }

  return 'oauth';
}
