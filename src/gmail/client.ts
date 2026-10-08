import type { Fetch } from '../auth/google.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

/** Thin wrapper over the Gmail REST API for one account. */
export class GmailClient {
  constructor(
    public readonly email: string,
    private token: () => Promise<string>,
    private fetchImpl: Fetch = fetch,
  ) {}

  async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message = json?.error?.message ?? `Gmail API returned HTTP ${res.status}`;
      throw new GmailApiError(`${message} (${this.email})`, res.status);
    }
    return json as T;
  }

  get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, { body: body ?? {}, query });
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body });
  }

  delete(path: string) {
    return this.request<void>('DELETE', path);
  }
}

/** Runs `fn` over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
