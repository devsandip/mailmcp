import { Hono } from 'hono';
import { escapeHtml, page } from './html.js';

/** Pages that must work even before the Google client secrets are configured. */
export function publicPages(publicBaseUrl?: string): Hono {
  const app = new Hono();
  // Google requires a home page and privacy policy link before an OAuth app can be published.
  app.get('/', (c) =>
    c.html(
      page(
        'mailmcp',
        `<p>A personal, self-hosted server that lets Claude read and manage the owner's Gmail accounts. It is not a public service and only its owner can sign in.</p><p>MCP endpoint: <code>${escapeHtml(publicBaseUrl ?? new URL(c.req.url).origin)}/mcp</code></p><p><a href="/privacy">Privacy policy</a></p>`,
      ),
    ),
  );
  app.get('/privacy', (c) =>
    c.html(
      page(
        'mailmcp privacy policy',
        `<p>mailmcp is a personal server operated by its owner for their own Google accounts. It is not offered to the public.</p>
<p><strong>What it accesses.</strong> Gmail data (messages, threads, drafts, labels, attachments) of accounts the owner links, using Google's Gmail API scopes the owner approves. It also receives the email address of the signed-in Google account.</p>
<p><strong>How data is used.</strong> Gmail data is fetched only when the owner's AI assistant calls a tool, and is returned to that assistant. Gmail content is not stored by this server, not used for advertising, not sold, and not shared with any other party.</p>
<p><strong>What is stored.</strong> For each linked account: its email address, a short alias, and a Google OAuth refresh token encrypted with AWS KMS, kept in the owner's own AWS account. Short-lived sign-in records expire automatically.</p>
<p><strong>Removal.</strong> Unlinking an account revokes the Google grant and deletes its stored token. Access can also be revoked at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<p>mailmcp's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>`,
      ),
    ),
  );
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
