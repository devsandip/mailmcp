import type { Store } from './types.js';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

/** In-process store for local development and tests. */
export class MemoryStore implements Store {
  private data = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.live(key)?.value as T | undefined;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined ? undefined : this.now() + ttlSeconds * 1000;
    this.data.set(key, { value: structuredClone(value), expiresAt });
  }

  async take<T>(key: string): Promise<T | undefined> {
    const entry = this.live(key);
    this.data.delete(key);
    return entry?.value as T | undefined;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list<T>(prefix: string): Promise<T[]> {
    const out: T[] = [];
    for (const key of [...this.data.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const entry = this.live(key);
      if (entry) out.push(entry.value as T);
    }
    return out;
  }
}
