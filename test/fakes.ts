import { simpleParser } from 'mailparser';
import type { GmailMessage, GmailPart } from '../src/gmail/format.js';

/** Builds an unsigned JWT-shaped ID token. Our code never checks the signature. */
export function fakeIdToken(email: string, verified = true): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ email, email_verified: verified })}.sig`;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export function textMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  date?: number;
  labelIds?: string[];
  messageIdHeader?: string;
  attachments?: { attachmentId: string; filename: string; mimeType: string; data: string }[];
}): GmailMessage & { attachmentData: Record<string, string> } {
  const headers = [
    { name: 'From', value: opts.from },
    { name: 'To', value: opts.to },
    { name: 'Subject', value: opts.subject },
    { name: 'Date', value: new Date(opts.date ?? 0).toUTCString() },
    { name: 'Message-ID', value: opts.messageIdHeader ?? `<${opts.id}@mail.example>` },
    ...(opts.cc ? [{ name: 'Cc', value: opts.cc }] : []),
    ...(opts.replyTo ? [{ name: 'Reply-To', value: opts.replyTo }] : []),
  ];
  const bodyParts: GmailPart[] = [
    {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
      body: { data: b64(opts.text), size: opts.text.length },
    },
  ];
  if (opts.html) {
    bodyParts.push({
      mimeType: 'text/html',
      headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
      body: { data: b64(opts.html), size: opts.html.length },
    });
  }
  const attachmentData: Record<string, string> = {};
  const attachParts: GmailPart[] = (opts.attachments ?? []).map((a) => {
    attachmentData[a.attachmentId] = Buffer.from(a.data).toString('base64url');
    return {
      mimeType: a.mimeType,
      filename: a.filename,
      headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.filename}"` }],
      body: { attachmentId: a.attachmentId, size: Buffer.byteLength(a.data) },
    };
  });
  return {
    id: opts.id,
    threadId: opts.threadId,
    labelIds: opts.labelIds ?? ['INBOX'],
    snippet: opts.text.slice(0, 50),
    internalDate: String(opts.date ?? 0),
    sizeEstimate: 1000,
    payload: {
      mimeType: 'multipart/mixed',
      headers,
      parts: [{ mimeType: 'multipart/alternative', parts: bodyParts }, ...attachParts],
    },
    attachmentData,
  };
}

/** Parses a raw RFC 822 message (as sent by our code) into a Gmail-style payload. */
export async function payloadFromRaw(
  rawB64Url: string,
): Promise<{ payload: GmailPart; parsed: Awaited<ReturnType<typeof simpleParser>> }> {
  const raw = Buffer.from(rawB64Url, 'base64url');
  const parsed = await simpleParser(raw, { keepCidLinks: true });
  const headers = parsed.headerLines.map((h) => {
    const i = h.line.indexOf(':');
    return { name: h.line.slice(0, i), value: h.line.slice(i + 1).trim() };
  });
  const parts: GmailPart[] = [];
  if (parsed.text) parts.push({ mimeType: 'text/plain', body: { data: b64(parsed.text) } });
  if (typeof parsed.html === 'string')
    parts.push({ mimeType: 'text/html', body: { data: b64(parsed.html) } });
  parsed.attachments.forEach((a, i) =>
    parts.push({
      mimeType: a.contentType,
      filename: a.filename,
      body: { attachmentId: `draftatt${i}`, size: a.size },
    }),
  );
  return { payload: { mimeType: 'multipart/mixed', headers, parts }, parsed };
}

interface Mailbox {
  email: string;
  messages: Map<string, GmailMessage & { attachmentData?: Record<string, string> }>;
  drafts: Map<string, { id: string; messageId: string }>;
  labels: {
    id: string;
    name: string;
    type: string;
    color?: unknown;
    labelListVisibility?: string;
    messageListVisibility?: string;
  }[];
  sent: { raw: string; threadId?: string }[];
  seq: number;
}

/**
 * Fake Google OAuth + Gmail REST API, enough to drive every tool.
 * Access tokens look like "at:<email>" so the Gmail fake knows whose mailbox to use.
 */
export class FakeGoogle {
  mailboxes = new Map<string, Mailbox>();
  /** Authorization code -> identity and scopes Google would return. */
  codes = new Map<
    string,
    { email: string; scope: string; refresh?: boolean; verified?: boolean }
  >();
  revoked: string[] = [];
  invalidRefresh = new Set<string>();
  calls: string[] = [];

  mailbox(email: string): Mailbox {
    let box = this.mailboxes.get(email);
    if (!box) {
      box = {
        email,
        messages: new Map(),
        drafts: new Map(),
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'SPAM', name: 'SPAM', type: 'system' },
          { id: 'TRASH', name: 'TRASH', type: 'system' },
        ],
        sent: [],
        seq: 0,
      };
      this.mailboxes.set(email, box);
    }
    return box;
  }

  addMessage(email: string, msg: GmailMessage & { attachmentData?: Record<string, string> }) {
    this.mailbox(email).messages.set(msg.id, msg);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'authorization_code') {
        const entry = this.codes.get(form.get('code') ?? '');
        if (!entry) return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: `at:${entry.email}`,
          expires_in: 3600,
          scope: entry.scope,
          id_token: fakeIdToken(entry.email, entry.verified ?? true),
          ...(entry.refresh === false ? {} : { refresh_token: `rt:${entry.email}` }),
        });
      }
      const rt = form.get('refresh_token') ?? '';
      if (this.invalidRefresh.has(rt))
        return json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        );
      return json({ access_token: `at:${rt.slice(3)}`, expires_in: 3600, scope: 'x' });
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      this.revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
      return new Response('', { status: 200 });
    }

    const prefix = '/gmail/v1/users/me';
    if (url.hostname !== 'gmail.googleapis.com' || !url.pathname.startsWith(prefix)) {
      return json({ error: { message: `unexpected ${url.href}` } }, 404);
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const email = auth.replace('Bearer at:', '');
    const box = this.mailbox(email);
    const path = url.pathname.slice(prefix.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const seg = path.split('/').filter(Boolean);
    const notFound = () => json({ error: { message: 'Requested entity was not found.' } }, 404);
    const shape = (m: GmailMessage) => {
      const format = url.searchParams.get('format');
      if (format === 'raw')
        return {
          id: m.id,
          threadId: m.threadId,
          labelIds: m.labelIds,
          raw: b64('Subject: raw\r\n\r\nraw body'),
        };
      const { attachmentData: _ignored, ...rest } = m as GmailMessage & {
        attachmentData?: unknown;
      };
      return rest;
    };
    const threadOf = (id: string) =>
      [...box.messages.values()]
        .filter((m) => m.threadId === id)
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const modifyLabels = (m: GmailMessage, add: string[] = [], remove: string[] = []) => {
      m.labelIds = [...new Set([...(m.labelIds ?? []).filter((l) => !remove.includes(l)), ...add])];
    };
    const storeRaw = async (raw: string, threadId: string | undefined, labelIds: string[]) => {
      const { payload } = await payloadFromRaw(raw);
      const id = `${email.split('@')[0]}-m${++box.seq}`;
      const msg: GmailMessage = {
        id,
        threadId: threadId ?? id,
        labelIds,
        internalDate: String(Date.now()),
        payload,
        snippet: '',
      };
      box.messages.set(id, msg);
      return msg;
    };

    // Threads
    if (seg[0] === 'threads' && seg.length === 1 && method === 'GET') {
      const all = new Map<string, number>();
      for (const m of box.messages.values()) {
        if (m.labelIds?.includes('DRAFT')) continue;
        all.set(m.threadId, Math.max(all.get(m.threadId) ?? 0, Number(m.internalDate)));
      }
      const ids = [...all.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const slice = ids.slice(start, start + max);
      return json({
        threads: slice.map((id) => ({ id })),
        ...(start + max < ids.length ? { nextPageToken: String(start + max) } : {}),
      });
    }
    if (seg[0] === 'threads' && seg.length === 2 && method === 'GET') {
      const msgs = threadOf(seg[1]!);
      return msgs.length ? json({ id: seg[1], messages: msgs.map(shape) }) : notFound();
    }
    if (seg[0] === 'threads' && seg.length === 3 && method === 'POST') {
      const msgs = threadOf(seg[1]!);
      if (!msgs.length) return notFound();
      for (const m of msgs) {
        if (seg[2] === 'modify') modifyLabels(m, body.addLabelIds, body.removeLabelIds);
        if (seg[2] === 'trash') modifyLabels(m, ['TRASH'], []);
        if (seg[2] === 'untrash') modifyLabels(m, [], ['TRASH']);
      }
      return json({ id: seg[1] });
    }

    // Messages
    if (seg[0] === 'messages' && seg[1] === 'send' && method === 'POST') {
      box.sent.push({ raw: body.raw, threadId: body.threadId });
      const msg = await storeRaw(body.raw, body.threadId, ['SENT']);
      return json({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
    }
    if (seg[0] === 'messages' && seg.length === 2 && method === 'GET') {
      const m = box.messages.get(seg[1]!);
      return m ? json(shape(m)) : notFound();
    }
    if (seg[0] === 'messages' && seg[2] === 'attachments' && method === 'GET') {
      const m = box.messages.get(seg[1]!);
      const data = m?.attachmentData?.[seg[3]!];
      return data ? json({ data, size: Buffer.from(data, 'base64url').length }) : notFound();
    }
    if (seg[0] === 'messages' && seg.length === 3 && method === 'POST') {
      const m = box.messages.get(seg[1]!);
      if (!m) return notFound();
      if (seg[2] === 'modify') modifyLabels(m, body.addLabelIds, body.removeLabelIds);
      if (seg[2] === 'trash') modifyLabels(m, ['TRASH'], []);
      if (seg[2] === 'untrash') modifyLabels(m, [], ['TRASH']);
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }

    // Drafts
    if (seg[0] === 'drafts' && seg[1] === 'send' && method === 'POST') {
      const d = box.drafts.get(body.id);
      if (!d) return notFound();
      const m = box.messages.get(d.messageId)!;
      m.labelIds = ['SENT'];
      box.drafts.delete(body.id);
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if (seg[0] === 'drafts' && seg.length === 1 && method === 'POST') {
      const msg = await storeRaw(body.message.raw, body.message.threadId, ['DRAFT']);
      const id = `r${++box.seq}`;
      box.drafts.set(id, { id, messageId: msg.id });
      return json({ id, message: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds } });
    }
    if (seg[0] === 'drafts' && seg.length === 1 && method === 'GET') {
      return json({ drafts: [...box.drafts.values()].map((d) => ({ id: d.id })) });
    }
    if (seg[0] === 'drafts' && seg.length === 2) {
      const d = box.drafts.get(seg[1]!);
      if (!d) return notFound();
      if (method === 'GET')
        return json({ id: d.id, message: shape(box.messages.get(d.messageId)!) });
      if (method === 'DELETE') {
        box.drafts.delete(d.id);
        box.messages.delete(d.messageId);
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT') {
        box.messages.delete(d.messageId);
        const msg = await storeRaw(body.message.raw, body.message.threadId, ['DRAFT']);
        d.messageId = msg.id;
        return json({ id: d.id, message: { id: msg.id, threadId: msg.threadId } });
      }
    }

    // Labels
    if (seg[0] === 'labels' && seg.length === 1 && method === 'GET')
      return json({ labels: box.labels });
    if (seg[0] === 'labels' && seg.length === 1 && method === 'POST') {
      if (box.labels.some((l) => l.name === body.name))
        return json({ error: { message: 'Label name exists or conflicts' } }, 409);
      const label = { id: `Label_${++box.seq}`, type: 'user', ...body };
      box.labels.push(label);
      return json(label);
    }
    if (seg[0] === 'labels' && seg.length === 2) {
      const label = box.labels.find((l) => l.id === seg[1]);
      if (!label) return notFound();
      if (method === 'PATCH') {
        Object.assign(label, body);
        return json(label);
      }
      if (method === 'DELETE') {
        box.labels = box.labels.filter((l) => l.id !== seg[1]);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: { message: `fake does not handle ${method} ${path}` } }, 501);
  };
}
