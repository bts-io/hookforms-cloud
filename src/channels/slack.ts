import type { SlackChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';

/**
 * Slack channel adapter
 * Formats messages as Slack blocks with mrkdwn
 */
export function buildSlackPayload(
  config: SlackChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.entries(context.body)
    .filter(([k]) => k !== 'cf-turnstile-response' && k !== 'raw');

  // Build Slack mrkdwn lines
  const lines = filteredBody.map(([k, v]) => `*${k.replace(/_/g, ' ')}:* ${formatValue(v)}`);

  const payload = {
    text: `${context.subjectPrefix} New Submission`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
    ],
  };

  return {
    method: 'POST',
    url: config.webhook_url || (config.url as string),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}
