import type { EmailBody } from './base';
import { encodeHeaderWord, formatMailbox, sanitizeAddress } from './headers';

/** Base64 of a UTF-8 string, wrapped at 76 characters for a MIME body. */
function base64Body(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/(.{76})/g, '$1\r\n');
}

/**
 * A raw RFC 5322 message with a multipart/alternative body: the plain-text part first, then the
 * HTML part, so clients that can show HTML pick it and the rest fall back to the text. Headers
 * are RFC 2047 encoded where needed and both parts are base64, so the message is pure ASCII.
 */
export function buildMimeMessage(opts: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: EmailBody;
  /** Optional Reply-To address; left out when empty after cleaning. */
  replyTo?: string;
  /** Optional display name for the Reply-To address. */
  replyToName?: string;
}): string {
  const boundary = `hf_${crypto.randomUUID().replace(/-/g, '')}`;
  const replyTo = opts.replyTo ? sanitizeAddress(opts.replyTo) : '';
  return [
    `From: ${formatMailbox(opts.fromName, opts.fromEmail)}`,
    `To: ${sanitizeAddress(opts.to)}`,
    ...(replyTo ? [`Reply-To: ${formatMailbox(opts.replyToName ?? '', replyTo)}`] : []),
    `Subject: ${encodeHeaderWord(opts.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(opts.body.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(opts.body.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
