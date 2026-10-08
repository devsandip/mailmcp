import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Hono } from 'hono';
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { KmsCipher } from './crypto.js';
import { publicPages } from './pages.js';
import { DynamoStore } from './store/dynamo.js';

let handler: ReturnType<typeof handle> | undefined;

async function loadSecrets() {
  const prefix = process.env.SSM_PREFIX ?? '/mailmcp';
  const names = [`${prefix}/google-client-id`, `${prefix}/google-client-secret`];
  const res = await new SSMClient({}).send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  const value = (name: string) => {
    const v = res.Parameters?.find((p) => p.Name === name)?.Value;
    if (!v) throw new Error(`Missing SSM parameter ${name}`);
    return v;
  };
  return { googleClientId: value(names[0]!), googleClientSecret: value(names[1]!) };
}

async function init(): Promise<ReturnType<typeof handle>> {
  const config = configFromEnv(process.env, await loadSecrets());
  const app: Hono = createApp({
    config,
    store: new DynamoStore(process.env.TABLE_NAME!),
    cipher: new KmsCipher(process.env.KMS_KEY_ID!),
  });
  return handle(app);
}

/** Serves the public pages and a 503 elsewhere until setup is complete. */
function setupIncomplete(reason: string): ReturnType<typeof handle> {
  const app = publicPages(process.env.PUBLIC_BASE_URL);
  app.all('*', (c) => c.json({ error: 'server_not_configured', error_description: reason }, 503));
  return handle(app);
}

export async function main(event: LambdaEvent, context: LambdaContext) {
  if (!handler) {
    try {
      handler = await init();
    } catch (err) {
      // Not cached: the next request retries, so adding the SSM parameters needs no redeploy.
      const reason = err instanceof Error ? err.message : String(err);
      console.error('init failed:', reason);
      return setupIncomplete(reason)(event, context);
    }
  }
  return handler(event, context);
}
