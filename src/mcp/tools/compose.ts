import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AccountRecord } from '../../accounts.js';
import { mapLimit, type GmailClient } from '../../gmail/client.js';
import {
  apiFormat,
  bareAddress,
  compact,
  draftViewUrl,
  extractContent,
  formatMessage,
  header,
  splitAddresses,
  viewUrl,
  type GmailMessage,
  type GmailThread,
  type MessageFormat,
} from '../../gmail/format.js';
import {
  buildRaw,
  forwardBlock,
  prefixSubject,
  threadingFor,
  withQuote,
  type Composition,
} from '../../gmail/mime.js';
import {
  DESTRUCTIVE,
  READ,
  SEND,
  ToolError,
  WRITE,
  accountArg,
  attachmentsArg,
  bodyArgs,
  clientFor,
  decodePageTokens,
  encodePageTokens,
  gmailFor,
  handle,
  messageFormatArg,
  ok,
  recipientArgs,
  type ToolContext,
} from '../context.js';

interface GmailDraft {
  id: string;
  message: GmailMessage;
}

interface SentMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

const getFull = (gmail: GmailClient, id: string) =>
  gmail.get<GmailMessage>(`/messages/${id}`, { format: 'full' });

function sentResult(account: AccountRecord, msg: SentMessage) {
  return compact({
    account: account.email,
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    viewUrl: viewUrl(account.email, msg.id),
  });
}

function draftResult(account: AccountRecord, draft: GmailDraft) {
  return {
    account: account.email,
    id: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    viewUrl: draftViewUrl(account.email, draft.message.id),
  };
}

function dedupe(addresses: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const a of addresses) {
    const bare = bareAddress(a);
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    out.push(a);
  }
  return out;
}

/** Default reply recipients, mirroring Gmail's Reply / Reply all behavior. */
export function replyRecipients(original: GmailMessage, self: string, replyAll: boolean) {
  const p = original.payload;
  const fromSelf =
    bareAddress(header(p, 'From') ?? '') === self || (original.labelIds ?? []).includes('SENT');
  const origTo = splitAddresses(header(p, 'To'));
  const origCc = splitAddresses(header(p, 'Cc'));
  const to = fromSelf ? origTo : splitAddresses(header(p, 'Reply-To') ?? header(p, 'From'));
  const exclude = new Set([self, ...to.map(bareAddress)]);
  const cc = replyAll ? dedupe(fromSelf ? origCc : [...origTo, ...origCc], exclude) : [];
  return { to: dedupe(to, new Set(fromSelf ? [] : [self])), cc };
}

function requireRecipients(c: Composition) {
  if (!c.to?.length && !c.cc?.length && !c.bcc?.length) {
    throw new ToolError('Provide at least one recipient in to, cc, or bcc.');
  }
}

export function registerComposeTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'create_draft',
    {
      description:
        'Creates a draft. Plain text goes in `body` (no Markdown); rich text in `htmlBody`. To draft a reply, pass the original message ID as `replyToMessageId`; the draft is threaded and the original is quoted below your text. Returns the draft `id`, `threadId`, and `viewUrl`.',
      inputSchema: {
        account: accountArg,
        ...recipientArgs,
        subject: z
          .string()
          .optional()
          .describe('Optional. Subject line. Defaults to "Re: <original>" for replies.'),
        ...bodyArgs,
        attachments: attachmentsArg,
        replyToMessageId: z
          .string()
          .optional()
          .describe('Optional. ID of the message this draft replies to.'),
      },
      annotations: { title: 'Create draft', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      let threadId: string | undefined;
      const c: Composition = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        htmlBody: args.htmlBody,
        attachments: args.attachments,
      };
      if (args.replyToMessageId) {
        const original = await getFull(gmail, args.replyToMessageId);
        const t = threadingFor(original);
        threadId = t.threadId;
        Object.assign(c, withQuote(original, args.body, args.htmlBody), {
          inReplyTo: t.inReplyTo,
          references: t.references,
          subject: args.subject ?? prefixSubject('Re', header(original.payload, 'Subject')),
        });
      }
      const draft = await gmail.post<GmailDraft>('/drafts', {
        message: { raw: await buildRaw(c), threadId },
      });
      return ok(draftResult(account, draft));
    }),
  );

  server.registerTool(
    'get_draft',
    {
      description:
        'Retrieves one draft by ID, including its `viewUrl` for editing in Gmail. `messageFormat` works as in `get_message`.',
      inputSchema: {
        account: accountArg,
        draftId: z.string().describe('Required. The draft ID.'),
        messageFormat: messageFormatArg,
      },
      annotations: { title: 'Get draft', ...READ },
    },
    handle(async (args) => {
      const format: MessageFormat = args.messageFormat ?? 'FULL_CONTENT';
      const { account, gmail } = await clientFor(ctx, args.account);
      const draft = await gmail.get<GmailDraft>(`/drafts/${args.draftId}`, apiFormat(format));
      return ok({
        ...draftResult(account, draft),
        message: compact({
          ...formatMessage(account.email, draft.message, format),
          viewUrl: draftViewUrl(account.email, draft.message.id),
        }),
      });
    }),
  );

  server.registerTool(
    'list_drafts',
    {
      description:
        'Lists drafts across one or all linked accounts, optionally filtered by a Gmail search query (e.g. `subject:proposal`, `to:alex@example.com newer_than:7d`). Returns draft IDs, recipients, dates and `viewUrl`; `DRAFT_VIEW_FULL` adds subject and plain text body. An empty result means no drafts.',
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe(
            'Optional. Alias or email of the account. If omitted, drafts from every linked account are listed.',
          ),
        query: z.string().optional().describe('Optional. Gmail search query to filter drafts.'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Optional. Drafts per account per page. Default 20, max 50.'),
        pageToken: z
          .string()
          .optional()
          .describe('Optional. `nextPageToken` from the previous call.'),
        view: z
          .enum(['DRAFT_VIEW_UNSPECIFIED', 'DRAFT_VIEW_METADATA_ONLY', 'DRAFT_VIEW_FULL'])
          .optional()
          .describe(
            'Optional. `DRAFT_VIEW_METADATA_ONLY` (default) omits subject and body; `DRAFT_VIEW_FULL` includes them.',
          ),
      },
      annotations: { title: 'List drafts', ...READ },
    },
    handle(async (args) => {
      const tokens = decodePageTokens(args.pageToken);
      let targets = await ctx.accounts.many(args.account);
      if (tokens) targets = targets.filter((a) => a.email in tokens);
      const full = args.view === 'DRAFT_VIEW_FULL';
      const format: MessageFormat = full ? 'PLAIN_TEXT' : 'METADATA_ONLY';
      const next: Record<string, string> = {};
      const errors: { account: string; error: string }[] = [];
      const lists = await Promise.all(
        targets.map(async (account) => {
          try {
            const gmail = gmailFor(ctx, account);
            const res = await gmail.get<{ drafts?: { id: string }[]; nextPageToken?: string }>(
              '/drafts',
              {
                q: args.query,
                maxResults: args.pageSize ?? 20,
                pageToken: tokens?.[account.email],
              },
            );
            if (res.nextPageToken) next[account.email] = res.nextPageToken;
            return mapLimit(res.drafts ?? [], 10, async ({ id }) => {
              const d = await gmail.get<GmailDraft>(`/drafts/${id}`, apiFormat(format));
              const m = formatMessage(account.email, d.message, format);
              return compact({
                account: account.email,
                id: d.id,
                threadId: d.message.threadId,
                toRecipients: m.toRecipients,
                ccRecipients: m.ccRecipients,
                bccRecipients: m.bccRecipients,
                date: m.date,
                subject: full ? m.subject : undefined,
                plaintextBody: full ? m.plaintextBody : undefined,
                viewUrl: draftViewUrl(account.email, d.message.id),
              });
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
      const drafts = lists.flat().sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      return ok(compact({ drafts, nextPageToken: encodePageTokens(next), accountErrors: errors }));
    }),
  );

  server.registerTool(
    'update_draft',
    {
      description:
        'Updates a draft with merge semantics: non-empty fields overwrite, omitted fields keep their values. Giving only one of `body`/`htmlBody` clears the other. WARNING: attachments are not merged; existing attachments are removed unless re-sent in `attachments`.',
      inputSchema: {
        account: accountArg,
        draftId: z.string().describe('Required. The draft ID.'),
        ...recipientArgs,
        subject: z.string().optional().describe('Optional. New subject.'),
        ...bodyArgs,
        attachments: attachmentsArg,
      },
      annotations: { title: 'Update draft', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const current = await gmail.get<GmailDraft>(`/drafts/${args.draftId}`, { format: 'full' });
      const p = current.message.payload;
      const content = extractContent(p);
      const pick = (next: string[] | undefined, existing: string | undefined) =>
        next?.length ? next : splitAddresses(existing);
      const bodyGiven = Boolean(args.body);
      const htmlGiven = Boolean(args.htmlBody);
      const c: Composition = {
        to: pick(args.to, header(p, 'To')),
        cc: pick(args.cc, header(p, 'Cc')),
        bcc: pick(args.bcc, header(p, 'Bcc')),
        subject: args.subject || header(p, 'Subject'),
        body: bodyGiven || htmlGiven ? args.body || undefined : content.text,
        htmlBody: bodyGiven || htmlGiven ? args.htmlBody || undefined : content.html,
        attachments: args.attachments,
        inReplyTo: header(p, 'In-Reply-To'),
        references: header(p, 'References'),
      };
      const draft = await gmail.put<GmailDraft>(`/drafts/${args.draftId}`, {
        id: args.draftId,
        message: { raw: await buildRaw(c), threadId: current.message.threadId },
      });
      return ok(draftResult(account, draft));
    }),
  );

  server.registerTool(
    'delete_draft',
    {
      description: 'Permanently deletes a draft.',
      inputSchema: { account: accountArg, draftId: z.string().describe('Required. The draft ID.') },
      annotations: { title: 'Delete draft', ...DESTRUCTIVE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      await gmail.delete(`/drafts/${args.draftId}`);
      return ok({ account: account.email, deleted: args.draftId });
    }),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Sends an email immediately. To send an existing draft, pass only `draftId`. Otherwise give recipients, `subject`, and `body` (plain text, no Markdown) or `htmlBody`. To send inside an existing conversation, pass `replyThreadId` or `replyToMessageId`. Attachments up to 25MB combined.',
      inputSchema: {
        account: accountArg,
        draftId: z
          .string()
          .optional()
          .describe('Optional. Send this draft as-is; other fields are ignored.'),
        ...recipientArgs,
        subject: z.string().optional().describe('Optional. Subject line.'),
        ...bodyArgs,
        attachments: attachmentsArg,
        replyThreadId: z.string().optional().describe('Optional. Thread to send this message in.'),
        replyToMessageId: z
          .string()
          .optional()
          .describe('Optional. Message this one replies to (sets threading headers).'),
      },
      annotations: { title: 'Send message', ...SEND },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      if (args.draftId) {
        const sent = await gmail.post<SentMessage>('/drafts/send', { id: args.draftId });
        return ok(sentResult(account, sent));
      }
      const c: Composition = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        htmlBody: args.htmlBody,
        attachments: args.attachments,
      };
      requireRecipients(c);
      let threadId: string | undefined;
      let original: GmailMessage | undefined;
      if (args.replyToMessageId) {
        original = await gmail.get<GmailMessage>(
          `/messages/${args.replyToMessageId}`,
          apiFormat('MINIMAL'),
        );
      } else if (args.replyThreadId) {
        const thread = await gmail.get<GmailThread>(
          `/threads/${args.replyThreadId}`,
          apiFormat('MINIMAL'),
        );
        original = thread.messages?.filter((m) => !m.labelIds?.includes('DRAFT')).at(-1);
        threadId = args.replyThreadId;
      }
      if (original) {
        const t = threadingFor(original);
        threadId = t.threadId;
        c.inReplyTo = t.inReplyTo;
        c.references = t.references;
        c.subject ??= prefixSubject('Re', header(original.payload, 'Subject'));
      }
      const sent = await gmail.post<SentMessage>('/messages/send', {
        raw: await buildRaw(c),
        threadId,
      });
      return ok(sentResult(account, sent));
    }),
  );

  server.registerTool(
    'reply',
    {
      description:
        'Replies to a message, to the sender only or to everyone (`replyAll`). Recipients default the way Gmail does; `to`/`cc` override them. The original is quoted below the reply. To reply in a thread, call `get_thread` first and use the latest message ID. Give `body` (plain text, no Markdown) or `htmlBody`.',
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe('Required. The message to reply to.'),
        replyAll: z
          .boolean()
          .optional()
          .describe('Optional. Reply to all recipients. Default false.'),
        to: recipientArgs.to.describe(
          'Optional. Overrides the default reply recipients. Plain email addresses.',
        ),
        cc: recipientArgs.cc.describe(
          'Optional. Overrides the default CC recipients. Plain email addresses.',
        ),
        bcc: recipientArgs.bcc,
        ...bodyArgs,
      },
      annotations: { title: 'Reply', ...SEND },
    },
    handle(async (args) => {
      if (!args.body && !args.htmlBody) throw new ToolError('Provide body or htmlBody.');
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const original = await getFull(gmail, args.messageId);
      const defaults = replyRecipients(original, account.email, args.replyAll ?? false);
      const t = threadingFor(original);
      const c: Composition = {
        to: args.to?.length ? args.to : defaults.to,
        cc: args.cc?.length ? args.cc : defaults.cc,
        bcc: args.bcc,
        subject: prefixSubject('Re', header(original.payload, 'Subject')),
        ...withQuote(original, args.body, args.htmlBody),
        inReplyTo: t.inReplyTo,
        references: t.references,
      };
      requireRecipients(c);
      const sent = await gmail.post<SentMessage>('/messages/send', {
        raw: await buildRaw(c),
        threadId: t.threadId,
      });
      return ok(sentResult(account, sent));
    }),
  );

  server.registerTool(
    'forward',
    {
      description:
        'Forwards a message with its attachments. Optional comments go above the forwarded message in `forwardText` (plain text, no Markdown) or `htmlBody`.',
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe('Required. The message to forward (from `get_thread`).'),
        ...recipientArgs,
        forwardText: z
          .string()
          .optional()
          .describe('Optional. Plain text comment above the forwarded message.'),
        htmlBody: z
          .string()
          .optional()
          .describe('Optional. HTML comment above the forwarded message.'),
      },
      annotations: { title: 'Forward', ...SEND },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const original = await getFull(gmail, args.messageId);
      const files = extractContent(original.payload).attachments;
      const binaryAttachments = await mapLimit(files, 4, async (a) => {
        const data = await gmail.get<{ data: string }>(
          `/messages/${original.id}/attachments/${a.attachmentId}`,
        );
        return {
          content: Buffer.from(data.data, 'base64url'),
          filename: a.filename,
          mimeType: a.mimeType,
          cid: a.inline ? a.filename : undefined,
        };
      });
      const t = threadingFor(original);
      const c: Composition = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: prefixSubject('Fwd', header(original.payload, 'Subject')),
        ...forwardBlock(original, args.forwardText, args.htmlBody),
        binaryAttachments,
        references: t.references,
      };
      requireRecipients(c);
      const sent = await gmail.post<SentMessage>('/messages/send', {
        raw: await buildRaw(c),
        threadId: t.threadId,
      });
      return ok(sentResult(account, sent));
    }),
  );
}
