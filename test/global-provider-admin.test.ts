import { describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, seedInbox } from './helpers';

type Env = ReturnType<typeof makeEnv>['env'];

async function createKey(env: Env, scopes: unknown) {
  return call(env, '/v1/auth/keys', {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ name: 'k', scopes }),
  });
}

describe('global email provider', () => {
  test('changing it needs an admin key, an inbox provider does not', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'own' });
    const created = (await (await createKey(env, ['webhooks'])).json()) as { data: { raw_key: string } };
    const KEY = { 'X-API-Key': created.data.raw_key, 'Content-Type': 'application/json' };
    const provider = { type: 'resend', config: { api_key: 'k-12345678', from_email: 'f@example.com' } };

    const put = (body: unknown) =>
      call(env, '/v1/config/email-provider', { method: 'PUT', headers: KEY, body: JSON.stringify(body) });
    expect((await put(provider)).status).toBe(403);
    expect((await put({ ...provider, inbox: 'own' })).status).toBe(200);
    expect((await call(env, '/v1/config/email-provider', { method: 'DELETE', headers: KEY })).status).toBe(403);
    expect(
      (await call(env, '/v1/config/email-provider?inbox=own', { method: 'DELETE', headers: KEY })).status,
    ).toBe(204);
    expect(
      (await call(env, '/v1/config/email-provider', { method: 'PUT', headers: ADMIN, body: JSON.stringify(provider) }))
        .status,
    ).toBe(200);
  });
});
