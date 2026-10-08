/**
 * Minimal key-value store with TTL. Every record kind lives under a key prefix:
 *   client#<id>        OAuth client registered by Claude (DCR)
 *   pending#<state>    In-flight Google redirect (login or account link)
 *   code#<hash>        Authorization code issued to Claude (single use)
 *   access#<hash>      Access token issued to Claude
 *   refresh#<hash>     Refresh token issued to Claude
 *   linktoken#<hash>   One-time "add account" link
 *   account#<email>    A linked Gmail account
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  /** ttlSeconds omitted means the record never expires. */
  put<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Deletes and returns the record atomically. Undefined if it did not exist. */
  take<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  /** Lists records whose key starts with the prefix. */
  list<T>(prefix: string): Promise<T[]>;
}
