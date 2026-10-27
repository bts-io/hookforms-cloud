import { expect, test } from 'bun:test';
import worker from '../src/index';
import { makeCtx, makeEnv, seedInbox } from './helpers';

test('daily cleanup deletes events older than 30 days and keeps those from today', async () => {
  const { env, DB } = makeEnv();
  const inboxId = seedInbox(DB, { slug: 'site' });
  DB.raw
    .query(
      `INSERT INTO webhook_events (id, inbox_id, method, received_at) VALUES
       ('old', ?, 'POST', datetime('now', '-31 days')),
       ('edge', ?, 'POST', datetime('now', '-30 days', '+1 hour')),
       ('today', ?, 'POST', datetime('now'))`,
    )
    .run(inboxId, inboxId, inboxId);

  await worker.scheduled({} as never, env, makeCtx() as never);

  const ids = DB.raw.query('SELECT id FROM webhook_events ORDER BY id').all() as { id: string }[];
  expect(ids.map((r) => r.id)).toEqual(['edge', 'today']);
});
