const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GMAIL_SCOPES = {
  full: 'https://www.googleapis.com/auth/gmail.modify',
  readOnly: 'https://www.googleapis.com/auth/gmail.readonly',
};

export type Fetch = typeof fetch;

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

export interface IdentityClaims {
  email: string;
  email_verified: boolean;
  hd?: string;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export class GoogleOAuth {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  authUrl(opts: {
    redirectUri: string;
    state: string;
    scopes: string[];
    offline?: boolean;
    loginHint?: string;
  }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', ...opts.scopes].join(' '),
      state: opts.state,
    });
    if (opts.offline) {
      // prompt=consent forces Google to return a refresh token every time.
      params.set('access_type', 'offline');
      params.set('prompt', 'consent select_account');
    } else {
      params.set('prompt', 'select_account');
    }
    if (opts.loginHint) params.set('login_hint', opts.loginHint);
    return `${AUTH_URL}?${params}`;
  }

  private async tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...body,
      }),
    });
    const json = (await res.json()) as GoogleTokens & {
      error?: string;
      error_description?: string;
    };
    if (!res.ok || json.error) {
      throw new GoogleAuthError(
        json.error_description ?? json.error ?? `HTTP ${res.status}`,
        json.error,
      );
    }
    return json;
  }

  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
    return this.tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async revoke(token: string): Promise<void> {
    await this.fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  }
}

/**
 * Reads claims from an ID token. The signature is not checked: the token came straight
 * from Google's token endpoint over TLS in exchange for our client secret, which Google
 * documents as sufficient.
 */
export function decodeIdToken(idToken: string): IdentityClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new GoogleAuthError('Malformed ID token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return {
    email: String(claims.email ?? '').toLowerCase(),
    email_verified: claims.email_verified === true || claims.email_verified === 'true',
    hd: claims.hd,
  };
}
