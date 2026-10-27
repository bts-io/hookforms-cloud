import { afterEach, describe, expect, test } from 'bun:test';
import { GmailProvider } from '../src/providers/gmail';
import { ResendProvider } from '../src/providers/resend';
import { SendGridProvider } from '../src/providers/sendgrid';
import { buildEmail } from '../src/services/email-template';
import { mockFetch } from './helpers';

/** Every notification email is a designed HTML part with a plain-text twin, and every provider sends both. */

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
});

const BODY = { html: '<p>Hello <strong>Zoë</strong></p>', text: 'Hello Zoë' };

function mimeParts(message: string): Record<string, string> {
  const boundary = /boundary="([^"]+)"/.exec(message)?.[1];
  expect(boundary).toBeTruthy();
  const parts: Record<string, string> = {};
  for (const chunk of message.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const type = /Content-Type: ([^;\r\n]+)/.exec(head ?? '')?.[1] ?? '';
    const bytes = Uint8Array.from(atob(rest.join('').replace(/\s/g, '')), (c) => c.charCodeAt(0));
    parts[type] = new TextDecoder().decode(bytes);
  }
  return parts;
}

describe('every provider sends both parts', () => {
  test('Resend sends html and text', async () => {
    fetchMock = mockFetch(() => Response.json({ id: '1' }));
    await new ResendProvider({ api_key: 'k', from_email: 'from@example.com' }).sendEmail(
      'to@example.com',
      'Subject',
      BODY,
    );
    const sent = (await fetchMock.calls[0].json()) as { html: string; text: string };
    expect(sent.html).toBe(BODY.html);
    expect(sent.text).toBe(BODY.text);
  });

  test('SendGrid sends text/plain then text/html content', async () => {
    fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    await new SendGridProvider({ api_key: 'k', from_email: 'from@example.com' }).sendEmail(
      'to@example.com',
      'Subject',
      BODY,
    );
    const sent = (await fetchMock.calls[0].json()) as { content: { type: string; value: string }[] };
    expect(sent.content).toEqual([
      { type: 'text/plain', value: BODY.text },
      { type: 'text/html', value: BODY.html },
    ]);
  });

  test('Gmail sends a multipart/alternative message', async () => {
    fetchMock = mockFetch((req) =>
      req.url.startsWith('https://oauth2.googleapis.com/')
        ? Response.json({ access_token: 't', expires_in: 3600, token_type: 'Bearer' })
        : new Response('{}'),
    );
    await new GmailProvider({
      client_id: 'id-parts',
      client_secret: 's',
      refresh_token: 'refresh-parts-12345',
      sender_email: 'from@example.com',
    }).sendEmail('to@example.com', 'Subject', BODY);
    const send = fetchMock.calls.find((r) => r.url.includes('/messages/send'))!;
    const { raw } = (await send.json()) as { raw: string };
    const message = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(message).toContain('Content-Type: multipart/alternative');
    const parts = mimeParts(message);
    expect(parts['text/plain']).toBe(BODY.text);
    expect(parts['text/html']).toBe(BODY.html);
  });
});

describe('buildEmail', () => {
  test('renders a designed HTML part and a matching text twin', () => {
    const mail = buildEmail(
      'contact',
      { name: 'Sam <b>', email: 'sam@example.com', message: 'Hi\nthere' },
      '[contact] New submission from Sam',
    );
    expect(mail.subject).toBe('[contact] New submission from Sam');
    expect(mail.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(mail.html).toContain('<html lang="en"');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('max-width:600px');
    expect(mail.html).toContain('<title>[contact] New submission from Sam</title>');
    expect(mail.html).toContain('Sam &lt;b&gt;');
    expect(mail.html).not.toContain('Sam <b>');
    expect(mail.text).toContain('New submission from Sam <b>');
    expect(mail.text).toContain('Message: Hi\nthere');
    expect(mail.text).toContain('Reply to Sam <b>: mailto:sam@example.com');
    // The footer is one line: why the reader got this email.
    expect(mail.text.endsWith(
      '\n--\nYou get this email because the inbox /hooks/contact sends its submissions here.\n',
    )).toBe(true);
    expect(`${mail.html}${mail.text}`).not.toContain('Delivered by');
    expect(mail.text).not.toMatch(/<(?!b>)[a-z][^>]*>/i);
    expect(`${mail.html}${mail.text}`).not.toMatch(/[–—]|&mdash;|&ndash;/);
  });

  test('a raw body is shown as text in both parts', () => {
    const mail = buildEmail('raw', { raw: '[1,2]' }, '[raw] New Submission');
    expect(mail.html).toContain('<pre');
    expect(mail.text).toContain('[1,2]');
    expect(mail.html).not.toContain('Reply to');
  });
});
