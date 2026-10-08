import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { Accounts } from './accounts.js';
import { GoogleOAuth, type Fetch } from './auth/google.js';
import { authRoutes, baseUrl, verifyAccessToken } from './auth/oauth.js';
import type { Config } from './config.js';
import type { TokenCipher } from './crypto.js';
import { createMcpServer } from './mcp/server.js';
import { publicPages } from './pages.js';
import type { Store } from './store/types.js';

export interface AppDeps {
  config: Config;
  store: Store;
  cipher: TokenCipher;
  fetch?: Fetch;
}

export function createApp(deps: AppDeps): Hono {
  const fetchImpl = deps.fetch ?? fetch;
  const google = new GoogleOAuth(
    deps.config.googleClientId,
    deps.config.googleClientSecret,
    fetchImpl,
  );
  const accounts = new Accounts(deps.store, deps.cipher, google);
  const app = new Hono();

  app.route('/', publicPages(deps.config.publicBaseUrl));
  app.route('/', authRoutes({ config: deps.config, store: deps.store, google, accounts }));

  // Stateless MCP: a fresh server and transport per request, JSON responses, no sessions.
  // That fits Lambda, where consecutive requests may land on different instances.
  app.all('/mcp', async (c) => {
    const base = baseUrl(c, deps.config);
    const token = await verifyAccessToken(deps.store, c.req.header('authorization'));
    if (!token || !deps.config.ownerEmails.includes(token.owner)) {
      return c.json(
        { error: 'invalid_token', error_description: 'Missing or expired access token' },
        401,
        {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
    }
    if (c.req.method !== 'POST') {
      return c.json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
    }
    const server = createMcpServer({
      accounts,
      store: deps.store,
      config: deps.config,
      baseUrl: base,
      fetch: fetchImpl,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token: 'redacted',
          clientId: token.clientId,
          scopes: ['mcp'],
          extra: { owner: token.owner },
        },
      });
    } finally {
      await server.close();
    }
  });

  return app;
}
