import type { DiscordChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';

/**
 * Discord channel adapter
 * Formats messages as Discord embeds with gold color
 */
export function buildDiscordPayload(
  config: DiscordChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.entries(context.body)
    .filter(([k]) => k !== 'cf-turnstile-response' && k !== 'raw');

  // Build Discord embed fields
  const fields = filteredBody.map(([k, v]) => {
    const formatted = formatValue(v, 1024);
    return {
      name: k.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      value: formatted.substring(0, 1024),
      inline: formatted.length < 50,
    };
  });

  const embed = {
    title: `${context.subjectPrefix} New Submission`,
    color: 0xd4a843, // Gold color
    fields,
    footer: { text: `hookforms/hooks/${context.slug}` },
    timestamp: new Date().toISOString(),
  };

  return {
    method: 'POST',
    url: config.webhook_url || (config.url as string),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ embeds: [embed] }),
  };
}
