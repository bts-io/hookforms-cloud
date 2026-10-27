import { describe, expect, test } from 'bun:test';
import { buildDiscordPayload } from '../src/channels/discord';

const base = { slug: 'site', subjectPrefix: '[site]', senderName: 'HookForms' };

describe('Discord payload', () => {
  test('empty values are skipped and at most 25 fields are sent', () => {
    const body: Record<string, unknown> = { empty: '', nothing: null, blank: '   ' };
    for (let i = 0; i < 40; i++) body[`field_${i}`] = `value ${i}`;
    const p = buildDiscordPayload(
      { webhook_url: 'https://discord.com/api/webhooks/1/x' },
      { ...base, body },
    );
    const { embeds } = JSON.parse(p.body) as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const fields = embeds[0].fields;
    expect(fields.length).toBeLessThanOrEqual(25);
    expect(fields[0].name).toBe('Field 0');
    for (const f of fields) {
      expect(f.value.trim().length).toBeGreaterThan(0);
      expect(f.name.length).toBeLessThanOrEqual(256);
    }
  });
});
