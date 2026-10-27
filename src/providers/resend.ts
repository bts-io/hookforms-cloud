import type { EmailBody, EmailProvider } from './base';
import type { ResendProviderConfig } from '../types';
import { sanitizeAddress, sanitizeHeaderValue } from './headers';

/**
 * Resend email provider (https://resend.com).
 * Uses the Resend REST API to send transactional email.
 */
export class ResendProvider implements EmailProvider {
  readonly type = 'resend';

  private apiKey: string;
  private fromEmail: string;

  constructor(config: ResendProviderConfig) {
    this.apiKey = config.api_key;
    this.fromEmail = config.from_email;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    senderName?: string,
  ): Promise<void> {
    // Resend parses "Name <email>" itself, so the name only loses control characters and the
    // characters that would end it early.
    const displayName = sanitizeHeaderValue(senderName || 'HookForms').replace(/[<>"]/g, '');
    const from = `${displayName} <${sanitizeAddress(this.fromEmail)}>`;

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
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Resend send failed: ${resp.status} ${text}`);
    }
  }
}
