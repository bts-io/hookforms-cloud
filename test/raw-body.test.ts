import { afterEach, describe, expect, test } from 'bun:test';
import { buildDiscordPayload } from '../src/channels/discord';
import { buildSlackPayload } from '../src/channels/slack';
import { buildTeamsPayload } from '../src/channels/teams';
import { buildTelegramPayload } from '../src/channels/telegram';
import { buildNtfyPayload } from '../src/channels/ntfy';
import { buildWebhookPayload } from '../src/channels/webhook';
import { buildEmailHtml } from '../src/services/email-template';
import { buildLegacyForward } from '../src/routes/webhooks';
import { call, makeEnv, mockFetch, seedChannel, seedInbox } from './helpers';

const base = { slug: 'site', subjectPrefix: '[site]', senderName: 'HookForms' };
const RAW = 'line one <b>&</b>\nline two';
const ctx = (body: Record<string, unknown>) => ({ ...base, body });

function discordEmbed(body: Record<string, unknown>) {
  const p = buildDiscordPayload({ webhook_url: 'https://discord.com/api/webhooks/1/a' }, ctx(body));
  return JSON.parse(p.body).embeds[0] as { description?: string; fields: { name: string; value: string }[] };
}
function slackText(body: Record<string, unknown>) {
  const p = buildSlackPayload({ webhook_url: 'https://hooks.slack.com/services/x' }, ctx(body));
  return JSON.parse(p.body).blocks[0].text.text as string;
}
function teamsCard(body: Record<string, unknown>) {
  const p = buildTeamsPayload({ webhook_url: 'https://example.webhook.office.com/x' }, ctx(body));
  return JSON.parse(p.body).attachments[0].content.body as Record<string, unknown>[];
}
function telegramText(body: Record<string, unknown>) {
  const p = buildTelegramPayload({ bot_url: 'https://api.telegram.org/botX/sendMessage', chat_id: '1' }, ctx(body));
  return JSON.parse(p.body).text as string;
}
function ntfyBody(body: Record<string, unknown>) {
  return buildNtfyPayload({ url: 'https://ntfy.sh/topic' }, ctx(body)).body;
}

describe('raw-only bodies', () => {
  test('Discord shows the raw text as the embed description', () => {
    const e = discordEmbed({ raw: RAW });
    expect(e.description).toBe(RAW);
    expect(e.fields).toEqual([]);
    expect(discordEmbed({ raw: 'x'.repeat(5000) }).description!.length).toBe(4096);
  });

  test('Slack shows the raw text escaped, within 3000 characters', () => {
    expect(slackText({ raw: RAW })).toBe('line one &lt;b&gt;&amp;&lt;/b&gt;\nline two');
    const long = slackText({ raw: '<'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(3000);
    expect(long.endsWith('&lt;') || long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/&(l|lt)?$/);
  });

  test('Teams shows the raw text in a wrapping text block', () => {
    const blocks = teamsCard({ raw: RAW });
    expect(blocks.some((b) => b.type === 'TextBlock' && b.text === RAW && b.wrap === true)).toBe(true);
    const long = teamsCard({ raw: 'y'.repeat(30000) });
    const block = long.find((b) => typeof b.text === 'string' && (b.text as string).startsWith('yyy'));
    expect((block!.text as string).length).toBeLessThanOrEqual(20000);
  });

  test('Telegram shows the raw text escaped, whole message within 4096 visible characters', () => {
    const t = telegramText({ raw: RAW });
    expect(t).toContain('line one &lt;b&gt;&amp;&lt;/b&gt;\nline two');
    const long = telegramText({ raw: '&'.repeat(6000) });
    const visible = long.replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    expect(visible.length).toBeLessThanOrEqual(4096);
    expect(visible.length).toBeGreaterThan(4000);
  });

  test('ntfy sends the raw text, within 4096 bytes', () => {
    expect(ntfyBody({ raw: RAW })).toBe(RAW);
    const long = ntfyBody({ raw: 'é'.repeat(5000) });
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(4096);
    expect(long.length).toBeGreaterThan(2000);
    expect(long).not.toContain('�');
  });

  test('generic webhook sends the original body', () => {
    const json = buildWebhookPayload({ url: 'https://example.com/h' }, ctx({ raw: '[1,2,3]' }));
    expect(json.body).toBe('[1,2,3]');
    expect(json.headers['Content-Type']).toBe('application/json');
    const text = buildWebhookPayload({ url: 'https://example.com/h' }, ctx({ raw: 'hello there' }));
    expect(text.body).toBe('hello there');
    expect(text.headers['Content-Type']).toBe('text/plain');
  });

  test('email shows the raw text escaped', () => {
    const html = buildEmailHtml('site', { raw: RAW });
    expect(html).toContain('line one &lt;b&gt;&amp;&lt;/b&gt;');
    expect(html).toContain('line two');
  });

  test('legacy Discord and Slack forwards show the raw text', () => {
    const inbox = { forward_url: 'https://discord.com/api/webhooks/1/x', email_subject_prefix: null, sender_name: null };
    const d = buildLegacyForward(inbox as never, 's', { raw: RAW }, 'POST');
    expect(JSON.parse(d.body!).embeds[0].description).toBe(RAW);
    const s = buildLegacyForward(
      { ...inbox, forward_url: 'https://hooks.slack.com/services/x' } as never,
      's',
      { raw: RAW },
      'POST',
    );
    expect(JSON.parse(s.body!).blocks[0].text.text).toBe('line one &lt;b&gt;&amp;&lt;/b&gt;\nline two');
    const g = buildLegacyForward(
      { ...inbox, forward_url: 'https://example.com/h' } as never,
      's',
      { raw: 'plain text' },
      'POST',
    );
    expect(g.body).toBe('plain text');
  });
});

describe('a form field named raw next to other fields', () => {
  const body = { name: 'Ann', raw: 'field value' };

  test('stays a normal field in every sender', () => {
    const e = discordEmbed(body);
    expect(e.description).toBeUndefined();
    expect(e.fields.map((f) => f.name)).toEqual(['Name', 'Raw']);
    expect(slackText(body)).toContain('*raw:* field value');
    expect(JSON.stringify(teamsCard(body))).toContain('"title":"Raw","value":"field value"');
    expect(telegramText(body)).toContain('<b>Raw:</b> field value');
    expect(ntfyBody(body)).toContain('Raw: field value');
    expect(JSON.parse(buildWebhookPayload({ url: 'https://example.com/h' }, ctx(body)).body)).toEqual(body);
    expect(buildEmailHtml('site', body)).toContain('field value');
  });
});

describe('receiving non-object bodies', () => {
  let fm: ReturnType<typeof mockFetch> | null = null;
  afterEach(() => {
    fm?.restore();
    fm = null;
  });

  for (const [label, payload] of [
    ['JSON array', '[1,"two",{"three":3}]'],
    ['JSON number', '42'],
    ['JSON string', '"hello"'],
    ['unparsable JSON', '{not json'],
  ] as const) {
    test(`${label} is stored under raw and reaches Discord as text`, async () => {
      const { env, DB } = makeEnv();
      const inboxId = seedInbox(DB, { slug: 'site' });
      seedChannel(DB, inboxId, 'discord', { webhook_url: 'https://discord.com/api/webhooks/1/a' });
      fm = mockFetch();
      const res = await call(env, '/hooks/site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      expect(res.status).toBe(200);
      const row = DB.raw.query('SELECT body FROM webhook_events').get() as { body: string };
      expect(JSON.parse(row.body)).toEqual({ raw: payload });
      expect(fm.calls.length).toBe(1);
      const sent = (await fm.calls[0].json()) as { embeds: { description: string }[] };
      expect(sent.embeds[0].description).toBe(payload);
    });
  }

  test('text/plain is stored under raw', async () => {
    const { env, DB } = makeEnv();
    seedInbox(DB, { slug: 'site' });
    const res = await call(env, '/hooks/site', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'just text',
    });
    expect(res.status).toBe(200);
    const row = DB.raw.query('SELECT body FROM webhook_events').get() as { body: string };
    expect(JSON.parse(row.body)).toEqual({ raw: 'just text' });
  });
});
