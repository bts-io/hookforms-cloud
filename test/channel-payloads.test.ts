import { describe, expect, test } from 'bun:test';
import { buildTelegramPayload } from '../src/channels/telegram';

const base = { slug: 'site', subjectPrefix: '[a<b>]', senderName: 'HookForms' };

describe('Telegram payload', () => {
  test('user values are HTML escaped under parse_mode HTML', () => {
    const p = buildTelegramPayload(
      { bot_url: 'https://api.telegram.org/botX/sendMessage', chat_id: '1' },
      { ...base, body: { 'na<i>me': '<a href="https://evil.example">click</a> & more' } },
    );
    const { text, parse_mode } = JSON.parse(p.body) as { text: string; parse_mode: string };
    expect(parse_mode).toBe('HTML');
    expect(text).not.toContain('<a href');
    expect(text).not.toContain('<i>');
    expect(text).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt; &amp; more');
    expect(text).toContain('[a&lt;b&gt;]');
  });
});
