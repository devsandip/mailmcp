import { convert } from 'html-to-text';

/** Shapes returned by the Gmail REST API (only the fields we read). */
export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  sizeEstimate?: number;
  internalDate?: string;
  payload?: GmailPart;
  raw?: string;
}
export interface GmailThread {
  id: string;
  snippet?: string;
  historyId?: string;
  messages?: GmailMessage[];
}

export const MESSAGE_FORMATS = [
  'MESSAGE_FORMAT_UNSPECIFIED',
  'MINIMAL',
  'FULL_CONTENT',
  'METADATA_ONLY',
  'PLAIN_TEXT',
  'RAW',
] as const;
export type MessageFormat = (typeof MESSAGE_FORMATS)[number];

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

export interface FormattedMessage {
  account: string;
  id: string;
  threadId: string;
  viewUrl: string;
  labelIds: string[];
  date?: string;
  sizeEstimate?: number;
  snippet?: string;
  subject?: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  plaintextBody?: string;
  htmlBody?: string;
  attachmentIds?: string[];
  attachments?: AttachmentInfo[];
  raw?: string;
}

export const MAX_BODY_CHARS = 100_000;
export const METADATA_HEADERS = [
  'Subject',
  'From',
  'To',
  'Cc',
  'Bcc',
  'Date',
  'Reply-To',
  'Message-ID',
  'References',
  'In-Reply-To',
];

/** Which `format` to ask the Gmail API for, given the tool-level format. */
export function apiFormat(format: MessageFormat): { format: string; metadataHeaders?: string[] } {
  switch (format) {
    case 'MINIMAL':
    case 'METADATA_ONLY':
      return { format: 'metadata', metadataHeaders: METADATA_HEADERS };
    case 'RAW':
      return { format: 'raw' };
    default:
      return { format: 'full' };
  }
}

export function viewUrl(email: string, id: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#all/${id}`;
}

export function draftViewUrl(email: string, messageId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#drafts?compose=${messageId}`;
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Splits an RFC 5322 address list on commas that are outside quotes and angle brackets. */
export function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === '<') depth++;
    else if (!inQuotes && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !inQuotes && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Extracts the bare address from "Name <addr>" or "addr". */
export function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim().toLowerCase();
}

function charsetOf(part: GmailPart): string {
  const contentType = header(part, 'Content-Type') ?? '';
  return contentType.match(/charset="?([^";\s]+)"?/i)?.[1] ?? 'utf-8';
}

export function decodeBody(data: string, charset = 'utf-8'): string {
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated ${text.length - MAX_BODY_CHARS} characters]`;
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  });
}

export interface ExtractedContent {
  text?: string;
  html?: string;
  attachments: AttachmentInfo[];
}

/** Walks the MIME tree, picking the first text and HTML bodies and listing attachments. */
export function extractContent(payload: GmailPart | undefined): ExtractedContent {
  const result: ExtractedContent = { attachments: [] };
  const walk = (part: GmailPart) => {
    const mimeType = (part.mimeType ?? '').toLowerCase();
    const disposition = (header(part, 'Content-Disposition') ?? '').toLowerCase();
    const isAttachment = Boolean(part.filename) || disposition.startsWith('attachment');
    if (isAttachment && part.body?.attachmentId) {
      result.attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename ?? '',
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        inline: disposition.startsWith('inline') || Boolean(header(part, 'Content-ID')),
      });
    } else if (!isAttachment && part.body?.data) {
      if (mimeType === 'text/plain' && result.text === undefined) {
        result.text = decodeBody(part.body.data, charsetOf(part));
      } else if (mimeType === 'text/html' && result.html === undefined) {
        result.html = decodeBody(part.body.data, charsetOf(part));
      }
    }
    part.parts?.forEach(walk);
  };
  if (payload) walk(payload);
  return result;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Gmail returns snippets HTML-escaped, and marketing mail pads previews with invisible
 * characters (combining grapheme joiners, zero-width spaces). Both waste tokens.
 */
export function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n =
          code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[\u034f\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function formatMessage(
  email: string,
  msg: GmailMessage,
  format: MessageFormat,
): FormattedMessage {
  const base: FormattedMessage = {
    account: email,
    id: msg.id,
    threadId: msg.threadId,
    viewUrl: viewUrl(email, msg.id),
    labelIds: msg.labelIds ?? [],
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined,
  };
  if (format === 'RAW') {
    return {
      ...base,
      raw: msg.raw ? Buffer.from(msg.raw, 'base64url').toString('utf8') : undefined,
    };
  }

  const p = msg.payload;
  const addresses = {
    sender: header(p, 'From'),
    toRecipients: splitAddresses(header(p, 'To')),
    ccRecipients: splitAddresses(header(p, 'Cc')),
    bccRecipients: splitAddresses(header(p, 'Bcc')),
  };
  if (format === 'METADATA_ONLY') {
    return { ...base, ...addresses, sizeEstimate: msg.sizeEstimate };
  }
  const minimal: FormattedMessage = {
    ...base,
    snippet: msg.snippet === undefined ? undefined : cleanSnippet(msg.snippet),
    subject: header(p, 'Subject'),
    ...addresses,
  };
  if (format === 'MINIMAL') return minimal;

  const content = extractContent(p);
  const attachmentFields = {
    attachmentIds: content.attachments.map((a) => a.attachmentId),
    attachments: content.attachments,
  };
  if (format === 'PLAIN_TEXT') {
    const text = content.text ?? (content.html ? htmlToText(content.html) : undefined);
    return { ...minimal, plaintextBody: text && truncate(text), ...attachmentFields };
  }
  return {
    ...minimal,
    plaintextBody: content.text && truncate(content.text),
    htmlBody: content.html && truncate(content.html),
    ...attachmentFields,
  };
}

/** Drops empty arrays and undefined fields so tool output stays compact. */
export function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}
