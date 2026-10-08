/**
 * Local development server. Uses an in-memory store (state is lost on restart) and a
 * local AES key instead of KMS. Google must list http://localhost:8787/oauth/google/callback
 * as a redirect URI on the OAuth client for sign-in to work locally.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { LocalCipher } from './crypto.js';
import { MemoryStore } from './store/memory.js';

const port = Number(process.env.PORT ?? 8787);
const config = configFromEnv(process.env, {
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
});
const app = createApp({
  config,
  store: new MemoryStore(),
  cipher: new LocalCipher(process.env.LOCAL_CIPHER_SECRET ?? 'dev-only-secret'),
});

serve({ fetch: app.fetch, port }, () =>
  console.log(`mailmcp dev server on http://localhost:${port}`),
);
