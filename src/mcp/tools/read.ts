import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AccountRecord } from '../../accounts.js';
import { mapLimit } from '../../gmail/client.js';
import {
  METADATA_HEADERS,
  apiFormat,
  compact,
  extractContent,
  formatMessage,
  viewUrl,
  type GmailMessage,
  type GmailThread,
  type MessageFormat,
} from '../../gmail/format.js';
import {
  READ,
  ToolError,
  accountArg,
  clientFor,
  decodePageTokens,
  encodePageTokens,
  fanOutAccountArg,
  gmailFor,
  handle,
  messageFormatArg,
  ok,
  type ToolContext,
} from '../context.js';

/** Lambda responses top out at 6MB, and base64 inflates by a third. */
export const MAX_INLINE_ATTACHMENT_BYTES = 4_000_000;

function withoutDrafts(messages: GmailMessage[] | undefined): GmailMessage[] {
  return (messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
}

/** Messages nested in a thread inherit the thread's account; repeating it wastes tokens. */
function withoutAccount<T extends { account?: string }>(m: T): Omit<T, 'account'> {
  const { account: _account, ...rest } = m;
  return rest;
}

export function excludeDrafts(query: string | undefined): string {
  const q = (query ?? '').trim();
  if (/\bin:(draft|drafts|anywhere)\b/i.test(q)) return q;
  return q ? `${q} -in:draft` : '-in:draft';
}

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'search_threads',
    {
      description:
        "Lists email threads matching a Gmail search query, across one or all linked accounts. Returns thread IDs, `viewUrl`, the owning `account`, and each message's snippet, subject, sender, recipients, date and labels (no bodies; use `get_thread` for those). Natural language must be converted to Gmail search syntax first: from:, to:, cc:, subject:, has:attachment, filename:, label:<labelId>, category:, in:inbox|sent|trash|anywhere, is:unread|starred|important, newer_than:7d, older_than:1y, after:YYYY/MM/DD, before:YYYY/MM/DD, larger:10M, OR, -, ( ). Prefer short keyword queries over long subject strings. Drafts are excluded unless the query says in:draft. An empty result means no matches, not an error.",
      inputSchema: {
        account: fanOutAccountArg,
        query: z
          .string()
          .optional()
          .describe('Optional. Gmail search query. Omit to list recent threads.'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Optional. Threads per account per page. Default 20, max 50.'),
        pageToken: z
          .string()
          .optional()
          .describe('Optional. `nextPageToken` from the previous call.'),
        includeTrash: z
          .boolean()
          .optional()
          .describe('Optional. Include threads in Trash and Spam. Default false.'),
        view: z
          .enum(['THREAD_VIEW_UNSPECIFIED', 'THREAD_VIEW_METADATA_ONLY', 'THREAD_VIEW_MINIMAL'])
          .optional()
          .describe(
            'Optional. `THREAD_VIEW_MINIMAL` (default) includes subject and snippet; `THREAD_VIEW_METADATA_ONLY` omits them.',
          ),
      },
      annotations: { title: 'Search threads', ...READ },
    },
    handle(async (args) => {
      const tokens = decodePageTokens(args.pageToken);
      let targets = await ctx.accounts.many(args.account);
      if (tokens) targets = targets.filter((a) => a.email in tokens);
      const format: MessageFormat =
        args.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL';
      const pageSize = args.pageSize ?? 20;

      const next: Record<string, string> = {};
      const errors: { account: string; error: string }[] = [];
      const perAccount = await Promise.all(
        targets.map(async (account: AccountRecord) => {
          try {
            const gmail = gmailFor(ctx, account);
            const list = await gmail.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
              '/threads',
              {
                q: excludeDrafts(args.query),
                maxResults: pageSize,
                pageToken: tokens?.[account.email],
                includeSpamTrash: args.includeTrash ?? false,
              },
            );
            if (list.nextPageToken) next[account.email] = list.nextPageToken;
            return mapLimit(list.threads ?? [], 10, async ({ id }) => {
              const thread = await gmail.get<GmailThread>(`/threads/${id}`, {
                format: 'metadata',
                metadataHeaders: METADATA_HEADERS,
              });
              const messages = withoutDrafts(thread.messages).map((m) =>
                withoutAccount(compact(formatMessage(account.email, m, format))),
              );
              return {
                account: account.email,
                id: thread.id,
                viewUrl: viewUrl(account.email, thread.id),
                messages,
              };
            });
          } catch (err) {
            if (targets.length === 1) throw err;
            errors.push({
              account: account.email,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          }
        }),
      );

      const latest = (t: { messages: { date?: string }[] }) => t.messages.at(-1)?.date ?? '';
      const threads = perAccount.flat().sort((a, b) => latest(b).localeCompare(latest(a)));
      return ok(compact({ threads, nextPageToken: encodePageTokens(next), accountErrors: errors }));
    }),
  );

  server.registerTool(
    'get_thread',
    {
      description:
        'Retrieves a full email thread with its `viewUrl` and all messages (each with its own `viewUrl`). Draft messages are omitted; use `list_drafts` for those. Use `PLAIN_TEXT` to avoid exhausting context. `RAW` is not supported here.',
      inputSchema: {
        account: accountArg,
        threadId: z.string().describe('Required. The thread ID.'),
        messageFormat: messageFormatArg,
      },
      annotations: { title: 'Get thread', ...READ },
    },
    handle(async (args) => {
      const format = args.messageFormat ?? 'FULL_CONTENT';
      if (format === 'RAW')
        throw new ToolError('RAW is not supported for threads; use get_message.');
      const { account, gmail } = await clientFor(ctx, args.account);
      const thread = await gmail.get<GmailThread>(`/threads/${args.threadId}`, apiFormat(format));
      return ok({
        account: account.email,
        id: thread.id,
        viewUrl: viewUrl(account.email, thread.id),
        messages: withoutDrafts(thread.messages).map((m) =>
          withoutAccount(compact(formatMessage(account.email, m, format))),
        ),
      });
    }),
  );

  server.registerTool(
    'get_message',
    {
      description:
        'Retrieves one email message by ID, including its `viewUrl`. Use for reading a single message in detail or checking attachment metadata; use `get_thread` for whole conversations and `list_drafts` for drafts. `PLAIN_TEXT` is recommended to save context.',
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe('Required. The message ID.'),
        messageFormat: messageFormatArg,
      },
      annotations: { title: 'Get message', ...READ },
    },
    handle(async (args) => {
      const format = args.messageFormat ?? 'FULL_CONTENT';
      const { account, gmail } = await clientFor(ctx, args.account);
      const msg = await gmail.get<GmailMessage>(`/messages/${args.messageId}`, apiFormat(format));
      return ok(compact(formatMessage(account.email, msg, format)));
    }),
  );

  server.registerTool(
    'get_attachment',
    {
      description:
        'Downloads one attachment from a message. Find `attachmentId` in the `attachments` list from `get_message` or `get_thread`. Images come back as images, text files as text, other files as embedded binary resources. Files over 4MB cannot be returned; open them via the message `viewUrl` instead.',
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe('Required. The message ID.'),
        attachmentId: z.string().describe('Required. The attachment ID.'),
      },
      annotations: { title: 'Get attachment', ...READ },
    },
    handle(async (args): Promise<CallToolResult> => {
      const { account, gmail } = await clientFor(ctx, args.account);
      const msg = await gmail.get<GmailMessage>(`/messages/${args.messageId}`, { format: 'full' });
      const all = extractContent(msg.payload).attachments;
      const byId = all.find((a) => a.attachmentId === args.attachmentId);
      if (byId && byId.size > MAX_INLINE_ATTACHMENT_BYTES) {
        throw new ToolError(
          `${byId.filename} is ${(byId.size / 1e6).toFixed(1)}MB, over the 4MB limit. Open it in Gmail: ${viewUrl(account.email, msg.id)}`,
        );
      }
      const att = await gmail.get<{ data: string; size: number }>(
        `/messages/${args.messageId}/attachments/${args.attachmentId}`,
      );
      const bytes = Buffer.from(att.data, 'base64url');
      if (bytes.length > MAX_INLINE_ATTACHMENT_BYTES) {
        throw new ToolError(
          `Attachment is over the 4MB limit. Open it in Gmail: ${viewUrl(account.email, msg.id)}`,
        );
      }
      // Gmail re-issues attachment IDs on every fetch, so match by size when the ID differs.
      const meta =
        byId ??
        all.find((a) => a.size === bytes.length) ??
        (all.length === 1
          ? all[0]!
          : { filename: 'attachment', mimeType: 'application/octet-stream', size: bytes.length });
      const description = {
        type: 'text' as const,
        text: JSON.stringify({
          account: account.email,
          messageId: msg.id,
          ...meta,
          size: bytes.length,
        }),
      };
      if (meta.mimeType.startsWith('image/')) {
        return {
          content: [
            description,
            { type: 'image', data: bytes.toString('base64'), mimeType: meta.mimeType },
          ],
        };
      }
      if (meta.mimeType.startsWith('text/') || /json|xml|csv|calendar/.test(meta.mimeType)) {
        return { content: [description, { type: 'text', text: bytes.toString('utf8') }] };
      }
      return {
        content: [
          description,
          {
            type: 'resource',
            resource: {
              uri: `gmail://${account.email}/messages/${msg.id}/attachments/${encodeURIComponent(meta.filename || args.attachmentId)}`,
              mimeType: meta.mimeType,
              blob: bytes.toString('base64'),
            },
          },
        ],
      };
    }),
  );
}
