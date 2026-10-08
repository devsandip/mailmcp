export interface Config {
  /** Google emails allowed to authorize Claude against this server. */
  ownerEmails: string[];
  googleClientId: string;
  googleClientSecret: string;
  /** Hostnames Claude (or another MCP client) may register as OAuth redirect targets. */
  allowedRedirectHosts: string[];
  /** Overrides the base URL derived from the request Host header. */
  publicBaseUrl?: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'];

export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function configFromEnv(
  env: NodeJS.ProcessEnv,
  secrets: { googleClientId: string; googleClientSecret: string },
): Config {
  const ownerEmails = parseList(env.OWNER_EMAILS);
  if (ownerEmails.length === 0) throw new Error('OWNER_EMAILS must list at least one email');
  const hosts = parseList(env.ALLOWED_REDIRECT_HOSTS);
  return {
    ownerEmails,
    googleClientId: secrets.googleClientId,
    googleClientSecret: secrets.googleClientSecret,
    allowedRedirectHosts: hosts.length ? hosts : DEFAULT_REDIRECT_HOSTS,
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, '') || undefined,
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
    refreshTokenTtlSeconds: Number(env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
  };
}
