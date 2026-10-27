import { afterEach, describe, expect, test } from 'bun:test';
import { call, makeEnv, mockFetch, seedInbox } from './helpers';

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

function submit(env: ReturnType<typeof makeEnv>['env'], ip = '203.0.113.9') {
  return call(env, '/hooks/legacy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ name: 'Ann', message: 'hi' }),
  });
}

describe('legacy notify_email', () => {
  test('jobs carry the inbox id so the configured provider is used', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    seedInbox(DB, { slug: 'legacy', notify_email: 'owner@example.com' });
    DB.raw
      .query("INSERT INTO email_providers (id, inbox_id, type, config) VALUES ('g', NULL, 'resend', ?)")
      .run(JSON.stringify({ api_key: 'rk', from_email: 'from@example.com' }));

    expect((await submit(env)).status).toBe(200);
    expect(EMAIL_QUEUE.sent.length).toBe(1);
    const job = EMAIL_QUEUE.sent[0] as { inbox_id?: string };
    expect(job.inbox_id).toBeTruthy();

    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    const { default: worker } = await import('../src/index');
    let acked = false;
    const msg = { body: job, ack: () => (acked = true), retry() {} };
    await worker.queue({ queue: 'hookforms-emails', messages: [msg] } as never, env);
    expect(acked).toBe(true);
    expect(fetchMock.calls.map((r) => r.url)).toEqual(['https://api.resend.com/emails']);
  });

  test('the per-inbox email rate limit applies', async () => {
    const { env, DB, EMAIL_QUEUE } = makeEnv();
    seedInbox(DB, { slug: 'legacy', notify_email: 'a@example.com, b@example.com' });
    for (let i = 0; i < 12; i++) {
      expect((await submit(env, `203.0.113.${i}`)).status).toBe(200);
    }
    // 10 submissions per window, two recipients each.
    expect(EMAIL_QUEUE.sent.length).toBe(20);
  });
});
