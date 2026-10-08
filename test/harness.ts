import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { clearTokenCache } from '../src/accounts.js';
import { DEFAULT_REDIRECT_HOSTS, type Config } from '../src/config.js';
import { LocalCipher } from '../src/crypto.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeGoogle } from './fakes.js';

export const BASE = 'https://mail.example.test';
export const OWNER = 'owner@gmail.com';
export const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

export interface Harness {
  app: Hono;
  google: FakeGoogle;
  store: MemoryStore;
  config: Config;
}

export function makeHarness(overrides: Partial<Config> = {}): Harness {
  clearTokenCache();
  const google = new FakeGoogle();
  const store = new MemoryStore();
  const config: Config = {
    ownerEmails: [OWNER],
    googleClientId: 'gid',
    googleClientSecret: 'gsecret',
    allowedRedirectHosts: DEFAULT_REDIRECT_HOSTS,
    publicBaseUrl: BASE,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    ...overrides,
  };
  const app = createApp({ config, store, cipher: new LocalCipher('test'), fetch: google.fetch });
  return { app, google, store, config };
}

export const req = (h: Harness, path: string, init?: RequestInit) =>
  h.app.request(`${BASE}${path}`, init);

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function register(h: Harness, redirect = CLAUDE_REDIRECT) {
  const res = await req(h, '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
    }),
  });
  return { res, body: (await res.json()) as { client_id: string; error?: string } };
}

/** Walks /authorize -> Google -> callback and returns Claude's redirect URL. */
export async function authorize(h: Harness, clientId: string, challenge: string, signInAs = OWNER) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'claude-state',
    resource: `${BASE}/mcp`,
  });
  const toGoogle = await req(h, `/authorize?${q}`);
  const googleUrl = new URL(toGoogle.headers.get('location')!);
  const code = `gcode-${randomBytes(4).toString('hex')}`;
  h.google.codes.set(code, { email: signInAs, scope: 'openid email' });
  const cb = await req(
    h,
    `/oauth/google/callback?state=${googleUrl.searchParams.get('state')}&code=${code}`,
  );
  return { toGoogle, googleUrl, callback: cb };
}

export async function connectClaude(h: Harness): Promise<string> {
  const { body } = await register(h);
  const { verifier, challenge } = pkce();
  const { callback } = await authorize(h, body.client_id, challenge);
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
  const tok = await req(h, '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: body.client_id,
      redirect_uri: CLAUDE_REDIRECT,
      code_verifier: verifier,
    }),
  });
  return ((await tok.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
export async function rpc(h: Harness, token: string, method: string, params: unknown = {}) {
  const res = await req(h, '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: any } };
}

export async function callTool(
  h: Harness,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { body } = await rpc(h, token, 'tools/call', { name, arguments: args });
  if (body.error) throw new Error(JSON.stringify(body.error));
  const result = body.result as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(result.isError), data, content: result.content };
}

/** Links a Gmail account through add_account -> /link/start -> Google -> callback. */
export async function linkAccount(
  h: Harness,
  token: string,
  alias: string,
  email: string,
  opts: { readOnly?: boolean; grantScope?: string } = {},
) {
  const { data } = await callTool(h, token, 'add_account', {
    alias,
    email,
    readOnly: opts.readOnly,
  });
  const start = await req(h, new URL(data.url).pathname + new URL(data.url).search);
  const googleUrl = new URL(start.headers.get('location')!);
  const code = `link-${randomBytes(4).toString('hex')}`;
  const scope =
    opts.grantScope ??
    `openid email ${opts.readOnly ? 'https://www.googleapis.com/auth/gmail.readonly' : 'https://www.googleapis.com/auth/gmail.modify'}`;
  h.google.codes.set(code, { email, scope });
  const cb = await req(
    h,
    `/oauth/google/callback?state=${googleUrl.searchParams.get('state')}&code=${code}`,
  );
  return { googleUrl, callback: cb, html: await cb.text() };
}
