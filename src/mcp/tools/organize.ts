import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GmailClient } from '../../gmail/client.js';
import {
  DESTRUCTIVE,
  READ,
  ToolError,
  WRITE,
  accountArg,
  clientFor,
  handle,
  labelIdsArg,
  ok,
  type ToolContext,
} from '../context.js';

/** Gmail only accepts colors from its palette; these presets mirror Google's Gmail MCP. */
export const COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: '#000000', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: '#434343', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: '#666666', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: '#cccccc', textColor: '#000000' },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: '#ffffff', textColor: '#000000' },
  LABEL_COLOR_PRESET_RED: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: '#ffad47', textColor: '#000000' },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: '#fad165', textColor: '#000000' },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: '#16a765', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: '#43d692', textColor: '#000000' },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: '#2da2bb', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: '#4a86e8', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: '#a479e2', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: '#f691b2', textColor: '#000000' },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: '#822111', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: '#a46a21', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: '#076239', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: '#1c4587', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: '#41236d', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: '#83334c', textColor: '#ffffff' },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: '#7a4706', textColor: '#ffffff' },
};

const colorPresetArg = z
  .enum(['LABEL_COLOR_PRESET_UNSPECIFIED', ...Object.keys(COLOR_PRESETS)] as [string, ...string[]])
  .optional()
  .describe('Optional. Color preset tile for the label.');

const labelListVisibilityArg = z
  .enum(['LABEL_LIST_VISIBILITY_UNSPECIFIED', 'LABEL_SHOW', 'LABEL_SHOW_IF_UNREAD', 'LABEL_HIDE'])
  .optional()
  .describe('Optional. Visibility in the Gmail label list.');

const messageListVisibilityArg = z
  .enum(['MESSAGE_LIST_VISIBILITY_UNSPECIFIED', 'SHOW', 'HIDE'])
  .optional()
  .describe('Optional. Visibility of the label chip in the Gmail message list.');

const LABEL_LIST_MAP: Record<string, string> = {
  LABEL_SHOW: 'labelShow',
  LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread',
  LABEL_HIDE: 'labelHide',
};
const MESSAGE_LIST_MAP: Record<string, string> = { SHOW: 'show', HIDE: 'hide' };

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { backgroundColor: string; textColor: string };
}

export function labelBody(args: {
  displayName?: string;
  colorPreset?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
}) {
  return {
    ...(args.displayName ? { name: args.displayName } : {}),
    ...(args.colorPreset && COLOR_PRESETS[args.colorPreset]
      ? { color: COLOR_PRESETS[args.colorPreset] }
      : {}),
    ...(args.labelListVisibility && LABEL_LIST_MAP[args.labelListVisibility]
      ? { labelListVisibility: LABEL_LIST_MAP[args.labelListVisibility] }
      : {}),
    ...(args.messageListVisibility && MESSAGE_LIST_MAP[args.messageListVisibility]
      ? { messageListVisibility: MESSAGE_LIST_MAP[args.messageListVisibility] }
      : {}),
  };
}

async function modify(
  gmail: GmailClient,
  kind: 'messages' | 'threads',
  id: string,
  add: string[] = [],
  remove: string[] = [],
) {
  return gmail.post<{ id: string; threadId?: string; labelIds?: string[] }>(
    `/${kind}/${id}/modify`,
    {
      addLabelIds: add,
      removeLabelIds: remove,
    },
  );
}

export function registerOrganizeTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'list_labels',
    {
      description:
        'Lists all labels in a Gmail account with their IDs. Use it to find label IDs before labeling or searching with label:. DRAFT and SENT are read-only system labels.',
      inputSchema: { account: accountArg },
      annotations: { title: 'List labels', ...READ },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account);
      const res = await gmail.get<{ labels?: GmailLabel[] }>('/labels');
      return ok({ account: account.email, labels: res.labels ?? [] });
    }),
  );

  server.registerTool(
    'create_label',
    {
      description:
        "Creates a label. Nested labels use '/' (e.g. 'Projects/Alpha/Sprint-1'); missing parents are created unless `autoCreateParentLabels` is false.",
      inputSchema: {
        account: accountArg,
        displayName: z.string().describe('Required. Label name; use / for nesting.'),
        autoCreateParentLabels: z
          .boolean()
          .optional()
          .describe('Optional. Create missing parent labels. Default true.'),
        colorPreset: colorPresetArg,
        labelListVisibility: labelListVisibilityArg,
        messageListVisibility: messageListVisibilityArg,
      },
      annotations: { title: 'Create label', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const existing = new Set(
        ((await gmail.get<{ labels?: GmailLabel[] }>('/labels')).labels ?? []).map((l) => l.name),
      );
      if (args.autoCreateParentLabels ?? true) {
        const parts = args.displayName.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          if (!existing.has(parent)) {
            await gmail.post('/labels', { name: parent });
            existing.add(parent);
          }
        }
      }
      const label = await gmail.post<GmailLabel>('/labels', labelBody(args));
      return ok({ account: account.email, ...label });
    }),
  );

  server.registerTool(
    'update_label',
    {
      description: 'Renames a label or changes its color or visibility.',
      inputSchema: {
        account: accountArg,
        labelId: z.string().describe('Required. ID of the label (see `list_labels`).'),
        displayName: z.string().optional().describe('Optional. New name.'),
        colorPreset: colorPresetArg,
        labelListVisibility: labelListVisibilityArg,
        messageListVisibility: messageListVisibilityArg,
      },
      annotations: { title: 'Update label', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const body = labelBody(args);
      if (Object.keys(body).length === 0) throw new ToolError('Nothing to update.');
      const label = await gmail.patch<GmailLabel>(`/labels/${args.labelId}`, body);
      return ok({ account: account.email, ...label });
    }),
  );

  server.registerTool(
    'delete_label',
    {
      description:
        'Deletes a user label. Messages keep existing; only the label is removed from them.',
      inputSchema: {
        account: accountArg,
        labelId: z.string().describe('Required. ID of the label to delete.'),
      },
      annotations: { title: 'Delete label', ...DESTRUCTIVE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      await gmail.delete(`/labels/${args.labelId}`);
      return ok({ account: account.email, deleted: args.labelId });
    }),
  );

  const messageId = z
    .string()
    .describe('Required. The message ID (from `search_threads` or `get_thread`).');
  const threadId = z.string().describe('Required. The thread ID (from `search_threads`).');

  server.registerTool(
    'label_message',
    {
      description:
        'Adds labels to one message. To trash or mark spam, use `trash_message` or `mark_message_spam`.',
      inputSchema: { account: accountArg, messageId, labelIds: labelIdsArg },
      annotations: { title: 'Label message', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      return ok({
        account: account.email,
        ...(await modify(gmail, 'messages', args.messageId, args.labelIds)),
      });
    }),
  );

  server.registerTool(
    'unlabel_message',
    {
      description:
        'Removes labels from one message (e.g. remove INBOX to archive, UNREAD to mark read).',
      inputSchema: { account: accountArg, messageId, labelIds: labelIdsArg },
      annotations: { title: 'Unlabel message', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      return ok({
        account: account.email,
        ...(await modify(gmail, 'messages', args.messageId, [], args.labelIds)),
      });
    }),
  );

  server.registerTool(
    'update_message_labels',
    {
      description:
        'Atomically adds and/or removes labels on one message, e.g. move by adding the target label and removing the current one. Requires at least one of `addLabelIds` or `removeLabelIds`.',
      inputSchema: {
        account: accountArg,
        messageId,
        addLabelIds: z.array(z.string()).optional().describe('Optional. Label IDs to add.'),
        removeLabelIds: z.array(z.string()).optional().describe('Optional. Label IDs to remove.'),
      },
      annotations: { title: 'Update message labels', ...WRITE },
    },
    handle(async (args) => {
      if (!args.addLabelIds?.length && !args.removeLabelIds?.length) {
        throw new ToolError('Provide addLabelIds or removeLabelIds.');
      }
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const res = await modify(
        gmail,
        'messages',
        args.messageId,
        args.addLabelIds,
        args.removeLabelIds,
      );
      return ok({ account: account.email, ...res });
    }),
  );

  server.registerTool(
    'label_thread',
    {
      description:
        'Adds labels to every message in a thread. To trash or mark spam, use `trash_thread` or `mark_thread_spam`.',
      inputSchema: { account: accountArg, threadId, labelIds: labelIdsArg },
      annotations: { title: 'Label thread', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const res = await modify(gmail, 'threads', args.threadId, args.labelIds);
      return ok({ account: account.email, id: res.id, labelsAdded: args.labelIds });
    }),
  );

  server.registerTool(
    'unlabel_thread',
    {
      description:
        'Removes labels from every message in a thread (e.g. remove INBOX to archive the conversation).',
      inputSchema: { account: accountArg, threadId, labelIds: labelIdsArg },
      annotations: { title: 'Unlabel thread', ...WRITE },
    },
    handle(async (args) => {
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      const res = await modify(gmail, 'threads', args.threadId, [], args.labelIds);
      return ok({ account: account.email, id: res.id, labelsRemoved: args.labelIds });
    }),
  );

  const simple = (
    name: string,
    title: string,
    description: string,
    kind: 'messages' | 'threads',
    run: (gmail: GmailClient, id: string) => Promise<unknown>,
    annotations: typeof WRITE | typeof DESTRUCTIVE,
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema:
          kind === 'messages'
            ? { account: accountArg, messageId }
            : { account: accountArg, threadId },
        annotations: { title, ...annotations },
      },
      handle(async (args: { account?: string; messageId?: string; threadId?: string }) => {
        const { account, gmail } = await clientFor(ctx, args.account, { write: true });
        const id = (kind === 'messages' ? args.messageId : args.threadId)!;
        await run(gmail, id);
        return ok({ account: account.email, id, done: name });
      }),
    );

  const trash = (kind: 'messages' | 'threads') => (g: GmailClient, id: string) =>
    g.post(`/${kind}/${id}/trash`);
  const untrash = (kind: 'messages' | 'threads') => (g: GmailClient, id: string) =>
    g.post(`/${kind}/${id}/untrash`);
  const spam = (kind: 'messages' | 'threads') => (g: GmailClient, id: string) =>
    modify(g, kind, id, ['SPAM'], ['INBOX']);
  const unspam = (kind: 'messages' | 'threads') => (g: GmailClient, id: string) =>
    modify(g, kind, id, ['INBOX'], ['SPAM']);

  simple(
    'trash_message',
    'Trash message',
    'Moves one message to Trash. To trash a whole conversation, prefer `trash_thread`.',
    'messages',
    trash('messages'),
    DESTRUCTIVE,
  );
  simple(
    'trash_thread',
    'Trash thread',
    'Moves every message in a thread to Trash, even a single-message thread.',
    'threads',
    trash('threads'),
    DESTRUCTIVE,
  );
  simple(
    'untrash_message',
    'Untrash message',
    'Restores one message from Trash.',
    'messages',
    untrash('messages'),
    WRITE,
  );
  simple(
    'untrash_thread',
    'Untrash thread',
    'Restores a whole thread from Trash.',
    'threads',
    untrash('threads'),
    WRITE,
  );
  simple(
    'mark_message_spam',
    'Mark message spam',
    'Marks one message as Spam.',
    'messages',
    spam('messages'),
    DESTRUCTIVE,
  );
  simple(
    'mark_thread_spam',
    'Mark thread spam',
    'Marks every message in a thread as Spam.',
    'threads',
    spam('threads'),
    DESTRUCTIVE,
  );
  simple(
    'unmark_message_spam',
    'Unmark message spam',
    'Moves one message out of Spam back to the inbox.',
    'messages',
    unspam('messages'),
    WRITE,
  );
  simple(
    'unmark_thread_spam',
    'Unmark thread spam',
    'Moves a whole thread out of Spam back to the inbox.',
    'threads',
    unspam('threads'),
    WRITE,
  );

  const labelOption = z
    .enum(['LABEL_OPTION_UNSPECIFIED', 'TRASH', 'SPAM'])
    .describe('Required. TRASH or SPAM.');
  server.registerTool(
    'apply_sensitive_message_label',
    {
      description:
        'Prefer `trash_message` or `mark_message_spam`. Applies TRASH or SPAM to one message.',
      inputSchema: { account: accountArg, messageId, labelOption },
      annotations: { title: 'Apply Trash/Spam to message', ...DESTRUCTIVE },
    },
    handle(async (args) => {
      if (args.labelOption === 'LABEL_OPTION_UNSPECIFIED')
        throw new ToolError('labelOption must be TRASH or SPAM.');
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      await (args.labelOption === 'TRASH' ? trash : spam)('messages')(gmail, args.messageId);
      return ok({ account: account.email, id: args.messageId, applied: args.labelOption });
    }),
  );
  server.registerTool(
    'apply_sensitive_thread_label',
    {
      description:
        'Prefer `trash_thread` or `mark_thread_spam`. Applies TRASH or SPAM to every message in a thread.',
      inputSchema: { account: accountArg, threadId, labelOption },
      annotations: { title: 'Apply Trash/Spam to thread', ...DESTRUCTIVE },
    },
    handle(async (args) => {
      if (args.labelOption === 'LABEL_OPTION_UNSPECIFIED')
        throw new ToolError('labelOption must be TRASH or SPAM.');
      const { account, gmail } = await clientFor(ctx, args.account, { write: true });
      await (args.labelOption === 'TRASH' ? trash : spam)('threads')(gmail, args.threadId);
      return ok({ account: account.email, id: args.threadId, applied: args.labelOption });
    }),
  );
}
