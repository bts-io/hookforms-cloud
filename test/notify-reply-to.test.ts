import { afterEach, describe, expect, test } from 'bun:test';
import { GmailProvider } from '../src/providers/gmail';
import { submitterReplyTo } from '../src/providers/headers';
import { ResendProvider } from '../src/providers/resend';
import { SendGridProvider } from '../src/providers/sendgrid';
import { call, makeEnv, mockFetch, seedChannel, seedInbox } from './helpers';

/**
 * Form notifications carry the submitter as Reply-To, so hitting Reply in a mail client answers
 * the person who filled in the form. The address is the submission's `email` field (the same one
 * the "Reply to" button uses) and `name` names it.
 */

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

const BODY = { html: '<p>hi</p>', text: 'hi' };
const DIRTY = 'ada@example.com\r\nBcc: victim@example.com';

function googleFetch() {
  return mockFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/')) {
      return Response.json({ access_token: 't', expires_in: 3600, token_type: 'Bearer' });
    }
    return new Response('{}');
  });
}

async function gmailHeaders(m: ReturnType<typeof mockFetch>) {
  const send = m.calls.find((r) => r.url.includes('/messages/send'))!;
  const { raw } = (await send.json()) as { raw: string };
  const message = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  return message.split('\r\n\r\n')[0];
}

function gmail(id: string) {
  return new GmailProvider({
    client_id: id,
    client_secret: 's',
    refresh_token: `refresh-${id}-123456`,
    sender_email: 'sender@example.com',
  });
}

describe('submitterReplyTo', () => {
  test('takes the email and name fields', () => {
    expect(submitterReplyTo({ name: 'Ada', email: 'ada@example.com' })).toEqual({
      replyTo: 'ada@example.com',
      replyToName: 'Ada',
    });
    expect(submitterReplyTo({ email: 'ada@example.com' })).toEqual({ replyTo: 'ada@example.com' });
  });

  test('no valid address means no Reply-To', () => {
    expect(submitterReplyTo({})).toBeUndefined();
    expect(submitterReplyTo({ email: 'nope' })).toBeUndefined();
    expect(submitterReplyTo({ email: 'ada@localhost' })).toBeUndefined();
    expect(submitterReplyTo({ email: ['ada@example.com'] })).toBeUndefined();
  });

  test('CR/LF is cleaned from the address and the name', () => {
    expect(submitterReplyTo({ name: 'Ada\r\nBcc: x', email: DIRTY })).toEqual({
      replyTo: 'ada@example.com',
      replyToName: 'Ada Bcc: x',
    });
  });
});

describe('providers send Reply-To', () => {
  test('Resend: reply_to with the name, cleaned', async () => {
    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    await new ResendProvider({ api_key: 'k', from_email: 'f@example.com' }).sendEmail(
      'to@example.com',
      'S',
      BODY,
      undefined,
      { replyTo: DIRTY, replyToName: 'Ada "A" <L>\r\n' },
    );
    const sent = (await fetchMock.calls[0].json()) as { reply_to?: string };
    expect(sent.reply_to).toBe('Ada A L <ada@example.com>');
  });

  test('Resend: a name with a comma is quoted', async () => {
    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    await new ResendProvider({ api_key: 'k', from_email: 'f@example.com' }).sendEmail(
      'to@example.com',
      'S',
      BODY,
      undefined,
      { replyTo: 'ada@example.com', replyToName: 'Lovelace, Ada' },
    );
    const sent = (await fetchMock.calls[0].json()) as { reply_to?: string };
    expect(sent.reply_to).toBe('"Lovelace, Ada" <ada@example.com>');
  });

  test('Resend: no reply_to without a reply address', async () => {
    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    await new ResendProvider({ api_key: 'k', from_email: 'f@example.com' }).sendEmail(
      'to@example.com',
      'S',
      BODY,
    );
    const sent = (await fetchMock.calls[0].json()) as Record<string, unknown>;
    expect('reply_to' in sent).toBe(false);
  });

  test('SendGrid: reply_to with the name, cleaned', async () => {
    fetchMock = mockFetch(() => new Response('', { status: 202 }));
    await new SendGridProvider({ api_key: 'k', from_email: 'f@example.com' }).sendEmail(
      'to@example.com',
      'S',
      BODY,
      undefined,
      { replyTo: DIRTY, replyToName: 'Ada\r\nLovelace' },
    );
    const sent = (await fetchMock.calls[0].json()) as { reply_to?: unknown };
    expect(sent.reply_to).toEqual({ email: 'ada@example.com', name: 'Ada Lovelace' });
  });

  test('SendGrid: no reply_to without a reply address', async () => {
    fetchMock = mockFetch(() => new Response('', { status: 202 }));
    await new SendGridProvider({ api_key: 'k', from_email: 'f@example.com' }).sendEmail(
      'to@example.com',
      'S',
      BODY,
    );
    const sent = (await fetchMock.calls[0].json()) as Record<string, unknown>;
    expect('reply_to' in sent).toBe(false);
  });

  test('Gmail: Reply-To header with the name, cleaned', async () => {
    fetchMock = googleFetch();
    await gmail('rt1').sendEmail('to@example.com', 'S', BODY, undefined, {
      replyTo: DIRTY,
      replyToName: 'Ada\r\nBcc: v@example.com',
    });
    const headers = await gmailHeaders(fetchMock);
    expect(headers).toContain('Reply-To: "Ada Bcc: v@example.com" <ada@example.com>');
    expect(headers).not.toMatch(/^Bcc/m);
  });

  test('Gmail: no Reply-To header without a reply address', async () => {
    fetchMock = googleFetch();
    await gmail('rt2').sendEmail('to@example.com', 'S', BODY);
    expect(await gmailHeaders(fetchMock)).not.toMatch(/^Reply-To/m);
  });
});

function submit(env: ReturnType<typeof makeEnv>['env'], slug: string, body: unknown) {
  return call(env, `/hooks/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deliver(env: ReturnType<typeof makeEnv>['env'], job: unknown) {
  fetchMock = mockFetch(() => Response.json({ id: '1' }));
  const { default: worker } = await import('../src/index');
  const msg = { body: job, ack() {}, retry() {} };
  await worker.queue({ queue: 'hookforms-emails', messages: [msg] } as never, env);
  const send = fetchMock.calls.find((r) => r.url === 'https://api.resend.com/emails')!;
  return (await send.json()) as Record<string, unknown>;
}

function withResend(DB: ReturnType<typeof makeEnv>['DB']) {
  DB.raw
    .query("INSERT INTO email_providers (id, inbox_id, type, config) VALUES ('g', NULL, 'resend', ?)")
    .run(JSON.stringify({ api_key: 'rk', from_email: 'from@example.com' }));
}

describe('legacy notify_email', () => {
  test('the notification replies to the submitter', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    seedInbox(DB, { slug: 'legacy', notify_email: 'owner@example.com' });
    withResend(DB);
    await submit(env, 'legacy', { name: 'Ada', email: 'ada@example.com', message: 'hi' });
    const job = EMAIL_QUEUE.sent[0] as { reply_to?: string; reply_to_name?: string };
    expect(job.reply_to).toBe('ada@example.com');
    expect(job.reply_to_name).toBe('Ada');
    const sent = await deliver(env, job);
    expect(sent.reply_to).toBe('Ada <ada@example.com>');
  });

  test('no valid email field means no Reply-To', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    seedInbox(DB, { slug: 'legacy', notify_email: 'owner@example.com' });
    withResend(DB);
    await submit(env, 'legacy', { name: 'Ada', email: 'not-an-address', message: 'hi' });
    const job = EMAIL_QUEUE.sent[0] as Record<string, unknown>;
    expect('reply_to' in job).toBe(false);
    const sent = await deliver(env, job);
    expect('reply_to' in sent).toBe(false);
  });
});

describe('email channel', () => {
  test('the notification replies to the submitter', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'chan' });
    seedChannel(DB, inboxId, 'email', { recipients: ['owner@example.com'] });
    withResend(DB);
    await submit(env, 'chan', { email: 'ada@example.com', message: 'hi' });
    const job = EMAIL_QUEUE.sent[0] as Record<string, unknown>;
    expect(job.reply_to).toBe('ada@example.com');
    expect('reply_to_name' in job).toBe(false);
    const sent = await deliver(env, job);
    expect(sent.reply_to).toBe('ada@example.com');
  });

  test('no email field means no Reply-To', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'chan' });
    seedChannel(DB, inboxId, 'email', { recipients: ['owner@example.com'] });
    await submit(env, 'chan', { name: 'Ada', message: 'hi' });
    const job = EMAIL_QUEUE.sent[0] as Record<string, unknown>;
    expect('reply_to' in job).toBe(false);
  });
});
