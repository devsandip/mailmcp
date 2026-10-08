import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { Accounts } from '../accounts.js';
import { AccountError } from '../accounts.js';
import type { Config } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import { escapeHtml, page } from '../html.js';
import type { Store } from '../store/types.js';
import { GMAIL_SCOPES, GoogleAuthError, decodeIdToken, type GoogleOAuth } from './google.js';

export interface AuthDeps {
  config: Config;
  store: Store;
  google: GoogleOAuth;
  accounts: Accounts;
}

export interface ClientRecord {
  clientId: string;
  clientSecretHash?: string;
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  createdAt: string;
}

type PendingLogin = {
  kind: 'login';
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState?: string;
  resource?: string;
};
type PendingLink = { kind: 'link'; alias: string; readOnly: boolean; loginHint?: string };
type Pending = PendingLogin | PendingLink;

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  owner: string;
  resource?: string;
}

export interface TokenRecord {
  clientId: string;
  owner: string;
  resource?: string;
}

export interface LinkTokenRecord {
  alias: string;
  readOnly: boolean;
  loginHint?: string;
}

const PENDING_TTL = 600;
const CODE_TTL = 300;
export const LINK_TTL = 900;

export function baseUrl(c: Context, config: Config): string {
  return config.publicBaseUrl ?? new URL(c.req.url).origin;
}

export function googleCallbackUrl(base: string): string {
  return `${base}/oauth/google/callback`;
}

export function isAllowedRedirect(uri: string, allowedHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) return false;
  const loopback = host === 'localhost' || host === '127.0.0.1';
  return url.protocol === 'https:' || (loopback && url.protocol === 'http:');
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  return c.json({ error, error_description: description }, status, { 'cache-control': 'no-store' });
}

export async function issueTokens(deps: AuthDeps, rec: TokenRecord) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await deps.store.put(`access#${sha256(accessToken)}`, rec, deps.config.accessTokenTtlSeconds);
  await deps.store.put(`refresh#${sha256(refreshToken)}`, rec, deps.config.refreshTokenTtlSeconds);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: deps.config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: 'mcp',
  };
}

/** Resolves a bearer token presented to /mcp. */
export async function verifyAccessToken(
  store: Store,
  header: string | undefined,
): Promise<TokenRecord | undefined> {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return undefined;
  return store.get<TokenRecord>(`access#${sha256(match[1]!)}`);
}

export function authRoutes(deps: AuthDeps): Hono {
  const { config, store, google, accounts } = deps;
  const app = new Hono();

  const protectedResource = (c: Context) => {
    const base = baseUrl(c, config);
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const serverMetadata = (c: Context) => {
    const base = baseUrl(c, config);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', serverMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);
  app.get('/.well-known/openid-configuration', serverMetadata);

  // RFC 7591 dynamic client registration. Redirects are limited to known hosts so a
  // stranger cannot register a client that ships authorization codes elsewhere.
  app.post('/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 'invalid_client_metadata', 'Body must be JSON');
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return oauthError(c, 'invalid_redirect_uri', 'redirect_uris is required');
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !isAllowedRedirect(uri, config.allowedRedirectHosts)) {
        return oauthError(c, 'invalid_redirect_uri', `Redirect URI not allowed: ${String(uri)}`);
      }
    }
    const requested = body.token_endpoint_auth_method;
    const method: ClientRecord['tokenEndpointAuthMethod'] =
      requested === 'client_secret_post' || requested === 'client_secret_basic'
        ? requested
        : 'none';
    const clientId = randomToken(16);
    const clientSecret = method === 'none' ? undefined : randomToken();
    const record: ClientRecord = {
      clientId,
      clientSecretHash: clientSecret ? sha256(clientSecret) : undefined,
      redirectUris: redirectUris as string[],
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      tokenEndpointAuthMethod: method,
      createdAt: new Date().toISOString(),
    };
    await store.put(`client#${clientId}`, record);
    return c.json(
      {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: record.redirectUris,
        client_name: record.clientName,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  });

  app.get('/authorize', async (c) => {
    const q = c.req.query();
    const client = q.client_id ? await store.get<ClientRecord>(`client#${q.client_id}`) : undefined;
    if (!client) {
      return c.html(page('Unknown client', '<p>This client is not registered.</p>'), 400);
    }
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return c.html(
        page('Bad redirect', '<p>redirect_uri does not match the registration.</p>'),
        400,
      );
    }
    const back = (error: string, description: string) => {
      const url = new URL(q.redirect_uri!);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (q.state) url.searchParams.set('state', q.state);
      return c.redirect(url.toString());
    };
    if (q.response_type !== 'code')
      return back('unsupported_response_type', 'Use response_type=code');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE with S256 is required');
    }
    const state = randomToken();
    const pending: PendingLogin = {
      kind: 'login',
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      clientState: q.state,
      resource: q.resource,
    };
    await store.put(`pending#${state}`, pending, PENDING_TTL);
    const base = baseUrl(c, config);
    return c.redirect(google.authUrl({ redirectUri: googleCallbackUrl(base), state, scopes: [] }));
  });

  // Starts linking a Gmail account. The token comes from the add_account tool.
  app.get('/link/start', async (c) => {
    const token = c.req.query('t');
    const link = token
      ? await store.take<LinkTokenRecord>(`linktoken#${sha256(token)}`)
      : undefined;
    if (!link) {
      return c.html(
        page(
          'Link expired',
          '<p>This link was already used or has expired. Ask Claude to run <code>add_account</code> again.</p>',
        ),
        400,
      );
    }
    const state = randomToken();
    const pending: PendingLink = { kind: 'link', ...link };
    await store.put(`pending#${state}`, pending, PENDING_TTL);
    const base = baseUrl(c, config);
    return c.redirect(
      google.authUrl({
        redirectUri: googleCallbackUrl(base),
        state,
        scopes: [link.readOnly ? GMAIL_SCOPES.readOnly : GMAIL_SCOPES.full],
        offline: true,
        loginHint: link.loginHint,
      }),
    );
  });

  app.get('/oauth/google/callback', async (c) => {
    const { state, code, error } = c.req.query();
    const pending = state ? await store.take<Pending>(`pending#${state}`) : undefined;
    if (!pending) {
      return c.html(page('Session expired', '<p>Start again from Claude.</p>'), 400);
    }
    if (error || !code) {
      if (pending.kind === 'login') {
        const url = new URL(pending.redirectUri);
        url.searchParams.set('error', 'access_denied');
        if (pending.clientState) url.searchParams.set('state', pending.clientState);
        return c.redirect(url.toString());
      }
      return c.html(
        page('Not linked', `<p>Google returned: ${escapeHtml(error ?? 'no code')}</p>`),
        400,
      );
    }

    const base = baseUrl(c, config);
    let tokens;
    try {
      tokens = await google.exchangeCode(code, googleCallbackUrl(base));
    } catch (err) {
      const message = err instanceof GoogleAuthError ? err.message : 'Token exchange failed';
      return c.html(page('Google sign-in failed', `<p>${escapeHtml(message)}</p>`), 502);
    }
    if (!tokens.id_token) {
      return c.html(page('Google sign-in failed', '<p>No identity returned.</p>'), 502);
    }
    const claims = decodeIdToken(tokens.id_token);
    if (!claims.email_verified) {
      return c.html(
        page('Unverified email', '<p>This Google account has no verified email.</p>'),
        403,
      );
    }

    if (pending.kind === 'login') {
      if (!config.ownerEmails.includes(claims.email)) {
        return c.html(
          page('Not allowed', `<p>${escapeHtml(claims.email)} is not an owner of this server.</p>`),
          403,
        );
      }
      const authCode = randomToken();
      const rec: CodeRecord = {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        owner: claims.email,
        resource: pending.resource,
      };
      await store.put(`code#${sha256(authCode)}`, rec, CODE_TTL);
      const url = new URL(pending.redirectUri);
      url.searchParams.set('code', authCode);
      if (pending.clientState) url.searchParams.set('state', pending.clientState);
      return c.redirect(url.toString());
    }

    const wanted = pending.readOnly ? GMAIL_SCOPES.readOnly : GMAIL_SCOPES.full;
    const granted = tokens.scope.split(' ');
    if (!granted.includes(wanted)) {
      return c.html(
        page(
          'Gmail access not granted',
          '<p>Google did not grant Gmail access. Run <code>add_account</code> again and leave the Gmail box checked on the consent screen.</p>',
        ),
        400,
      );
    }
    if (!tokens.refresh_token) {
      return c.html(
        page(
          'No refresh token',
          '<p>Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and try again.</p>',
        ),
        400,
      );
    }
    try {
      const account = await accounts.save({
        email: claims.email,
        alias: pending.alias,
        readOnly: pending.readOnly,
        scopes: granted,
        refreshToken: tokens.refresh_token,
      });
      return c.html(
        page(
          'Account linked',
          `<p>Linked <strong>${escapeHtml(account.email)}</strong> as <code>${escapeHtml(account.alias)}</code>${account.readOnly ? ' (read-only)' : ''}. You can close this tab and go back to Claude.</p>`,
        ),
      );
    } catch (err) {
      const message = err instanceof AccountError ? err.message : 'Could not save the account';
      return c.html(page('Not linked', `<p>${escapeHtml(message)}</p>`), 400);
    }
  });

  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) =>
      typeof form[name] === 'string' ? (form[name] as string) : undefined;

    let clientId = field('client_id');
    let clientSecret = field('client_secret');
    const basic = c.req.header('authorization')?.match(/^Basic\s+(.+)$/i);
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }
    const client = clientId ? await store.get<ClientRecord>(`client#${clientId}`) : undefined;
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client', 401);
    if (
      client.clientSecretHash &&
      (!clientSecret || sha256(clientSecret) !== client.clientSecretHash)
    ) {
      return oauthError(c, 'invalid_client', 'Bad client credentials', 401);
    }

    const grant = field('grant_type');
    if (grant === 'authorization_code') {
      const code = field('code');
      const rec = code ? await store.take<CodeRecord>(`code#${sha256(code)}`) : undefined;
      if (!rec || rec.clientId !== client.clientId) {
        return oauthError(c, 'invalid_grant', 'Code is invalid, expired, or already used');
      }
      if (field('redirect_uri') && field('redirect_uri') !== rec.redirectUri) {
        return oauthError(c, 'invalid_grant', 'redirect_uri mismatch');
      }
      const verifier = field('code_verifier');
      if (!verifier || !pkceMatches(verifier, rec.codeChallenge)) {
        return oauthError(c, 'invalid_grant', 'PKCE verification failed');
      }
      if (!config.ownerEmails.includes(rec.owner)) {
        return oauthError(c, 'invalid_grant', 'Owner no longer allowed');
      }
      const tokens = await issueTokens(deps, {
        clientId: client.clientId,
        owner: rec.owner,
        resource: rec.resource,
      });
      return c.json(tokens, 200, { 'cache-control': 'no-store' });
    }

    if (grant === 'refresh_token') {
      const token = field('refresh_token');
      const rec = token ? await store.take<TokenRecord>(`refresh#${sha256(token)}`) : undefined;
      if (!rec || rec.clientId !== client.clientId) {
        return oauthError(c, 'invalid_grant', 'Refresh token is invalid or expired');
      }
      if (!config.ownerEmails.includes(rec.owner)) {
        return oauthError(c, 'invalid_grant', 'Owner no longer allowed');
      }
      const tokens = await issueTokens(deps, rec);
      return c.json(tokens, 200, { 'cache-control': 'no-store' });
    }

    return oauthError(c, 'unsupported_grant_type', `Unsupported grant_type: ${grant ?? 'none'}`);
  });

  return app;
}
