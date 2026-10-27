import type { Env, EmailProviderRecord, GmailProviderConfig, ResendProviderConfig, SendGridProviderConfig } from '../types';
import type { EmailProvider } from './base';
import { GmailProvider } from './gmail';
import { ResendProvider } from './resend';
import { SendGridProvider } from './sendgrid';

/** Where a resolved provider came from: the inbox's own row, the global row, or env Gmail. */
export type ProviderSource = 'inbox' | 'global' | 'env_gmail';

export interface ResolvedProvider {
  provider: EmailProvider;
  source: ProviderSource;
}

/**
 * Resolve the email provider for a given inbox.
 *
 * Priority:
 *   1. Inbox-specific provider (email_providers row with matching inbox_id)
 *   2. Global provider (email_providers row with inbox_id = NULL)
 *   3. Legacy env-based Gmail (GMAIL_* secrets)
 *   4. null (no email provider available)
 */
export async function resolveEmailProvider(
  env: Env,
  inboxId: string,
): Promise<EmailProvider | null> {
  return (await resolveEmailProviderWithSource(env, inboxId))?.provider ?? null;
}

/** Same order as resolveEmailProvider, also saying which step matched. No inbox skips step 1. */
export async function resolveEmailProviderWithSource(
  env: Env,
  inboxId: string | null,
): Promise<ResolvedProvider | null> {
  // 1. Try inbox-specific provider
  if (inboxId) {
    const specific = await env.DB.prepare(
      'SELECT * FROM email_providers WHERE inbox_id = ? AND is_active = 1 LIMIT 1',
    )
      .bind(inboxId)
      .first<EmailProviderRecord>();

    if (specific) {
      return { provider: buildProvider(specific), source: 'inbox' };
    }
  }

  // 2. Try global provider
  const global = await env.DB.prepare(
    'SELECT * FROM email_providers WHERE inbox_id IS NULL AND is_active = 1 LIMIT 1',
  ).first<EmailProviderRecord>();

  if (global) {
    return { provider: buildProvider(global), source: 'global' };
  }

  // 3. Legacy env-based Gmail
  const gmail = GmailProvider.fromEnv(env);
  return gmail ? { provider: gmail, source: 'env_gmail' } : null;
}

/**
 * Instantiate a provider from a database record.
 */
function buildProvider(record: EmailProviderRecord): EmailProvider {
  const config = JSON.parse(record.config);

  switch (record.type) {
    case 'gmail':
      return new GmailProvider(config as GmailProviderConfig);
    case 'resend':
      return new ResendProvider(config as ResendProviderConfig);
    case 'sendgrid':
      return new SendGridProvider(config as SendGridProviderConfig);
    default:
      throw new Error(`Unknown email provider type: ${record.type}`);
  }
}
