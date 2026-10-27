import { describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, seedChannel, seedInbox } from './helpers';

describe('secret redaction', () => {
  test('PUT email-provider does not echo provider secrets', async () => {
    const { env } = makeEnv();
    const res = await call(env, '/v1/config/email-provider', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({
        type: 'resend',
        config: { api_key: 're_live_supersecretvalue', from_email: 'from@example.com' },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('supersecretvalue');
    expect(text).toContain('from@example.com');
  });

  test('GET channels hides custom header values', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'h' });
    seedChannel(DB, inboxId, 'webhook', {
      url: 'https://example.com/hook',
      custom_headers: { Authorization: 'Bearer tok', 'X-Key': 'abc' },
    });
    const res = await call(env, '/v1/hooks/inboxes/h/channels', { headers: ADMIN });
    const json = (await res.json()) as { data: { config: { custom_headers: Record<string, string> } }[] };
    const headers = json.data[0].config.custom_headers;
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'X-Key']);
    expect(JSON.stringify(headers)).not.toContain('tok');
    expect(JSON.stringify(headers)).not.toContain('abc');
  });

  test('POST channel response hides the URL secret and custom header values', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'h' });
    const res = await call(env, '/v1/hooks/inboxes/h/channels', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({
        type: 'webhook',
        config: { url: 'https://example.com/hook/secretpath123', custom_headers: { Authorization: 'Bearer tok' } },
      }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('secretpath123');
    expect(text).not.toContain('Bearer tok');
    expect(text).toContain('Authorization');
  });

  test('PATCH channel response hides the URL secret and custom header values', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'h' });
    const id = seedChannel(DB, inboxId, 'webhook', {
      url: 'https://example.com/hook/secretpath123',
      custom_headers: { 'X-Key': 'abcsecret' },
    });
    const res = await call(env, `/v1/hooks/inboxes/h/channels/${id}`, {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ label: 'renamed' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('secretpath123');
    expect(text).not.toContain('abcsecret');
    expect(text).toContain('renamed');
  });
});
