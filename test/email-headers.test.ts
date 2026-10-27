import { afterEach, describe, expect, test } from 'bun:test';
import { GmailProvider } from '../src/providers/gmail';
import { ResendProvider } from '../src/providers/resend';
import { SendGridProvider } from '../src/providers/sendgrid';
import { call, makeEnv, mockFetch, seedInbox } from './helpers';

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

const EVIL_NAME = 'Eve\r\nBcc: victim@example.com\r\nX-Injected: 1';

function googleFetch() {
  return mockFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/')) {
      return Response.json({ access_token: 't', expires_in: 3600, token_type: 'Bearer' });
    }
    return new Response('{}');
  });
}

async function sentGmailMessage(m: ReturnType<typeof mockFetch>) {
  const send = m.calls.find((r) => r.url.includes('/messages/send'))!;
  const { raw } = (await send.json()) as { raw: string };
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function headerBlock(message: string) {
  return message.split('\r\n\r\n')[0];
}

describe('email header values', () => {
  test('Gmail: CR/LF in subject, sender name and recipient cannot add headers', async () => {
    fetchMock = googleFetch();
    const p = new GmailProvider({
      client_id: 'id-subject',
      client_secret: 's',
      refresh_token: 'refresh-subject-1234',
      sender_email: 'sender@example.com',
    });
    await p.sendEmail(
      'to@example.com\r\nCc: cc@example.com',
      `[x] from ${EVIL_NAME}`,
      { html: '<p>hi</p>', text: 'hi' },
      'Name\r\nReply-To: evil@example.com',
    );
    const headers = headerBlock(await sentGmailMessage(fetchMock));
    const names = headers.split('\r\n').filter((l) => !/^\s/.test(l)).map((l) => l.split(':')[0]);
    expect(names).toEqual(['From', 'To', 'Subject', 'MIME-Version', 'Content-Type']);
    expect(headers).not.toMatch(/^(Bcc|Cc|Reply-To|X-Injected):/im);
  });

  test('Gmail: non-ASCII subjects are RFC 2047 encoded', async () => {
    fetchMock = googleFetch();
    const p = new GmailProvider({
      client_id: 'id-utf8',
      client_secret: 's',
      refresh_token: 'refresh-utf8-123456',
      sender_email: 'sender@example.com',
    });
    await p.sendEmail('to@example.com', '[x] from Zoë Ångström', { html: '<p>hi</p>', text: 'hi' }, 'Café');
    const headers = headerBlock(await sentGmailMessage(fetchMock));
    // The header block itself is plain ASCII.
    expect(/^[\x20-\x7e\r\n\t]*$/.test(headers)).toBe(true);
    expect(headers).toContain('Subject: =?UTF-8?B?');
    const encoded = headers.match(/Subject: ((?:=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=(?:\r\n )?)+)/)![1];
    const decoded = encoded
      .split(/\r\n /)
      .map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))))
      .join('');
    expect(decoded).toBe('[x] from Zoë Ångström');
    expect(headers).toMatch(/^From: =\?UTF-8\?B\?[^\r\n]+\?= <sender@example.com>$/m);
  });

  test('Resend: subject, from and to carry no control characters', async () => {
    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    await new ResendProvider({ api_key: 'k', from_email: 'from@example.com' }).sendEmail(
      'to@example.com\r\nBcc: x@example.com',
      `[x] from ${EVIL_NAME}`,
      { html: '<p>hi</p>', text: 'hi' },
      'Name\r\nBcc: y@example.com',
    );
    const body = (await fetchMock.calls[0].json()) as { from: string; to: string[]; subject: string };
    for (const v of [body.from, body.subject, ...body.to]) expect(v).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  test('SendGrid: subject, from name and to carry no control characters', async () => {
    fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    await new SendGridProvider({ api_key: 'k', from_email: 'from@example.com' }).sendEmail(
      'to@example.com\r\nBcc: x@example.com',
      `[x] from ${EVIL_NAME}`,
      { html: '<p>hi</p>', text: 'hi' },
      'Name\r\nBcc: y@example.com',
    );
    const body = (await fetchMock.calls[0].json()) as {
      subject: string;
      from: { name: string };
      personalizations: { to: { email: string }[] }[];
    };
    for (const v of [body.subject, body.from.name, body.personalizations[0].to[0].email]) {
      expect(v).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  });

  test('a submitted name with CR/LF reaches the queue but not the raw message headers', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv({
      GMAIL_CLIENT_ID: 'id-e2e',
      GMAIL_CLIENT_SECRET: 's',
      GMAIL_REFRESH_TOKEN: 'refresh-e2e-1234567',
      GMAIL_SENDER_EMAIL: 'sender@example.com',
    });
    seedInbox(DB, { slug: 'contact', notify_email: 'owner@example.com' });
    const res = await call(env, '/hooks/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: EVIL_NAME, message: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(EMAIL_QUEUE.sent.length).toBe(1);

    fetchMock = googleFetch();
    const { default: worker } = await import('../src/index');
    const msg = { body: EMAIL_QUEUE.sent[0], ack() {}, retry() {} };
    await worker.queue({ queue: 'hookforms-emails', messages: [msg] } as never, env);
    const headers = headerBlock(await sentGmailMessage(fetchMock));
    expect(headers).not.toMatch(/^(Bcc|X-Injected):/im);
  });
});
