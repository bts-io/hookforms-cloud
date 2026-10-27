import { describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, seedInbox } from './helpers';

describe('list paging', () => {
  test('negative or non-numeric limit/offset give 400, limit is capped', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'pg' });
    const paths = ['/v1/hooks/inboxes', '/v1/hooks/pg/events', '/v1/auth/keys'];
    for (const path of paths) {
      for (const q of ['limit=-1', 'limit=abc', 'offset=-5', 'offset=x', 'limit=1.5', 'limit=0']) {
        const res = await call(env, `${path}?${q}`, { headers: ADMIN });
        expect(res.status).toBe(400);
      }
      const res = await call(env, `${path}?limit=5000&offset=0`, { headers: ADMIN });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { meta: { limit: number; offset: number } };
      expect(json.meta.limit).toBe(200);
      expect(json.meta.offset).toBe(0);
    }
  });
});
