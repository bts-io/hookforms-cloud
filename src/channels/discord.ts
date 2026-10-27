import type { DiscordChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';
import { fitText, rawOnlyText, visibleEntries } from './raw';

const DISCORD_MAX_FIELDS = 25;
const DISCORD_MAX_DESCRIPTION = 4096;

/**
 * Discord channel adapter
 * Formats messages as Discord embeds with gold color
 */
export function buildDiscordPayload(
  config: DiscordChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = visibleEntries(context.body);
  // A body that was not a form or JSON object is shown as text in the description.
  const raw = rawOnlyText(context.body);

  // Build Discord embed fields. Discord rejects the whole message for an empty field value,
  // more than 25 fields, or a name over 256 characters, so empty values are skipped and
  // the rest capped.
  const fields = raw !== null ? [] : filteredBody
    .map(([k, v]) => ({ k, formatted: v == null ? '' : formatValue(v, 1024) }))
    .filter(({ formatted }) => formatted.trim() !== '')
    .slice(0, DISCORD_MAX_FIELDS)
    .map(({ k, formatted }) => ({
      name: k.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).substring(0, 256),
      value: formatted.substring(0, 1024),
      inline: formatted.length < 50,
    }));

  const embed = {
    title: `${context.subjectPrefix} New Submission`,
    color: 0xd4a843, // Gold color
    ...(raw !== null && raw.trim() !== '' ? { description: fitText(raw, DISCORD_MAX_DESCRIPTION) } : {}),
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
