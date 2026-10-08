# mailmcp

A self-hosted Gmail MCP server that lets Claude work with several Google accounts at once: gmail.com addresses and Google Workspace accounts on any domain.

Claude's built-in Gmail connector holds one Google account at a time. Hosted services that add more accounts store your Gmail tokens on their servers. mailmcp runs in your own AWS account instead, so mail goes from Google to your server to Claude and nowhere else.

## Features

- **Multi-account.** Link as many Gmail or Workspace accounts as you like, each with a short alias ("work", "personal"). Every tool takes an optional `account` argument. `search_threads` and `list_drafts` search all accounts when you don't name one.
- **Same tools as Claude's built-in Gmail connector**, with the same names and parameters:
  - Read: `search_threads`, `get_thread`, `get_message`, `get_attachment`, `list_labels`, `list_drafts`, `get_draft`
  - Write: `create_draft`, `update_draft`, `delete_draft`, `send_message`, `reply`, `forward`
  - Organize: `label_message`, `unlabel_message`, `update_message_labels`, `label_thread`, `unlabel_thread`, `create_label`, `update_label`, `delete_label`, `trash_message`, `trash_thread`, `untrash_message`, `untrash_thread`, `mark_message_spam`, `mark_thread_spam`, `unmark_message_spam`, `unmark_thread_spam`, `apply_sensitive_message_label`, `apply_sensitive_thread_label`
  - Accounts: `list_accounts`, `add_account`, `remove_account`
- **Read-only accounts.** Link an account read-only and write tools refuse to touch it.
- **Works everywhere Claude supports custom connectors:** claude.ai, Claude Desktop, mobile, and Claude Code.
- **Cheap.** About $1/month at personal volume, mostly the KMS key. Everything else stays in the AWS free tier or costs cents.

## How it works

```
Claude ──OAuth──▶ CloudFront ──▶ Lambda ──▶ Gmail API (one Google grant per linked account)
                                   │
                                   ├─ DynamoDB: OAuth sessions and linked accounts
                                   └─ KMS: encrypts each account's Google refresh token
```

- Claude signs in to your server with OAuth. You sign in with Google, and only emails on your `ownerEmails` allowlist get through.
- You link Gmail accounts from chat. Ask Claude to "add my work Gmail as work". It gives you a one-time link; open it, approve Gmail access, and the account is ready.
- Google refresh tokens are encrypted with a KMS key in your account. Gmail content is never stored.

Design notes and the reasoning behind each choice are in [docs/architecture.md](docs/architecture.md).

## Installation

### Prerequisites

- An AWS account, with the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and logged in
- Node.js 22 or later, and [pnpm](https://pnpm.io/installation)
- A Google account to create a Google Cloud project with
- A Claude plan that supports custom connectors (Pro, Max, Team, or Enterprise)

Commands below assume your AWS CLI's default profile and region. If you use a named profile, add `--profile <name>` to the `aws` and `cdk` commands.

### 1. Deploy to AWS

```bash
git clone https://github.com/devsandip/mailmcp.git
```

```bash
cd mailmcp && pnpm install
```

If you have never used AWS CDK in this account and region, bootstrap it once:

```bash
pnpm cdk bootstrap
```

Deploy. `ownerEmails` is a comma-separated list of the Google emails allowed to connect Claude to your server. It does not limit which Gmail accounts you can link later.

```bash
pnpm cdk deploy -c ownerEmails=you@gmail.com
```

The first deploy takes about 5 minutes (CloudFront is slow to create) and prints a `CdnUrl` like `https://d1234abcd.cloudfront.net`. Deploy a second time with it, so the server knows its public address:

```bash
pnpm cdk deploy -c ownerEmails=you@gmail.com -c publicBaseUrl=https://d1234abcd.cloudfront.net
```

Pass both `-c` values on every future deploy. Note the `McpEndpoint` and `GoogleRedirectUri` outputs for the next steps.

### 2. Create a Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/):

1. [Create a project](https://console.cloud.google.com/projectcreate), e.g. `mailmcp`. Make sure it's selected for the steps below.
2. [Enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. [Branding](https://console.cloud.google.com/auth/branding):
   - App name and user support email.
   - Application home page: `<CdnUrl>/`
   - Application privacy policy link: `<CdnUrl>/privacy` (the server serves both pages).
   - Authorized domain: the `CdnUrl` hostname, e.g. `d1234abcd.cloudfront.net`.
   - Developer contact email.
   - **Leave the logo empty.** Uploading one forces Google's verification review.
4. [Audience](https://console.cloud.google.com/auth/audience): user type **External**, then **Publish app** so the status reads **In production**. Don't leave the app in Testing: Google expires a Testing app's refresh tokens after 7 days.
5. [Data access](https://console.cloud.google.com/auth/scopes): **leave it empty.** The server requests Gmail access itself when you link an account. Declaring Gmail scopes here only matters for Google's verification review, which you don't need.
6. [Clients](https://console.cloud.google.com/auth/clients/create): create a client of type **Web application**. Under **Authorized redirect URIs**, add the `GoogleRedirectUri` output. Copy the client ID and secret; Google shows the secret only once.

You never submit the app for verification. Your app stays "unverified", which means a warning screen when you link an account and a cap of 100 users. Neither matters for personal use.

### 3. Store the Google client credentials in AWS

The server reads the client ID and secret from AWS Systems Manager Parameter Store, encrypted. Run these in an interactive terminal (zsh, the macOS default). Each command prompts for the value and keeps it out of your screen and shell history:

```bash
read -rs "CID?Google client ID: " && echo && aws ssm put-parameter --name /mailmcp/google-client-id --type SecureString --overwrite --value "$CID" && unset CID
```

```bash
read -rs "CSEC?Google client secret: " && echo && aws ssm put-parameter --name /mailmcp/google-client-secret --type SecureString --overwrite --value "$CSEC" && unset CSEC
```

In bash, use `read -rsp "Google client ID: " CID` instead of `read -rs "CID?..."`.

No redeploy is needed; the server picks the values up on its next request.

### 4. Connect Claude

- **claude.ai, Claude Desktop, mobile:** Settings > Connectors > Add custom connector. Name it `mailmcp` and paste the `McpEndpoint` URL. Click Connect and sign in with a Google account from `ownerEmails`.
- **Claude Code:**

```bash
claude mcp add --transport http mailmcp https://d1234abcd.cloudfront.net/mcp
```

### 5. Link your Gmail accounts

In a chat, ask Claude: *"Add my Gmail me@gmail.com as personal."* Claude returns a one-time link, valid for 15 minutes.

1. Open it and sign in to that Google account.
2. Google shows "Google hasn't verified this app". This is expected for a personal app. Click **Advanced**, then **Go to (your app name)**.
3. Keep the Gmail permission checked and continue. You'll see "Account linked".

Repeat for each account. Ask for a read-only link if you want Claude to read but never change an account.

**Workspace accounts on your own domain:** if that Workspace restricts third-party apps, allow your OAuth client in the Google Admin console under Security > Access and data control > API controls > App access control.

## Updating

```bash
git pull && pnpm install && pnpm cdk deploy -c ownerEmails=you@gmail.com -c publicBaseUrl=<CdnUrl>
```

## Troubleshooting

- **The Publish app button is missing.** Branding is usually incomplete: save it with the home page, privacy link, authorized domain, and developer contact filled in. If the Audience page shows user type **Internal**, the project belongs to a Workspace organization; click **Make external**. As a last resort, stay in Testing and add each Gmail address under Test users; you'll have to relink accounts every 7 days.
- **Claude says an account needs relinking.** Google revoked the grant: it expired in Testing mode, you changed your password, or you removed access at myaccount.google.com/permissions. Ask Claude to add the account again with the same alias.
- **"Gmail access not granted" after linking.** The Gmail checkbox on Google's consent screen was unticked. Link again and leave it checked.
- **Requests return `server_not_configured`.** The SSM parameters from step 3 are missing or misnamed.
- **Logs:** CloudWatch log group `MailMcp-Logs...` in the stack's region.

## Security

- Only Google accounts in `ownerEmails` can authorize Claude. Removing an email from the list and redeploying cuts off its existing tokens on the next request.
- OAuth client registration only accepts redirect URIs on `claude.ai`, `claude.com`, and localhost.
- Google refresh tokens are encrypted with KMS, bound to their account email. OAuth tokens issued to Claude are stored only as SHA-256 hashes.
- `remove_account` revokes the server's Google grant and deletes the stored token.
- Everyone on the `ownerEmails` list sees every linked account. This is a personal server, not a multi-user service.

## Limits

- `get_attachment` returns files up to 4MB (AWS Lambda's response limit is 6MB). Open larger ones from the message's `viewUrl`.
- Outgoing attachments are capped at 25MB combined, which is Gmail's own limit.
- Mail is sent from each account's primary address. Send-as aliases are not supported yet.

## Removing it

```bash
pnpm cdk destroy -c ownerEmails=you@gmail.com -c publicBaseUrl=<CdnUrl>
```

The DynamoDB table and KMS key are kept on purpose so linked accounts aren't lost by accident; delete them in the AWS console if you're done for good. The Lambda@Edge function can take a few hours to delete because AWS removes its edge copies first; retry the destroy later if it fails.

## Development

```bash
pnpm test     # unit and end-to-end tests against a fake Google API
pnpm build    # typecheck
pnpm lint
```

`pnpm dev` runs the server locally on port 8787 with an in-memory store. It needs `OWNER_EMAILS`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` set (see `.env.example`), plus `http://localhost:8787/oauth/google/callback` added as a redirect URI on your Google client.

## License

[MIT](LICENSE)
