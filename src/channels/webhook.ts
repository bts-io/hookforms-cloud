import type { WebhookChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { rawContentType, rawOnlyText, visibleEntries } from './raw';

/**
 * Generic webhook channel adapter
 * Sends the submitted fields as JSON with optional custom headers. A body that was not a form
 * or JSON object is forwarded as the original text.
 */
export function buildWebhookPayload(
  config: WebhookChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.fromEntries(visibleEntries(context.body));
  const raw = rawOnlyText(context.body);

  const headers: Record<string, string> = {
    'Content-Type': raw !== null ? rawContentType(raw) : 'application/json',
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
    body: raw !== null ? raw : JSON.stringify(filteredBody),
  };
}
