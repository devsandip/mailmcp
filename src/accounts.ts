import type { TokenCipher } from './crypto.js';
import { GoogleAuthError, type GoogleOAuth } from './auth/google.js';
import type { Store } from './store/types.js';

export interface AccountRecord {
  email: string;
  alias: string;
  readOnly: boolean;
  scopes: string[];
  encryptedRefreshToken: string;
  addedAt: string;
  /** Set when Google rejects the refresh token; the account must be re-linked. */
  needsRelink?: boolean;
}

export interface AccountSummary {
  email: string;
  alias: string;
  readOnly: boolean;
  needsRelink: boolean;
  addedAt: string;
}

export class AccountError extends Error {}

const key = (email: string) => `account#${email.toLowerCase()}`;

/** Access tokens survive across requests on a warm Lambda. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export class Accounts {
  constructor(
    private store: Store,
    private cipher: TokenCipher,
    private google: GoogleOAuth,
    private now: () => number = Date.now,
  ) {}

  async list(): Promise<AccountRecord[]> {
    const all = await this.store.list<AccountRecord>('account#');
    return all.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async summaries(): Promise<AccountSummary[]> {
    return (await this.list()).map((a) => ({
      email: a.email,
      alias: a.alias,
      readOnly: a.readOnly,
      needsRelink: Boolean(a.needsRelink),
      addedAt: a.addedAt,
    }));
  }

  async save(opts: {
    email: string;
    alias: string;
    readOnly: boolean;
    scopes: string[];
    refreshToken: string;
  }): Promise<AccountRecord> {
    const email = opts.email.toLowerCase();
    const alias = opts.alias.trim().toLowerCase();
    const clash = (await this.list()).find((a) => a.alias === alias && a.email !== email);
    if (clash) throw new AccountError(`Alias "${alias}" is already used by ${clash.email}`);
    const existing = await this.store.get<AccountRecord>(key(email));
    const record: AccountRecord = {
      email,
      alias,
      readOnly: opts.readOnly,
      scopes: opts.scopes,
      encryptedRefreshToken: await this.cipher.encrypt(opts.refreshToken, email),
      addedAt: existing?.addedAt ?? new Date(this.now()).toISOString(),
    };
    await this.store.put(key(email), record);
    tokenCache.delete(email);
    return record;
  }

  async remove(ref: string): Promise<AccountRecord> {
    const account = await this.resolve(ref);
    try {
      await this.google.revoke(
        await this.cipher.decrypt(account.encryptedRefreshToken, account.email),
      );
    } catch {
      // Revocation is best effort; the record is deleted either way.
    }
    await this.store.delete(key(account.email));
    tokenCache.delete(account.email);
    return account;
  }

  /** Finds an account by alias or email. */
  async resolve(ref: string): Promise<AccountRecord> {
    const needle = ref.trim().toLowerCase();
    const all = await this.list();
    const match = all.find((a) => a.alias === needle || a.email === needle);
    if (!match) {
      const known = all.map((a) => `${a.alias} (${a.email})`).join(', ') || 'none';
      throw new AccountError(`No linked account "${ref}". Linked accounts: ${known}`);
    }
    return match;
  }

  /**
   * Resolves the `account` tool argument. When omitted, falls back to the only linked
   * account; with several linked, the caller has to choose.
   */
  async pick(ref: string | undefined): Promise<AccountRecord> {
    if (ref) return this.resolve(ref);
    const all = await this.list();
    if (all.length === 1) return all[0]!;
    if (all.length === 0) {
      throw new AccountError('No Gmail accounts linked yet. Use add_account to link one.');
    }
    throw new AccountError(
      `Several accounts are linked; pass "account" as one of: ${all.map((a) => a.alias).join(', ')}`,
    );
  }

  /** Accounts to fan out over: the named one, or all of them. */
  async many(ref: string | undefined): Promise<AccountRecord[]> {
    if (ref) return [await this.resolve(ref)];
    const all = (await this.list()).filter((a) => !a.needsRelink);
    if (all.length === 0) {
      throw new AccountError('No usable Gmail accounts linked. Use add_account to link one.');
    }
    return all;
  }

  async accessToken(account: AccountRecord): Promise<string> {
    const cached = tokenCache.get(account.email);
    if (cached && cached.expiresAt > this.now() + 60_000) return cached.token;
    if (account.needsRelink) {
      throw new AccountError(
        `Google access for ${account.email} was revoked or expired. Run add_account again for it.`,
      );
    }
    const refreshToken = await this.cipher.decrypt(account.encryptedRefreshToken, account.email);
    try {
      const tokens = await this.google.refresh(refreshToken);
      tokenCache.set(account.email, {
        token: tokens.access_token,
        expiresAt: this.now() + tokens.expires_in * 1000,
      });
      return tokens.access_token;
    } catch (err) {
      if (err instanceof GoogleAuthError && err.code === 'invalid_grant') {
        await this.store.put(key(account.email), { ...account, needsRelink: true });
        throw new AccountError(
          `Google access for ${account.email} was revoked or expired. Run add_account again for it.`,
        );
      }
      throw err;
    }
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
