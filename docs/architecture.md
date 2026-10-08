# Architecture

## Goal

One MCP endpoint that gives Claude (web, desktop, mobile, Claude Code) access to several Gmail and Google Workspace accounts at once, without routing mail or tokens through a third-party service.

## Components

| Piece | Role |
|---|---|
| CloudFront distribution | Public URL; forwards everything to the Function URL, no caching |
| Lambda@Edge (origin response) | Restores the `WWW-Authenticate` header that Function URLs rename |
| Lambda (Node 24, arm64) behind a Function URL | Hono app: OAuth server for Claude, Google OAuth client, MCP endpoint |
| DynamoDB, single table (`pk`, `sk`, `ttl`) | OAuth clients, pending redirects, auth codes, access/refresh tokens, linked accounts |
| KMS key | Encrypts each Google refresh token, with the account email as encryption context |
| SSM Parameter Store | Google OAuth client ID and secret (SecureString) |

## Request flows

**Claude connects (once per client):**
1. Claude calls `/mcp`, gets 401 with `WWW-Authenticate: Bearer resource_metadata=...`.
2. Claude reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
3. Claude registers itself at `/register` (RFC 7591). Redirect URIs must be on `claude.ai`, `claude.com`, or loopback.
4. `/authorize` (PKCE S256 required) redirects to Google sign-in with `openid email` only.
5. `/oauth/google/callback` checks the email is in `OWNER_EMAILS`, issues a 5-minute single-use code, and redirects back to Claude.
6. `/token` exchanges the code (PKCE verified) for a 1-hour access token and a 30-day rotating refresh token. Tokens are random strings stored as SHA-256 hashes.

**Linking a Gmail account:**
1. The `add_account` tool stores a one-time link token (15 minutes) and returns `/link/start?t=...`.
2. `/link/start` redirects to Google with `gmail.modify` (or `gmail.readonly`), `access_type=offline`, `prompt=consent`.
3. The callback checks the Gmail scope was actually granted (users can untick it), encrypts the refresh token with KMS, and stores `account#<email>`.

**Tool calls:**
- `/mcp` is stateless Streamable HTTP with JSON responses: a fresh `McpServer` per request, no sessions. That suits Lambda, where requests can land on different instances.
- Each call resolves `account` (alias or email), gets a Google access token (cached in memory on warm instances, refreshed from the stored refresh token), and calls the Gmail REST API directly with `fetch`.
- If Google returns `invalid_grant`, the account is flagged `needsRelink` and tools tell Claude to run `add_account` again.

## Decisions

- **Own OAuth server instead of a managed IdP (Cognito, Auth0).** Claude needs DCR and PKCE. Cognito has no DCR. The flow is about 300 lines and fully tested. Google sign-in is the identity check.
- **Gmail REST via `fetch`, not the `googleapis` package.** Smaller bundle (1.1MB minified), faster cold starts, fewer dependencies. MIME building uses nodemailer's `MailComposer`, which is well tested.
- **Function URL instead of API Gateway.** Free, 15-minute timeout, 6MB responses. That 6MB limit is why `get_attachment` caps at 4MB.
- **CloudFront plus Lambda@Edge in front of the Function URL.** Function URLs (and API Gateway) rename `WWW-Authenticate` to `x-amzn-Remapped-WWW-Authenticate`. claude.ai relies on that header on a 401 to find the OAuth metadata. A CloudFront Function cannot fix it because CloudFront skips viewer-response functions on 4xx/5xx; a Lambda@Edge origin-response trigger runs on all statuses. Side effect: the Lambda sees the Function URL host, so the public URL is passed in as `PUBLIC_BASE_URL` (second deploy with `-c publicBaseUrl`). Deleting the stack later is slow because Lambda@Edge replicas take hours to clean up.
- **Single owner model.** Everyone in `OWNER_EMAILS` sees all linked accounts. This is a personal server, not multi-tenant.
- **Tool surface mirrors Google's Gmail MCP** (names, parameters, formats), so Claude's existing habits with the built-in connector carry over. `search_threads` and `list_drafts` fan out across accounts when `account` is omitted; their page tokens encode one Gmail page token per account.
- **Fixed redirect host allowlist on `/register`.** Stops anyone from registering a client that sends codes to their own server and phishing the owner into signing in.
- **Table and KMS key are retained on stack deletion.** Losing them means re-linking every account.
