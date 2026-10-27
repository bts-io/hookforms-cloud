import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeEnv, mockFetch, seedInbox } from './helpers';

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

function msg(body: Record<string, unknown>, attempts: number) {
  const m = {
    id: `m${attempts}`,
    attempts,
    body,
    acked: false,
    retried: undefined as undefined | { delaySeconds?: number },
    ack() {
      m.acked = true;
    },
    retry(opts?: { delaySeconds?: number }) {
      m.retried = opts ?? {};
    },
  };
  return m;
}

describe('email queue', () => {
  test('failed sends retry with growing delays', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'q' });
    DB.raw
      .query("INSERT INTO email_providers (id, inbox_id, type, config) VALUES ('p', ?, 'resend', ?)")
      .run(inboxId, JSON.stringify({ api_key: 'rk', from_email: 'from@example.com' }));
    fetchMock = mockFetch(() => new Response('down', { status: 503 }));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { default: worker } = await import('../src/index');
    const job = { to: 'a@example.com', subject: 's', body: '<p>b</p>', inbox_id: inboxId };
    const msgs = [msg(job, 1), msg(job, 2), msg(job, 3), msg(job, 7)];
    await worker.queue({ queue: 'hookforms-emails', messages: msgs } as never, env);
    errSpy.mockRestore();
    expect(msgs.map((m) => m.retried?.delaySeconds)).toEqual([30, 120, 600, 600]);
  });

  test('dead-letter queue logs one line per message without content and acks it', async () => {
    // A working provider exists, so anything other than a log-and-ack would try to send.
    const { env } = makeEnv({
      GMAIL_CLIENT_ID: 'id-dlq',
      GMAIL_CLIENT_SECRET: 's',
      GMAIL_REFRESH_TOKEN: 'refresh-dlq-123456',
      GMAIL_SENDER_EMAIL: 'sender@example.com',
    });
    fetchMock = mockFetch();
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    const { default: worker } = await import('../src/index');
    const job = {
      to: 'person@example.com',
      subject: 'Secret subject',
      body: '<p>private message body</p>',
      sender_name: 'Sender',
      inbox_id: 'inbox-9',
    };
    const msgs = [msg(job, 4), msg(job, 4)];
    await worker.queue({ queue: 'hookforms-emails-dlq', messages: msgs } as never, env);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();

    expect(fetchMock.calls.length).toBe(0);
    expect(msgs.every((m) => m.acked)).toBe(true);
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l).toContain('inbox-9');
      for (const secret of ['person@example.com', 'Secret subject', 'private message body']) {
        expect(l).not.toContain(secret);
      }
    }
  });
});
