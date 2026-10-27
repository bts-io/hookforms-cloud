import { describe, expect, test } from 'bun:test';
import { call, makeEnv, seedInbox } from './helpers';

describe('GET /demo/events', () => {
  test('without an id it refuses instead of listing other visitors submissions', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'demo' });
    DB.raw
      .query("INSERT INTO webhook_events (id, inbox_id, method, body) VALUES ('other', ?, 'POST', ?)")
      .run(inboxId, JSON.stringify({ email: 'someone@example.com' }));

    const res = await call(env, '/demo/events');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('someone@example.com');
  });

  test('with an id it returns only that event', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'demo' });
    DB.raw
      .query(
        "INSERT INTO webhook_events (id, inbox_id, method, body) VALUES ('mine', ?, 'POST', ?), ('other', ?, 'POST', ?)",
      )
      .run(inboxId, JSON.stringify({ n: 1 }), inboxId, JSON.stringify({ n: 2 }));

    const res = await call(env, '/demo/events?id=mine');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.map((e) => e.id)).toEqual(['mine']);
  });
});
