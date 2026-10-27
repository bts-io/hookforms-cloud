import { afterEach, describe, expect, test } from 'bun:test';
import { ADMIN, call, makeEnv, mockFetch, seedChannel, seedInbox } from './helpers';

const DISCORD = 'https://discord.com/api/webhooks/1/abc';
const SLACK = 'https://hooks.slack.com/services/T/B/x';
const TEAMS = 'https://example.webhook.office.com/webhookb2/x';
const GENERIC = 'https://example.com/hook';

function storedConfig(DB: ReturnType<typeof makeEnv>['DB'], id: string) {
  const row = DB.raw.query('SELECT config FROM notification_channels WHERE id = ?').get(id) as { config: string };
  return JSON.parse(row.config) as Record<string, string>;
}

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

async function submit(env: Parameters<typeof call>[0]) {
  fetchMock = mockFetch();
  const res = await call(env, '/hooks/site', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A', message: 'hi' }),
  });
  expect(res.status).toBe(200);
  return fetchMock.calls.map((r) => r.url);
}

describe('channel url keys', () => {
  test('create stores the key each sender reads', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'site' });
    const cases: [string, Record<string, string>, string, string][] = [
      ['discord', { url: DISCORD }, 'webhook_url', DISCORD],
      ['slack', { url: SLACK }, 'webhook_url', SLACK],
      ['teams', { url: TEAMS }, 'webhook_url', TEAMS],
      ['webhook', { webhook_url: GENERIC }, 'url', GENERIC],
      // A generic webhook pointed at Discord is stored as a Discord channel.
      ['webhook', { url: DISCORD }, 'webhook_url', DISCORD],
    ];
    for (const [type, config, key, value] of cases) {
      const res = await call(env, '/v1/hooks/inboxes/site/channels', {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ type, config }),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { data: { id: string; config: Record<string, string> } };
      expect(Object.keys(json.data.config)).toEqual([key]);
      expect(storedConfig(DB, json.data.id)).toEqual({ [key]: value });
    }
  });

  test('PATCH normalises the key too', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'site' });
    const id = seedChannel(DB, inboxId, 'discord', { webhook_url: DISCORD });
    const res = await call(env, `/v1/hooks/inboxes/site/channels/${id}`, {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ config: { url: `${DISCORD}2` } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { config: Record<string, string> } };
    expect(Object.keys(json.data.config)).toEqual(['webhook_url']);
    expect(storedConfig(DB, id)).toEqual({ webhook_url: `${DISCORD}2` });
  });

  test('senders accept rows stored under the other key', async () => {
    const { env, DB } = makeEnv();
    const inboxId = seedInbox(DB, { slug: 'site' });
    seedChannel(DB, inboxId, 'discord', { url: DISCORD });
    seedChannel(DB, inboxId, 'slack', { url: SLACK });
    seedChannel(DB, inboxId, 'teams', { url: TEAMS });
    seedChannel(DB, inboxId, 'webhook', { webhook_url: GENERIC });
    seedChannel(DB, inboxId, 'webhook', { webhook_url: SLACK });
    const urls = await submit(env);
    expect(urls.sort()).toEqual([DISCORD, GENERIC, SLACK, SLACK, TEAMS].sort());
  });
});
