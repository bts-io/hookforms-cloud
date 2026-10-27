import { afterEach, describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, mockFetch, seedInbox } from './helpers';

type Env = ReturnType<typeof makeEnv>['env'];

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

function put(env: Env, body: unknown) {
  return call(env, '/v1/config/email-provider', { method: 'PUT', headers: ADMIN, body: JSON.stringify(body) });
}

function storedConfig(DB: ReturnType<typeof makeEnv>['DB'], inboxId: string | null) {
  const row = (
    inboxId
      ? DB.raw.query('SELECT config FROM email_providers WHERE inbox_id = ?').get(inboxId)
      : DB.raw.query('SELECT config FROM email_providers WHERE inbox_id IS NULL').get()
  ) as { config: string };
  return JSON.parse(row.config) as Record<string, unknown>;
}

async function sendThroughQueue(env: Env, job: Record<string, unknown>) {
  const { default: worker } = await import('../src/index');
  const m = { id: 'm1', attempts: 1, body: job, ack() {}, retry() {} };
  await worker.queue({ queue: 'hookforms-emails', messages: [m] } as never, env);
}

describe('provider from address', () => {
  test('a display name in from_email is split off and the stored address is bare', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'demo' });
    const res = await put(env, {
      type: 'resend',
      config: { api_key: 'rk-12345678', from_email: 'HookForms Demo <demo@example.com>' },
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { config: Record<string, unknown> } }).data;
    expect(data.config.from_email).toBe('demo@example.com');
    expect(data.config.from_name).toBe('HookForms Demo');
    expect(storedConfig(DB, null)).toMatchObject({ from_email: 'demo@example.com', from_name: 'HookForms Demo' });

    // With no inbox sender name, the provider's own name is used.
    fetchMock = mockFetch(() => Response.json({ id: 'x' }));
    await sendThroughQueue(env, { to: 'a@example.com', subject: 's', body: '<p>b</p>', text: 'b', inbox_id: inboxId });
    const sent = (await fetchMock.calls[0].json()) as { from: string };
    expect(sent.from).toBe('HookForms Demo <demo@example.com>');
  });

  test('an inbox sender name still wins over the provider name', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'shop', sender_name: 'Shop' });
    const res = await put(env, {
      inbox: 'shop',
      type: 'sendgrid',
      config: { api_key: 'sg-12345678', from_email: '"Acme, Forms" <forms@example.com>' },
    });
    expect(res.status).toBe(200);
    expect(storedConfig(DB, inboxId)).toMatchObject({ from_email: 'forms@example.com', from_name: 'Acme, Forms' });

    fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    await sendThroughQueue(env, {
      to: 'a@example.com', subject: 's', body: '<p>b</p>', text: 'b', sender_name: 'Shop', inbox_id: inboxId,
    });
    const sent = (await fetchMock.calls[0].json()) as { from: { email: string; name: string } };
    expect(sent.from).toEqual({ email: 'forms@example.com', name: 'Shop' });
  });

  test('a bare address is stored as given, Gmail sender_email is handled the same way', async () => {
    const { env, DB } = makeEnv();
    expect((await put(env, { type: 'resend', config: { api_key: 'rk-12345678', from_email: 'a@example.com' } })).status)
      .toBe(200);
    expect(storedConfig(DB, null)).toEqual({ api_key: 'rk-12345678', from_email: 'a@example.com' });

    const gmail = await put(env, {
      type: 'gmail',
      config: { client_id: 'c', client_secret: 's', refresh_token: 'r', sender_email: 'Team <team@example.com>' },
    });
    expect(gmail.status).toBe(200);
    expect(storedConfig(DB, null)).toMatchObject({ sender_email: 'team@example.com', from_name: 'Team' });
  });

  test('anything that is not a valid address is refused with a 400', async () => {
    const { env } = makeEnv();
    for (const from_email of ['not an address', 'Name <bad>', 'a@example.com extra', 'Name <a@example.com', '', 'a@b']) {
      const res = await put(env, { type: 'resend', config: { api_key: 'rk-12345678', from_email } });
      expect(res.status).toBe(400);
      const err = ((await res.json()) as { error: { message: string } }).error;
      expect(err.message).toContain('from_email');
    }
    const res = await put(env, {
      type: 'gmail',
      config: { client_id: 'c', client_secret: 's', refresh_token: 'r', sender_email: 'nope' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('sender_email');
  });

  test('a row saved earlier with a display name still sends from the bare address', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'old' });
    DB.raw
      .query("INSERT INTO email_providers (id, inbox_id, type, config) VALUES ('p', NULL, 'resend', ?)")
      .run(JSON.stringify({ api_key: 'rk', from_email: 'HookForms <demo@example.com>' }));
    fetchMock = mockFetch(() => Response.json({ id: 'x' }));
    await sendThroughQueue(env, { to: 'a@example.com', subject: 's', body: '<p>b</p>', text: 'b', inbox_id: inboxId });
    const sent = (await fetchMock.calls[0].json()) as { from: string };
    expect(sent.from).toBe('HookForms <demo@example.com>');
  });
});
