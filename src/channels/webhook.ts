import type { WebhookChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';

/**
 * Generic webhook channel adapter
 * Sends the raw body as JSON with optional custom headers
 */
export function buildWebhookPayload(
  config: WebhookChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.fromEntries(
    Object.entries(context.body).filter(
      ([k]) => k !== 'cf-turnstile-response' && k !== 'raw',
    ),
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-From': `hookforms/hooks/${context.slug}`,
  };

  // Merge custom headers if provided
  if (config.custom_headers) {
    Object.assign(headers, config.custom_headers);
  }

  return {
    method: 'POST',
    url: config.url || (config.webhook_url as string),
    headers,
    body: JSON.stringify(filteredBody),
  };
}
