import { describe, expect, it } from 'vitest';
import {
  BASE,
  CLAUDE_REDIRECT,
  authorize,
  connectClaude,
  makeHarness,
  pkce,
  register,
  req,
  rpc,
} from './harness.js';

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

describe('discovery', () => {
  it('returns 401 with resource metadata pointer on /mcp without a token', async () => {
    const h = makeHarness();
    const res = await req(h, '/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('publishes protected resource and authorization server metadata', async () => {
    const h = makeHarness();
    const pr = await (await req(h, '/.well-known/oauth-protected-resource/mcp')).json();
    expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = await (await req(h, '/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({
      issuer: BASE,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('client registration', () => {
  it('accepts Claude redirect URIs', async () => {
    const { res, body } = await register(makeHarness());
    expect(res.status).toBe(201);
    expect(body.client_id).toBeTruthy();
  });

  it('rejects redirect URIs on unknown hosts', async () => {
    const { res, body } = await register(makeHarness(), 'https://evil.example/cb');
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('allows http only on loopback', async () => {
    expect((await register(makeHarness(), 'http://localhost:33418/callback')).res.status).toBe(201);
    expect((await register(makeHarness(), 'http://claude.ai/cb')).res.status).toBe(400);
  });
});

describe('authorization code flow', () => {
  it('sends the owner to Google sign-in without Gmail scopes', async () => {
    const h = makeHarness();
    const { body } = await register(h);
    const { googleUrl } = await authorize(h, body.client_id, pkce().challenge);
    expect(googleUrl.origin + googleUrl.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(googleUrl.searchParams.get('scope')).toBe('openid email');
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
  });

  it('issues tokens that open /mcp, and lists every tool', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    const { status, body } = await rpc(h, token, 'tools/list');
    expect(status).toBe(200);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        'add_account',
        'apply_sensitive_message_label',
        'apply_sensitive_thread_label',
        'create_draft',
        'create_label',
        'delete_draft',
        'delete_label',
        'forward',
        'get_attachment',
        'get_draft',
        'get_message',
        'get_thread',
        'label_message',
        'label_thread',
        'list_accounts',
        'list_drafts',
        'list_labels',
        'mark_message_spam',
        'mark_thread_spam',
        'remove_account',
        'reply',
        'search_threads',
        'send_message',
        'trash_message',
        'trash_thread',
        'unlabel_message',
        'unlabel_thread',
        'unmark_message_spam',
        'unmark_thread_spam',
        'untrash_message',
        'untrash_thread',
        'update_draft',
        'update_label',
        'update_message_labels',
      ].sort(),
    );
  });

  it('refuses Google accounts that are not owners', async () => {
    const h = makeHarness();
    const { body } = await register(h);
    const { callback } = await authorize(h, body.client_id, pkce().challenge, 'stranger@gmail.com');
    expect(callback.status).toBe(403);
  });

  it('rejects a wrong PKCE verifier and single-uses codes', async () => {
    const h = makeHarness();
    const { body } = await register(h);
    const { verifier, challenge } = pkce();
    const { callback } = await authorize(h, body.client_id, challenge);
    const redirect = new URL(callback.headers.get('location')!);
    expect(redirect.searchParams.get('state')).toBe('claude-state');
    const code = redirect.searchParams.get('code')!;
    const bad = await req(
      h,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        client_id: body.client_id,
        code_verifier: 'wrong',
        redirect_uri: CLAUDE_REDIRECT,
      }),
    );
    expect(bad.status).toBe(400);
    // The failed attempt consumed the code.
    const again = await req(
      h,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        client_id: body.client_id,
        code_verifier: verifier,
        redirect_uri: CLAUDE_REDIRECT,
      }),
    );
    expect((await again.json()).error).toBe('invalid_grant');
  });

  it('rejects authorize requests without PKCE', async () => {
    const h = makeHarness();
    const { body } = await register(h);
    const res = await req(
      h,
      `/authorize?response_type=code&client_id=${body.client_id}&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}&state=s`,
    );
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
  });

  it('rotates refresh tokens', async () => {
    const h = makeHarness();
    const { body } = await register(h);
    const { verifier, challenge } = pkce();
    const { callback } = await authorize(h, body.client_id, challenge);
    const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
    const first = await (
      await req(
        h,
        '/token',
        form({
          grant_type: 'authorization_code',
          code,
          client_id: body.client_id,
          code_verifier: verifier,
        }),
      )
    ).json();
    const second = await req(
      h,
      '/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: body.client_id,
      }),
    );
    expect(second.status).toBe(200);
    const reused = await req(
      h,
      '/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: body.client_id,
      }),
    );
    expect(reused.status).toBe(400);
  });

  it('stops accepting tokens once the owner is removed from the allowlist', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    h.config.ownerEmails = ['someone-else@gmail.com'];
    const { status } = await rpc(h, token, 'tools/list');
    expect(status).toBe(401);
  });
});
