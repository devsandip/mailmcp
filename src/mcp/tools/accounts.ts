import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LINK_TTL, type LinkTokenRecord } from '../../auth/oauth.js';
import { randomToken, sha256 } from '../../crypto.js';
import { DESTRUCTIVE, READ, WRITE, handle, ok, type ToolContext } from '../context.js';

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'list_accounts',
    {
      description:
        'Lists the Gmail accounts linked to this server with their aliases. Pass an alias or email as `account` to any other tool. Accounts with `needsRelink` must be linked again with `add_account`.',
      inputSchema: {},
      annotations: { title: 'List accounts', ...READ },
    },
    handle(async () => ok({ accounts: await ctx.accounts.summaries() })),
  );

  server.registerTool(
    'add_account',
    {
      description:
        'Starts linking a Gmail or Google Workspace account (any domain). Returns a one-time URL, valid 15 minutes, that the user must open in a browser to sign in to Google. Show the URL to the user; the account is usable once they finish. Also use this to re-link an account that shows `needsRelink`.',
      inputSchema: {
        alias: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)
          .describe(
            'Required. Short name for the account, e.g. "work" or "personal". Letters, digits, dot, dash, underscore.',
          ),
        email: z
          .string()
          .optional()
          .describe('Optional. The address to sign in with; pre-fills the Google sign-in screen.'),
        readOnly: z
          .boolean()
          .optional()
          .describe(
            'Optional. Grant read-only Gmail access. Write tools (send, label, trash) will refuse this account. Default false.',
          ),
      },
      annotations: { title: 'Add account', ...WRITE },
    },
    handle(async (args) => {
      const token = randomToken();
      const record: LinkTokenRecord = {
        alias: args.alias.toLowerCase(),
        readOnly: args.readOnly ?? false,
        loginHint: args.email,
      };
      await ctx.store.put(`linktoken#${sha256(token)}`, record, LINK_TTL);
      return ok({
        url: `${ctx.baseUrl}/link/start?t=${token}`,
        expiresInMinutes: LINK_TTL / 60,
        instructions:
          'Open this URL in a browser, sign in to the Google account, and approve Gmail access. Then ask me to list accounts to confirm.',
      });
    }),
  );

  server.registerTool(
    'remove_account',
    {
      description:
        "Unlinks a Gmail account: revokes this server's Google access and deletes the stored token.",
      inputSchema: {
        account: z.string().describe('Required. Alias or email of the account to remove.'),
      },
      annotations: { title: 'Remove account', ...DESTRUCTIVE },
    },
    handle(async (args) => {
      const removed = await ctx.accounts.remove(args.account);
      return ok({ removed: { email: removed.email, alias: removed.alias } });
    }),
  );
}
