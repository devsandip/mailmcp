import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerComposeTools } from './tools/compose.js';
import { registerOrganizeTools } from './tools/organize.js';
import { registerReadTools } from './tools/read.js';

export const SERVER_INSTRUCTIONS = `Gmail across several linked Google accounts.
Every tool takes an optional "account" (alias or email from list_accounts). It may be omitted when only one account is linked.
search_threads and list_drafts search all accounts when "account" is omitted; each result carries its "account". Message, thread, draft and label IDs belong to one account, so pass that same account to follow-up calls.
If no accounts are linked, call add_account and show the user the returned URL.`;

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'mailmcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAccountTools(server, ctx);
  registerReadTools(server, ctx);
  registerOrganizeTools(server, ctx);
  registerComposeTools(server, ctx);
  return server;
}
