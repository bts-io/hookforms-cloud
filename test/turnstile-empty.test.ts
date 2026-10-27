import { describe, expect, test } from 'bun:test';
import { call, makeEnv, seedInbox } from './helpers';

describe('Turnstile', () => {
  test('an empty body is refused when the inbox requires Turnstile', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'ts', turnstile_secret: 'secret-value' });
    for (const method of ['POST', 'GET']) {
      const res = await call(env, '/hooks/ts', { method });
      expect(res.status).toBe(400);
    }
    const n = DB.raw.query('SELECT COUNT(*) AS n FROM webhook_events').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
