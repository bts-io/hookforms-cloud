import { describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv } from './helpers';

type Env = ReturnType<typeof makeEnv>['env'];

async function createKey(env: Env, scopes: unknown) {
  return call(env, '/v1/auth/keys', {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ name: 'k', scopes }),
  });
}

describe('API key scopes', () => {
  test('scopes must be an array of known values', async () => {
    const { env } = makeEnv();
    for (const bad of ['admin', ['webhooks', 'root'], [1], { admin: true }]) {
      expect((await createKey(env, bad)).status).toBe(400);
    }
    expect((await createKey(env, ['webhooks'])).status).toBe(201);
    expect((await createKey(env, ['webhooks', 'admin'])).status).toBe(201);
  });
});
