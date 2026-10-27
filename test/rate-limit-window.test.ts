import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { takeEmailSlot } from '../src/channels/dispatcher';
import { call, makeEnv } from './helpers';

afterEach(() => setSystemTime());

// The in-memory KV never expires keys, so a window only resets if the key itself changes.
describe('fixed rate limit windows', () => {
  test('request limit resets in the next minute even under steady traffic', async () => {
    const { env, RATE_LIMIT } = makeEnv();
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    setSystemTime(new Date(start));
    const get = () => call(env, '/', { headers: { 'CF-Connecting-IP': '198.51.100.1' } });
    for (let i = 0; i < 100; i++) expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);

    setSystemTime(new Date(start + 61_000));
    expect((await get()).status).toBe(200);
    // TTL outlives the window a little, never refreshed past it.
    for (const p of RATE_LIMIT.puts) expect(p.opts?.expirationTtl).toBeLessThanOrEqual(120);
  });

  test('email budget resets in the next window', async () => {
    const { env, RATE_LIMIT } = makeEnv();
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    setSystemTime(new Date(start));
    for (let i = 0; i < 10; i++) expect(await takeEmailSlot(env, 'inbox-1')).toBe(true);
    expect(await takeEmailSlot(env, 'inbox-1')).toBe(false);

    setSystemTime(new Date(start + 601_000));
    expect(await takeEmailSlot(env, 'inbox-1')).toBe(true);
    for (const p of RATE_LIMIT.puts) expect(p.opts?.expirationTtl).toBeLessThanOrEqual(660);
  });
});
