import { afterEach, describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, mockFetch, seedInbox } from './helpers';

type Env = ReturnType<typeof makeEnv>['env'];

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

function addProvider(DB: ReturnType<typeof makeEnv>['DB'], inboxId: string | null, type: string, config: unknown) {
  DB.raw
    .query('INSERT INTO email_providers (id, inbox_id, type, config) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), inboxId, type, JSON.stringify(config));
}

function testEmail(env: Env, query = '') {
  return call(env, `/v1/diag/test-email${query}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ to: 'me@example.com' }),
  });
}

type Reply = { data?: { status: string; to: string; provider: { source: string; type: string } }; error?: { message: string } };

describe('diag test email', () => {
  test('sends through the global provider with the designed template', async () => {
    const { env, DB } = makeEnv();
    addProvider(DB, null, 'resend', { api_key: 'rk', from_email: 'global@example.com' });
    fetchMock = mockFetch(() => Response.json({ id: 'x' }));
    const res = await testEmail(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Reply;
    expect(body.data).toEqual({ status: 'sent', to: 'me@example.com', provider: { source: 'global', type: 'resend' } });
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe('https://api.resend.com/emails');
    const sent = (await fetchMock.calls[0].json()) as { from: string; html: string; text: string };
    expect(sent.from).toBe('HookForms <global@example.com>');
    expect(sent.html).toContain('<table');
    expect(sent.text.length).toBeGreaterThan(0);
  });

  test('?inbox= uses that inbox provider, and falls back to the global one', async () => {
    const { env, DB } = makeEnv();
    const own = seedInbox(DB, { slug: 'own', sender_name: 'Own Inbox' });
    seedInbox(DB, { slug: 'plain' });
    addProvider(DB, own, 'sendgrid', { api_key: 'sg', from_email: 'own@example.com' });
    addProvider(DB, null, 'resend', { api_key: 'rk', from_email: 'global@example.com' });

    fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    const a = (await (await testEmail(env, '?inbox=own')).json()) as Reply;
    expect(a.data?.provider).toEqual({ source: 'inbox', type: 'sendgrid' });
    const sg = (await fetchMock.calls[0].json()) as { from: { email: string; name: string } };
    expect(sg.from).toEqual({ email: 'own@example.com', name: 'Own Inbox' });
    fetchMock.restore();

    fetchMock = mockFetch(() => Response.json({ id: 'x' }));
    const b = (await (await testEmail(env, '?inbox=plain')).json()) as Reply;
    expect(b.data?.provider).toEqual({ source: 'global', type: 'resend' });
  });

  test('falls back to env Gmail when no provider row exists', async () => {
    const { env } = makeEnv({
      GMAIL_CLIENT_ID: 'diag-id',
      GMAIL_CLIENT_SECRET: 's',
      GMAIL_REFRESH_TOKEN: 'diag-refresh-token-1234',
      GMAIL_SENDER_EMAIL: 'gmail@example.com',
    });
    fetchMock = mockFetch((req) =>
      req.url.startsWith('https://oauth2.googleapis.com/')
        ? Response.json({ access_token: 't', expires_in: 3600, token_type: 'Bearer' })
        : new Response('{}'),
    );
    const body = (await (await testEmail(env)).json()) as Reply;
    expect(body.data?.provider).toEqual({ source: 'env_gmail', type: 'gmail' });
    expect(fetchMock.calls.some((r) => r.url.includes('/messages/send'))).toBe(true);
  });

  test('unknown inbox is a 404, no provider at all is reported', async () => {
    const { env } = makeEnv();
    expect((await testEmail(env, '?inbox=missing')).status).toBe(404);
    const res = await testEmail(env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as Reply).error?.message).toContain('No email provider');
  });
});
