import { simpleParser } from 'mailparser';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountRecord } from '../src/accounts.js';
import { textMessage } from './fakes.js';
import { callTool, connectClaude, linkAccount, makeHarness, req, type Harness } from './harness.js';

const WORK = 'me@acme.dev';
const HOME = 'me@gmail.com';

async function setup(): Promise<{ h: Harness; token: string }> {
  const h = makeHarness();
  const token = await connectClaude(h);
  await linkAccount(h, token, 'work', WORK);
  await linkAccount(h, token, 'personal', HOME);
  return { h, token };
}

const parseSent = (raw: string) => simpleParser(Buffer.from(raw, 'base64url'));

describe('account linking', () => {
  it('links accounts from any domain and stores the refresh token encrypted', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    const link = await linkAccount(h, token, 'Work', WORK);
    expect(link.googleUrl.searchParams.get('scope')).toContain('gmail.modify');
    expect(link.googleUrl.searchParams.get('access_type')).toBe('offline');
    expect(link.googleUrl.searchParams.get('login_hint')).toBe(WORK);
    expect(link.html).toContain('Account linked');

    const stored = await h.store.get<AccountRecord>(`account#${WORK}`);
    expect(stored?.alias).toBe('work');
    expect(stored?.encryptedRefreshToken).not.toContain('rt:');

    const { data } = await callTool(h, token, 'list_accounts');
    expect(data.accounts).toEqual([
      expect.objectContaining({ email: WORK, alias: 'work', readOnly: false, needsRelink: false }),
    ]);
  });

  it('link URLs are single use', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    const { data } = await callTool(h, token, 'add_account', { alias: 'x' });
    const path = new URL(data.url).pathname + new URL(data.url).search;
    expect((await req(h, path)).status).toBe(302);
    expect((await req(h, path)).status).toBe(400);
  });

  it('refuses the link when the Gmail scope box was unchecked', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    const link = await linkAccount(h, token, 'work', WORK, { grantScope: 'openid email' });
    expect(link.callback.status).toBe(400);
    expect(link.html).toContain('Gmail access not granted');
  });

  it('rejects an alias already used by another account', async () => {
    const { h, token } = await setup();
    const link = await linkAccount(h, token, 'work', 'other@acme.dev');
    expect(link.html).toContain('already used');
  });

  it('removes an account and revokes the Google token', async () => {
    const { h, token } = await setup();
    const { data } = await callTool(h, token, 'remove_account', { account: 'personal' });
    expect(data.removed.email).toBe(HOME);
    expect(h.google.revoked).toContain(`rt:${HOME}`);
    expect((await callTool(h, token, 'list_accounts')).data.accounts).toHaveLength(1);
  });

  it('flags accounts whose Google grant was revoked', async () => {
    const { h, token } = await setup();
    h.google.invalidRefresh.add(`rt:${HOME}`);
    const res = await callTool(h, token, 'list_labels', { account: 'personal' });
    expect(res.isError).toBe(true);
    expect(res.data).toContain('add_account');
    const { data } = await callTool(h, token, 'list_accounts');
    expect(data.accounts.find((a: { email: string }) => a.email === HOME).needsRelink).toBe(true);
  });
});

describe('account selection', () => {
  it('requires an account when several are linked', async () => {
    const { h, token } = await setup();
    const res = await callTool(h, token, 'list_labels');
    expect(res.isError).toBe(true);
    expect(res.data).toContain('work, personal');
  });

  it('defaults to the only account', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    await linkAccount(h, token, 'work', WORK);
    const res = await callTool(h, token, 'list_labels');
    expect(res.data.account).toBe(WORK);
  });

  it('accepts email as well as alias', async () => {
    const { h, token } = await setup();
    expect((await callTool(h, token, 'list_labels', { account: HOME })).data.account).toBe(HOME);
  });

  it('read-only accounts refuse writes', async () => {
    const h = makeHarness();
    const token = await connectClaude(h);
    const link = await linkAccount(h, token, 'ro', WORK, { readOnly: true });
    expect(link.googleUrl.searchParams.get('scope')).toContain('gmail.readonly');
    const res = await callTool(h, token, 'send_message', {
      to: ['a@b.com'],
      subject: 'x',
      body: 'y',
    });
    expect(res.isError).toBe(true);
    expect(res.data).toContain('read-only');
    expect((await callTool(h, token, 'list_labels')).isError).toBe(false);
  });
});

describe('reading', () => {
  let h: Harness;
  let token: string;
  beforeEach(async () => {
    ({ h, token } = await setup());
    h.google.addMessage(
      WORK,
      textMessage({
        id: 'w1',
        threadId: 'wt1',
        from: 'Boss <boss@acme.dev>',
        to: WORK,
        subject: 'Quarterly plan',
        text: 'See attached',
        html: '<p>See <b>attached</b></p>',
        date: 3000,
        attachments: [
          { attachmentId: 'att1', filename: 'plan.txt', mimeType: 'text/plain', data: 'the plan' },
        ],
      }),
    );
    h.google.addMessage(
      WORK,
      textMessage({
        id: 'w2',
        threadId: 'wt1',
        from: WORK,
        to: 'boss@acme.dev',
        subject: 'Re: Quarterly plan',
        text: 'Thanks',
        date: 5000,
        labelIds: ['SENT'],
      }),
    );
    h.google.addMessage(
      HOME,
      textMessage({
        id: 'p1',
        threadId: 'pt1',
        from: 'Mom <mom@family.net>',
        to: HOME,
        subject: 'Dinner',
        text: 'Sunday?',
        date: 4000,
      }),
    );
  });

  it('search_threads fans out across accounts, newest first, tagged by account', async () => {
    const { data } = await callTool(h, token, 'search_threads', { query: 'plan' });
    expect(data.threads.map((t: { id: string; account: string }) => [t.account, t.id])).toEqual([
      [WORK, 'wt1'],
      [HOME, 'pt1'],
    ]);
    expect(data.threads[0].messages[0]).toMatchObject({
      subject: 'Quarterly plan',
      sender: 'Boss <boss@acme.dev>',
    });
    expect(data.threads[0].messages[0].plaintextBody).toBeUndefined();
    expect(h.google.calls.some((c) => c.startsWith('GET /gmail/v1/users/me/threads'))).toBe(true);
  });

  it('search_threads paginates per account', async () => {
    for (let i = 0; i < 3; i++) {
      h.google.addMessage(
        HOME,
        textMessage({
          id: `px${i}`,
          threadId: `ptx${i}`,
          from: 'x@y.z',
          to: HOME,
          subject: `n${i}`,
          text: 'x',
          date: 10 + i,
        }),
      );
    }
    const first = await callTool(h, token, 'search_threads', { account: 'personal', pageSize: 2 });
    expect(first.data.threads).toHaveLength(2);
    const second = await callTool(h, token, 'search_threads', {
      account: 'personal',
      pageSize: 2,
      pageToken: first.data.nextPageToken,
    });
    expect(second.data.threads).toHaveLength(2);
    expect(second.data.nextPageToken).toBeUndefined();
  });

  it('METADATA_ONLY view drops subject and snippet', async () => {
    const { data } = await callTool(h, token, 'search_threads', {
      account: 'work',
      view: 'THREAD_VIEW_METADATA_ONLY',
    });
    expect(data.threads[0].messages[0].subject).toBeUndefined();
    expect(data.threads[0].messages[0].sender).toBeDefined();
  });

  it('get_thread returns messages in each format', async () => {
    const full = await callTool(h, token, 'get_thread', { account: 'work', threadId: 'wt1' });
    expect(full.data.messages).toHaveLength(2);
    expect(full.data.messages[0]).toMatchObject({
      plaintextBody: 'See attached',
      htmlBody: '<p>See <b>attached</b></p>',
      attachmentIds: ['att1'],
    });
    expect(full.data.viewUrl).toBe(
      `https://mail.google.com/mail/u/${encodeURIComponent(WORK)}/#all/wt1`,
    );
    const minimal = await callTool(h, token, 'get_thread', {
      account: 'work',
      threadId: 'wt1',
      messageFormat: 'MINIMAL',
    });
    expect(minimal.data.messages[0].plaintextBody).toBeUndefined();
    const raw = await callTool(h, token, 'get_thread', {
      account: 'work',
      threadId: 'wt1',
      messageFormat: 'RAW',
    });
    expect(raw.isError).toBe(true);
  });

  it('get_message PLAIN_TEXT falls back to converted HTML', async () => {
    h.google.addMessage(
      WORK,
      textMessage({
        id: 'h1',
        threadId: 'ht1',
        from: 'a@b.c',
        to: WORK,
        subject: 's',
        text: '',
        html: '<p>Hello <b>there</b></p>',
      }),
    );
    const msg = h.google.mailbox(WORK).messages.get('h1')!;
    // Drop the plain part so only HTML remains.
    msg.payload!.parts![0]!.parts = msg.payload!.parts![0]!.parts!.filter(
      (p) => p.mimeType === 'text/html',
    );
    const { data } = await callTool(h, token, 'get_message', {
      account: 'work',
      messageId: 'h1',
      messageFormat: 'PLAIN_TEXT',
    });
    expect(data.plaintextBody).toBe('Hello there');
    expect(data.htmlBody).toBeUndefined();
  });

  it('get_message RAW returns MIME text', async () => {
    const { data } = await callTool(h, token, 'get_message', {
      account: 'work',
      messageId: 'w1',
      messageFormat: 'RAW',
    });
    expect(data.raw).toContain('Subject: raw');
  });

  it('get_attachment returns text attachments as text', async () => {
    const res = await callTool(h, token, 'get_attachment', {
      account: 'work',
      messageId: 'w1',
      attachmentId: 'att1',
    });
    expect(res.data).toMatchObject({ filename: 'plan.txt', mimeType: 'text/plain' });
    expect(res.content[1]).toEqual({ type: 'text', text: 'the plan' });
  });

  it('reports a missing message as a tool error', async () => {
    const res = await callTool(h, token, 'get_message', { account: 'work', messageId: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.data).toContain('not found');
  });
});

describe('labels and organizing', () => {
  it('creates nested labels with parents and color presets', async () => {
    const { h, token } = await setup();
    const { data } = await callTool(h, token, 'create_label', {
      account: 'work',
      displayName: 'Projects/Alpha',
      colorPreset: 'LABEL_COLOR_PRESET_RED',
      labelListVisibility: 'LABEL_SHOW_IF_UNREAD',
    });
    expect(data).toMatchObject({
      name: 'Projects/Alpha',
      color: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
      labelListVisibility: 'labelShowIfUnread',
    });
    const names = h.google.mailbox(WORK).labels.map((l) => l.name);
    expect(names).toContain('Projects');
    const upd = await callTool(h, token, 'update_label', {
      account: 'work',
      labelId: data.id,
      displayName: 'Projects/Beta',
    });
    expect(upd.data.name).toBe('Projects/Beta');
    expect(
      (await callTool(h, token, 'delete_label', { account: 'work', labelId: data.id })).isError,
    ).toBe(false);
  });

  it('labels, archives, trashes and spams', async () => {
    const { h, token } = await setup();
    h.google.addMessage(
      WORK,
      textMessage({ id: 'm1', threadId: 't1', from: 'a@b.c', to: WORK, subject: 's', text: 'x' }),
    );
    const box = h.google.mailbox(WORK);
    await callTool(h, token, 'label_message', {
      account: 'work',
      messageId: 'm1',
      labelIds: ['STARRED'],
    });
    expect(box.messages.get('m1')!.labelIds).toContain('STARRED');
    await callTool(h, token, 'update_message_labels', {
      account: 'work',
      messageId: 'm1',
      removeLabelIds: ['INBOX'],
    });
    expect(box.messages.get('m1')!.labelIds).not.toContain('INBOX');
    await callTool(h, token, 'trash_thread', { account: 'work', threadId: 't1' });
    expect(box.messages.get('m1')!.labelIds).toContain('TRASH');
    await callTool(h, token, 'untrash_message', { account: 'work', messageId: 'm1' });
    expect(box.messages.get('m1')!.labelIds).not.toContain('TRASH');
    await callTool(h, token, 'apply_sensitive_message_label', {
      account: 'work',
      messageId: 'm1',
      labelOption: 'SPAM',
    });
    expect(box.messages.get('m1')!.labelIds).toContain('SPAM');
    await callTool(h, token, 'unmark_thread_spam', { account: 'work', threadId: 't1' });
    expect(box.messages.get('m1')!.labelIds).toEqual(expect.arrayContaining(['INBOX']));
    expect(box.messages.get('m1')!.labelIds).not.toContain('SPAM');
    const empty = await callTool(h, token, 'update_message_labels', {
      account: 'work',
      messageId: 'm1',
    });
    expect(empty.isError).toBe(true);
  });
});

describe('composing', () => {
  let h: Harness;
  let token: string;
  beforeEach(async () => {
    ({ h, token } = await setup());
    h.google.addMessage(
      WORK,
      textMessage({
        id: 'o1',
        threadId: 'ot1',
        from: 'Alice <alice@client.com>',
        to: `${WORK}, bob@acme.dev`,
        cc: 'carol@client.com',
        subject: 'Contract',
        text: 'Please review.',
        date: 1000,
        messageIdHeader: '<orig@client.com>',
        attachments: [
          {
            attachmentId: 'a1',
            filename: 'contract.pdf',
            mimeType: 'application/pdf',
            data: '%PDF-fake',
          },
        ],
      }),
    );
  });

  it('send_message builds a message with Bcc, attachments and both bodies', async () => {
    const res = await callTool(h, token, 'send_message', {
      account: 'work',
      to: ['x@y.com'],
      bcc: ['hidden@y.com'],
      subject: 'Hi',
      body: 'plain',
      htmlBody: '<p>rich</p>',
      attachments: [
        {
          content: Buffer.from('hello').toString('base64'),
          filename: 'a.txt',
          mimeType: 'text/plain',
        },
      ],
    });
    expect(res.isError).toBe(false);
    const sent = await parseSent(h.google.mailbox(WORK).sent[0]!.raw);
    expect(sent.subject).toBe('Hi');
    expect(sent.bcc && 'text' in sent.bcc ? sent.bcc.text : '').toContain('hidden@y.com');
    expect(sent.text?.trim()).toBe('plain');
    expect(sent.html).toContain('<p>rich</p>');
    expect(sent.attachments[0]?.filename).toBe('a.txt');
  });

  it('send_message requires a recipient', async () => {
    const res = await callTool(h, token, 'send_message', {
      account: 'work',
      subject: 'x',
      body: 'y',
    });
    expect(res.isError).toBe(true);
  });

  it('send_message in a thread sets threading headers', async () => {
    await callTool(h, token, 'send_message', {
      account: 'work',
      to: ['alice@client.com'],
      body: 'follow up',
      replyThreadId: 'ot1',
    });
    const { raw, threadId } = h.google.mailbox(WORK).sent[0]!;
    expect(threadId).toBe('ot1');
    const sent = await parseSent(raw);
    expect(sent.inReplyTo).toBe('<orig@client.com>');
    expect(sent.subject).toBe('Re: Contract');
  });

  it('reply goes to the sender, quotes the original, and threads', async () => {
    await callTool(h, token, 'reply', { account: 'work', messageId: 'o1', body: 'Looks good' });
    const { raw, threadId } = h.google.mailbox(WORK).sent[0]!;
    expect(threadId).toBe('ot1');
    const sent = await parseSent(raw);
    expect(sent.to && 'text' in sent.to ? sent.to.text : '').toContain('alice@client.com');
    expect(sent.cc).toBeUndefined();
    expect(sent.subject).toBe('Re: Contract');
    expect(sent.inReplyTo).toBe('<orig@client.com>');
    expect(sent.text).toContain('Looks good');
    expect(sent.text).toContain('> Please review.');
    expect(sent.html).toContain('gmail_quote');
  });

  it('reply-all includes other recipients but not me', async () => {
    await callTool(h, token, 'reply', {
      account: 'work',
      messageId: 'o1',
      body: 'ok',
      replyAll: true,
    });
    const sent = await parseSent(h.google.mailbox(WORK).sent[0]!.raw);
    const cc = sent.cc && 'text' in sent.cc ? sent.cc.text : '';
    expect(cc).toContain('bob@acme.dev');
    expect(cc).toContain('carol@client.com');
    expect(cc).not.toContain(WORK);
  });

  it('forward carries attachments and the forwarded header block', async () => {
    await callTool(h, token, 'forward', {
      account: 'work',
      messageId: 'o1',
      to: ['legal@acme.dev'],
      forwardText: 'FYI',
    });
    const sent = await parseSent(h.google.mailbox(WORK).sent[0]!.raw);
    expect(sent.subject).toBe('Fwd: Contract');
    expect(sent.text).toContain('FYI');
    expect(sent.text).toContain('---------- Forwarded message ---------');
    expect(sent.text).toContain('From: Alice <alice@client.com>');
    expect(sent.attachments[0]?.filename).toBe('contract.pdf');
    expect(sent.attachments[0]?.content.toString()).toBe('%PDF-fake');
  });

  it('draft lifecycle: create as reply, list, update with merge, send, delete', async () => {
    const created = await callTool(h, token, 'create_draft', {
      account: 'work',
      to: ['alice@client.com'],
      body: 'Draft text',
      replyToMessageId: 'o1',
    });
    expect(created.data.threadId).toBe('ot1');
    expect(created.data.viewUrl).toContain('#drafts?compose=');

    const got = await callTool(h, token, 'get_draft', {
      account: 'work',
      draftId: created.data.id,
      messageFormat: 'PLAIN_TEXT',
    });
    expect(got.data.message.subject).toBe('Re: Contract');
    expect(got.data.message.plaintextBody).toContain('> Please review.');

    const listed = await callTool(h, token, 'list_drafts', { view: 'DRAFT_VIEW_FULL' });
    expect(listed.data.drafts).toEqual([
      expect.objectContaining({ account: WORK, id: created.data.id, subject: 'Re: Contract' }),
    ]);
    const meta = await callTool(h, token, 'list_drafts', {});
    expect(meta.data.drafts[0].subject).toBeUndefined();

    await callTool(h, token, 'update_draft', {
      account: 'work',
      draftId: created.data.id,
      cc: ['boss@acme.dev'],
    });
    const updated = await callTool(h, token, 'get_draft', {
      account: 'work',
      draftId: created.data.id,
    });
    expect(updated.data.message).toMatchObject({
      subject: 'Re: Contract',
      ccRecipients: ['boss@acme.dev'],
    });
    expect(updated.data.message.toRecipients).toEqual(['alice@client.com']);
    expect(updated.data.message.plaintextBody).toContain('Draft text');

    await callTool(h, token, 'update_draft', {
      account: 'work',
      draftId: created.data.id,
      body: 'Rewritten',
    });
    const rewritten = await callTool(h, token, 'get_draft', {
      account: 'work',
      draftId: created.data.id,
    });
    expect(rewritten.data.message.plaintextBody.trim()).toBe('Rewritten');
    expect(rewritten.data.message.htmlBody).toBeUndefined();

    const sent = await callTool(h, token, 'send_message', {
      account: 'work',
      draftId: created.data.id,
    });
    expect(sent.data.labelIds).toEqual(['SENT']);

    const d2 = await callTool(h, token, 'create_draft', {
      account: 'personal',
      to: ['a@b.c'],
      subject: 'tmp',
      body: 'x',
    });
    expect(
      (await callTool(h, token, 'delete_draft', { account: 'personal', draftId: d2.data.id })).data
        .deleted,
    ).toBe(d2.data.id);
  });
});

describe('snippets', () => {
  it('decodes HTML entities and strips invisible padding', async () => {
    const { cleanSnippet } = await import('../src/gmail/format.js');
    expect(cleanSnippet('we&#39;ll &amp; you &quot;x&quot; ͏ ͏ ͏ ͏ end')).toBe('we\'ll & you "x" end');
  });
});
