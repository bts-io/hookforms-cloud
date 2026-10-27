import { describe, expect, test } from 'bun:test';
import { isBlockedUrl } from '../src/channels/validate';
import { buildLegacyForward } from '../src/routes/webhooks';
import { ADMIN, call, makeEnv, seedInbox } from './helpers';

const BLOCKED = [
  'http://127.0.0.1/',
  'http://127.1.2.3/',
  'http://localhost/',
  'http://foo.localhost/',
  'http://0.0.0.0/',
  'http://0.1.2.3/',
  'http://10.1.2.3/',
  'http://172.16.0.1/',
  'http://172.31.255.255/',
  'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data',
  'http://100.64.0.1/',
  'http://100.127.255.255/',
  'http://[::1]/',
  'http://[::]/',
  'http://[fc00::1]/',
  'http://[fd12:3456::1]/',
  'http://[fe80::1]/',
  'http://[febf::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:a9fe:a9fe]/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0x7f.0.0.1/',
  'http://0177.0.0.1/',
  'http://017700000001/',
  'http://127.1/',
  'http://metadata.google.internal/',
];

const ALLOWED = [
  'https://example.com/hook',
  'http://8.8.8.8/',
  'http://172.32.0.1/',
  'http://100.128.0.1/',
  'http://[2001:4860:4860::8888]/',
  'http://[fec0::1]/',
  'https://discord.com/api/webhooks/1/x',
];

describe('SSRF blocklist', () => {
  for (const u of BLOCKED) test(`blocks ${u}`, () => expect(isBlockedUrl(u)).toBe(true));
  for (const u of ALLOWED) test(`allows ${u}`, () => expect(isBlockedUrl(u)).toBe(false));
});

describe('inbox forward_url', () => {
  test('POST and PATCH reject blocked or malformed forward URLs', async () => {
    const { env, DB } = makeEnv();
    for (const forward_url of ['http://127.0.0.1:8787/', 'http://[::1]/', 'ftp://example.com/', 'nope']) {
      const res = await call(env, '/v1/hooks/inboxes', {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ slug: `s${Math.random().toString(36).slice(2)}`, forward_url }),
      });
      expect(res.status).toBe(400);
    }
    seedInbox(DB, { slug: 'f', forward_url: 'https://example.com/ok' });
    const res = await call(env, '/v1/hooks/inboxes/f', {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ forward_url: 'http://10.0.0.1/' }),
    });
    expect(res.status).toBe(400);
    const row = DB.raw.query("SELECT forward_url FROM webhook_inboxes WHERE slug = 'f'").get() as {
      forward_url: string;
    };
    expect(row.forward_url).toBe('https://example.com/ok');
  });

  test('POST and PATCH accept a public forward URL or clearing it', async () => {
    const { env } = makeEnv();
    const res = await call(env, '/v1/hooks/inboxes', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ slug: 'okf', forward_url: 'https://example.com/hook' }),
    });
    expect(res.status).toBe(201);
    const cleared = await call(env, '/v1/hooks/inboxes/okf', {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ forward_url: null }),
    });
    expect(cleared.status).toBe(200);
  });
});

describe('legacy forward', () => {
  const inbox = { forward_url: 'https://example.com/hook', email_subject_prefix: null, sender_name: null };

  test('GET forwards carry no body', () => {
    const f = buildLegacyForward(inbox as never, 'x', { a: '1' }, 'GET');
    expect(f.method).toBe('GET');
    expect(f.body).toBeUndefined();
    const p = buildLegacyForward(inbox as never, 'x', { a: '1' }, 'PUT');
    expect(p.method).toBe('PUT');
    expect(p.body).toBe('{"a":"1"}');
  });

  test('Discord forwards skip empty values and send at most 25 fields', () => {
    const body: Record<string, unknown> = { empty: '', blank: '  ', nothing: null };
    for (let i = 0; i < 40; i++) body[`f_${i}`] = `v${i}`;
    const f = buildLegacyForward(
      { ...inbox, forward_url: 'https://discord.com/api/webhooks/1/x' } as never,
      'x',
      body,
      'POST',
    );
    const fields = JSON.parse(f.body!).embeds[0].fields as { value: string }[];
    expect(fields.length).toBe(25);
    for (const fl of fields) expect(fl.value.trim()).not.toBe('');
  });
});
