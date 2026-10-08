import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_REDIRECT_HOSTS } from '../src/config.js';
import { LocalCipher } from '../src/crypto.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeGoogle } from './fakes.js';

const HOST = 'abc123.lambda-url.us-east-1.on.aws';

function urlEvent(
  method: string,
  path: string,
  opts: { body?: string; base64?: boolean; headers?: Record<string, string>; query?: string } = {},
): LambdaEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: opts.query ?? '',
    headers: { host: HOST, ...(opts.headers ?? {}) },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123',
      domainName: HOST,
      domainPrefix: 'abc123',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
      requestId: 'r',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
    },
    body:
      opts.body === undefined
        ? undefined
        : opts.base64
          ? Buffer.from(opts.body).toString('base64')
          : opts.body,
    isBase64Encoded: Boolean(opts.base64),
  } as unknown as LambdaEvent;
}

function makeHandler() {
  const google = new FakeGoogle();
  const app = createApp({
    config: {
      ownerEmails: ['owner@gmail.com'],
      googleClientId: 'gid',
      googleClientSecret: 'gs',
      allowedRedirectHosts: DEFAULT_REDIRECT_HOSTS,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 3600,
    },
    store: new MemoryStore(),
    cipher: new LocalCipher('t'),
    fetch: google.fetch,
  });
  return handle(app);
}

const ctx = {} as LambdaContext;

describe('Lambda Function URL adapter', () => {
  it('derives the public base URL from the Function URL host', async () => {
    const handler = makeHandler();
    const res = (await handler(
      urlEvent('GET', '/.well-known/oauth-authorization-server'),
      ctx,
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).token_endpoint).toBe(`https://${HOST}/token`);
  });

  it('parses base64-encoded form bodies on /token', async () => {
    const handler = makeHandler();
    const res = (await handler(
      urlEvent('POST', '/token', {
        body: 'grant_type=refresh_token&refresh_token=nope&client_id=missing',
        base64: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
      ctx,
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_client');
  });

  it('accepts JSON registration and returns 401 with metadata on /mcp', async () => {
    const handler = makeHandler();
    const reg = (await handler(
      urlEvent('POST', '/register', {
        body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
        headers: { 'content-type': 'application/json' },
      }),
      ctx,
    )) as { statusCode: number };
    expect(reg.statusCode).toBe(201);
    const mcp = (await handler(urlEvent('POST', '/mcp', { body: '{}' }), ctx)) as {
      statusCode: number;
      headers: Record<string, string>;
    };
    expect(mcp.statusCode).toBe(401);
    expect(mcp.headers['www-authenticate']).toContain(
      `https://${HOST}/.well-known/oauth-protected-resource/mcp`,
    );
  });
});
