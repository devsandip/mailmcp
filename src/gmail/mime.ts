import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Attachment as MailAttachment } from 'nodemailer/lib/mailer/index.js';
import { escapeHtml } from '../html.js';
import { extractContent, header, htmlToText, type GmailMessage } from './format.js';

export interface OutgoingAttachment {
  content: string;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

export interface Composition {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: OutgoingAttachment[];
  /** Raw attachments already in memory, e.g. carried over when forwarding. */
  binaryAttachments?: { content: Buffer; filename: string; mimeType: string; cid?: string }[];
  inReplyTo?: string;
  references?: string;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Builds an RFC 822 message, base64url-encoded the way the Gmail API wants it. */
export async function buildRaw(c: Composition): Promise<string> {
  const attachments: MailAttachment[] = [];
  let total = 0;
  for (const a of c.attachments ?? []) {
    const content = Buffer.from(a.content, 'base64');
    total += content.length;
    attachments.push({
      content,
      filename: a.filename,
      contentType: a.mimeType ?? 'application/octet-stream',
      ...(a.inline ? { cid: a.filename ?? 'inline', contentDisposition: 'inline' as const } : {}),
    });
  }
  for (const a of c.binaryAttachments ?? []) {
    total += a.content.length;
    attachments.push({
      content: a.content,
      filename: a.filename,
      contentType: a.mimeType,
      ...(a.cid ? { cid: a.cid } : {}),
    });
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachments exceed 25MB. Upload large files to Drive and link them instead.');
  }

  const node = new MailComposer({
    from: c.from,
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject ?? '',
    text: c.body,
    html: c.htmlBody,
    attachments,
    inReplyTo: c.inReplyTo,
    references: c.references,
  }).compile();
  // Gmail reads Bcc from the raw message and strips it on delivery; nodemailer drops it by default.
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const buf: Buffer = await new Promise((resolve, reject) =>
    node.build((err, out) => (err ? reject(err) : resolve(out))),
  );
  return buf.toString('base64url');
}

export function prefixSubject(prefix: 'Re' | 'Fwd', subject: string | undefined): string {
  const s = subject ?? '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
}

export interface ThreadingHeaders {
  threadId: string;
  inReplyTo?: string;
  references?: string;
}

export function threadingFor(original: GmailMessage): ThreadingHeaders {
  const messageId = header(original.payload, 'Message-ID');
  const refs = header(original.payload, 'References');
  return {
    threadId: original.threadId,
    inReplyTo: messageId,
    references: [refs, messageId].filter(Boolean).join(' ') || undefined,
  };
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** Appends a Gmail-style quote of `original` (a format=full message) to the new content. */
export function withQuote(
  original: GmailMessage,
  body: string | undefined,
  htmlBody: string | undefined,
): { body?: string; htmlBody?: string } {
  const content = extractContent(original.payload);
  const from = header(original.payload, 'From') ?? 'unknown sender';
  const date = header(original.payload, 'Date') ?? '';
  const intro = `On ${date}, ${from} wrote:`;
  const originalText = content.text ?? (content.html ? htmlToText(content.html) : '');
  const quotedText = originalText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const text =
    body !== undefined || htmlBody === undefined
      ? `${body ?? (htmlBody ? htmlToText(htmlBody) : '')}\n\n${intro}\n${quotedText}`
      : undefined;
  const newHtml = htmlBody ?? (body !== undefined ? textToHtml(body) : '');
  const originalHtml = content.html ?? textToHtml(originalText);
  const html = `${newHtml}<br><br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(intro)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${originalHtml}</blockquote></div>`;
  return { body: text ?? htmlToText(html), htmlBody: html };
}

/** Builds the forwarded-message block Gmail uses. */
export function forwardBlock(
  original: GmailMessage,
  forwardText: string | undefined,
  htmlBody: string | undefined,
): { body: string; htmlBody: string } {
  const p = original.payload;
  const content = extractContent(p);
  const meta = [
    ['From', header(p, 'From')],
    ['Date', header(p, 'Date')],
    ['Subject', header(p, 'Subject')],
    ['To', header(p, 'To')],
    ['Cc', header(p, 'Cc')],
  ].filter(([, v]) => v) as [string, string][];
  const originalText = content.text ?? (content.html ? htmlToText(content.html) : '');
  const sep = '---------- Forwarded message ---------';
  const intro = forwardText ?? (htmlBody ? htmlToText(htmlBody) : '');
  const body = `${intro}\n\n${sep}\n${meta.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${originalText}`;
  const metaHtml = meta.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`).join('');
  const introHtml = htmlBody ?? (forwardText ? textToHtml(forwardText) : '');
  const html = `${introHtml}<br><br><div class="gmail_quote"><div class="gmail_attr">${sep}<br>${metaHtml}</div><br>${content.html ?? textToHtml(originalText)}</div>`;
  return { body, htmlBody: html };
}
