import type { EmailBody, EmailProvider, SendOptions } from './base';
import type { ResendProviderConfig } from '../types';
import { parseMailbox, sanitizeAddress, sanitizeHeaderValue } from './headers';

/**
 * Resend email provider (https://resend.com).
 * Uses the Resend REST API to send transactional email.
 */
export class ResendProvider implements EmailProvider {
  readonly type = 'resend';

  private apiKey: string;
  private fromEmail: string;
  private fromName?: string;

  constructor(config: ResendProviderConfig) {
    this.apiKey = config.api_key;
    // Rows saved before senders were normalized may still hold "Name <address>".
    const parsed = parseMailbox(config.from_email);
    this.fromEmail = parsed?.email ?? config.from_email;
    this.fromName = config.from_name || parsed?.name;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    senderName?: string,
    options?: SendOptions,
  ): Promise<void> {
    // Resend parses "Name <email>" itself, so the name only loses control characters and the
    // characters that would end it early. A name with commas or other specials is quoted.
    const displayName = sanitizeHeaderValue(senderName || this.fromName || 'HookForms').replace(/[<>"]/g, '');
    const name = /[()[\]:;@\\,.]/.test(displayName) ? `"${displayName.replace(/\\/g, '\\\\')}"` : displayName;
    const from = `${name} <${sanitizeAddress(this.fromEmail)}>`;
    const replyAddress = options?.replyTo ? sanitizeAddress(options.replyTo) : '';
    const replyName = sanitizeHeaderValue(options?.replyToName ?? '').replace(/[<>"]/g, '');
    const quotedName = /[()[\]:;@\\,.]/.test(replyName) ? `"${replyName.replace(/\\/g, '\\\\')}"` : replyName;
    const replyTo = replyAddress && replyName ? `${quotedName} <${replyAddress}>` : replyAddress;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [sanitizeAddress(to)],
        subject: sanitizeHeaderValue(subject),
        html: body.html,
        text: body.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Resend send failed: ${resp.status} ${text}`);
    }
  }
}
