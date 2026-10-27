import { describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, seedChannel, seedInbox } from './helpers';

function setup() {
  const ctx = makeEnv();
  seedInbox(ctx.DB, { slug: 'p' });
  const inboxId = (ctx.DB.raw.query("SELECT id FROM webhook_inboxes WHERE slug = 'p'").get() as {
    id: string;
  }).id;
  return { ...ctx, inboxId };
}

async function patch(env: ReturnType<typeof makeEnv>['env'], id: string, body: unknown) {
  return call(env, `/v1/hooks/inboxes/p/channels/${id}`, {
    method: 'PATCH',
    headers: ADMIN,
    body: JSON.stringify(body),
  });
}

function storedConfig(DB: ReturnType<typeof makeEnv>['DB'], id: string) {
  const row = DB.raw.query('SELECT type, config FROM notification_channels WHERE id = ?').get(id) as {
    type: string;
    config: string;
  };
  return { type: row.type, config: JSON.parse(row.config) };
}

describe('PATCH channel validates like create', () => {
  test('rejects a webhook URL pointing at a private address', async () => {
    const { env, DB, inboxId } = setup();
    const id = seedChannel(DB, inboxId, 'webhook', { url: 'https://example.com/hook' });
    const res = await patch(env, id, { config: { url: 'http://10.0.0.5/admin' } });
    expect(res.status).toBe(400);
    expect(storedConfig(DB, id).config.url).toBe('https://example.com/hook');
  });

  test('rejects email recipients that are not an array of addresses', async () => {
    const { env, DB, inboxId } = setup();
    const id = seedChannel(DB, inboxId, 'email', { recipients: ['a@example.com'] });
    expect((await patch(env, id, { config: { recipients: 'a@example.com' } })).status).toBe(400);
    expect((await patch(env, id, { config: { recipients: ['not-an-email'] } })).status).toBe(400);
    expect(storedConfig(DB, id).config.recipients).toEqual(['a@example.com']);
  });

  test('changing type alone re-validates the existing config', async () => {
    const { env, DB, inboxId } = setup();
    const id = seedChannel(DB, inboxId, 'webhook', { url: 'https://example.com/hook' });
    const res = await patch(env, id, { type: 'discord' });
    expect(res.status).toBe(400);
    expect(storedConfig(DB, id).type).toBe('webhook');
  });

  test('valid update is normalised to the key the sender reads', async () => {
    const { env, DB, inboxId } = setup();
    const id = seedChannel(DB, inboxId, 'discord', {
      webhook_url: 'https://discord.com/api/webhooks/1/a',
    });
    const res = await patch(env, id, { config: { url: 'https://discord.com/api/webhooks/2/b' } });
    expect(res.status).toBe(200);
    expect(storedConfig(DB, id).config).toEqual({
      webhook_url: 'https://discord.com/api/webhooks/2/b',
    });
  });

  test('rejects a config that is not an object', async () => {
    const { env, DB, inboxId } = setup();
    const id = seedChannel(DB, inboxId, 'webhook', { url: 'https://example.com/hook' });
    expect((await patch(env, id, { config: 'x' })).status).toBe(400);
  });
});
