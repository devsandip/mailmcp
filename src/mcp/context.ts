import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AccountError, type AccountRecord, type Accounts } from '../accounts.js';
import type { Fetch } from '../auth/google.js';
import type { Config } from '../config.js';
import { GmailApiError, GmailClient } from '../gmail/client.js';
import { MESSAGE_FORMATS } from '../gmail/format.js';
import type { Store } from '../store/types.js';

export interface ToolContext {
  accounts: Accounts;
  store: Store;
  config: Config;
  /** Public base URL of this deployment, used to build account-link URLs. */
  baseUrl: string;
  fetch: Fetch;
}

export class ToolError extends Error {}

export function gmailFor(ctx: ToolContext, account: AccountRecord): GmailClient {
  return new GmailClient(account.email, () => ctx.accounts.accessToken(account), ctx.fetch);
}

/** Resolves the account argument and returns a client, refusing writes on read-only accounts. */
export async function clientFor(
  ctx: ToolContext,
  ref: string | undefined,
  opts: { write?: boolean } = {},
): Promise<{ account: AccountRecord; gmail: GmailClient }> {
  const account = await ctx.accounts.pick(ref);
  if (opts.write && account.readOnly) {
    throw new ToolError(`${account.alias} (${account.email}) is linked read-only.`);
  }
  return { account, gmail: gmailFor(ctx, account) };
}

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? {}, null, 1) }] };
}

/** Wraps a tool handler so known failures come back as tool errors Claude can read. */
export function handle<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const known =
        err instanceof ToolError || err instanceof AccountError || err instanceof GmailApiError;
      const message = known
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      if (!known) console.error(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };
}

export const accountArg = z
  .string()
  .optional()
  .describe(
    'Optional. Alias or email of the linked Gmail account to act on (see `list_accounts`). Can be omitted when only one account is linked.',
  );

export const fanOutAccountArg = z
  .string()
  .optional()
  .describe(
    'Optional. Alias or email of the linked Gmail account to search. If omitted, every linked account is searched and each result carries its `account`.',
  );

export const messageFormatArg = z
  .enum(MESSAGE_FORMATS)
  .optional()
  .describe(
    'Optional. `MINIMAL`: snippet, subject, sender, recipients, date, labels. `METADATA_ONLY`: sender, recipients, date, labels. `FULL_CONTENT` (default): everything including plain and HTML bodies and attachment metadata. `PLAIN_TEXT` (recommended): like MINIMAL plus the plain text body (HTML converted when no plain part exists) and attachments. `RAW`: the raw MIME message.',
  );

const emailList = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `Optional. ${what} Each string MUST be a plain email address (e.g. "user@example.com").`,
    );

export const recipientArgs = {
  to: emailList('The primary recipients.'),
  cc: emailList('The carbon copy recipients.'),
  bcc: emailList('The blind carbon copy recipients.'),
};

export const bodyArgs = {
  body: z
    .string()
    .optional()
    .describe(
      'Optional. Plain text body. Do NOT format with Markdown; use `htmlBody` for rich text. If `htmlBody` is also given, this is the plain-text alternative.',
    ),
  htmlBody: z
    .string()
    .optional()
    .describe('Optional. HTML body, using valid HTML tags for formatting.'),
};

export const attachmentsArg = z
  .array(
    z.object({
      content: z.string().describe('Required. Base64-encoded file content.'),
      filename: z
        .string()
        .optional()
        .describe(
          'Optional. File name shown to recipients, e.g. "invoice.pdf". Used as the Content-ID for inline attachments.',
        ),
      mimeType: z
        .string()
        .optional()
        .describe('Optional. IANA MIME type. Defaults to application/octet-stream.'),
      inline: z
        .boolean()
        .optional()
        .describe('Optional. True to embed in the HTML body (reference it as cid:<filename>).'),
    }),
  )
  .optional()
  .describe(
    'Optional. Attachments. Combined size cannot exceed 25MB; link Drive files for anything larger.',
  );

export const labelIdsArg = z
  .array(z.string())
  .describe(
    'Required. Label IDs, not names. System labels: INBOX, STARRED, UNREAD, IMPORTANT, etc. Use `list_labels` to find IDs of user labels.',
  );

/** Encodes per-account page tokens for fanned-out listings. */
export function encodePageTokens(tokens: Record<string, string>): string | undefined {
  return Object.keys(tokens).length
    ? Buffer.from(JSON.stringify(tokens)).toString('base64url')
    : undefined;
}

export function decodePageTokens(token: string | undefined): Record<string, string> | undefined {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new ToolError('pageToken is not valid; pass the nextPageToken from the previous call.');
  }
}

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;
export const SEND = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
