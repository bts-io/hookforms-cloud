import type { EmailBody, EmailProvider } from './base';
import type { SendGridProviderConfig } from '../types';
import { parseMailbox, sanitizeAddress, sanitizeHeaderValue } from './headers';

/**
 * SendGrid email provider (https://sendgrid.com).
 * Uses the SendGrid v3 Mail Send API.
 */
export class SendGridProvider implements EmailProvider {
  readonly type = 'sendgrid';

  private apiKey: string;
  private fromEmail: string;
  private fromName?: string;

  constructor(config: SendGridProviderConfig) {
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
  ): Promise<void> {
    const displayName = sanitizeHeaderValue(senderName || this.fromName || 'HookForms');

    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: sanitizeAddress(to) }] }],
        from: { email: sanitizeAddress(this.fromEmail), name: displayName },
        subject: sanitizeHeaderValue(subject),
        // SendGrid wants text/plain before text/html.
        content: [
          { type: 'text/plain', value: body.text },
          { type: 'text/html', value: body.html },
        ],
      }),
    });

    // SendGrid returns 202 on success
    if (!resp.ok && resp.status !== 202) {
      const text = await resp.text();
      throw new Error(`SendGrid send failed: ${resp.status} ${text}`);
    }
  }
}
