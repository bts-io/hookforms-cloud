import type { TeamsChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';

/**
 * Microsoft Teams channel adapter
 * Formats messages as Adaptive Cards
 */
export function buildTeamsPayload(
  config: TeamsChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.entries(context.body)
    .filter(([k]) => k !== 'cf-turnstile-response' && k !== 'raw');

  // Build Adaptive Card FactSet
  const facts = filteredBody.map(([k, v]) => ({
    title: k.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
    value: formatValue(v),
  }));

  const adaptiveCard = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: `${context.subjectPrefix} New Submission`,
              weight: 'Bolder',
              size: 'Large',
            },
            {
              type: 'FactSet',
              facts,
            },
            {
              type: 'TextBlock',
              text: `hookforms/hooks/${context.slug}`,
              size: 'Small',
              color: 'Accent',
              spacing: 'Medium',
            },
          ],
        },
      },
    ],
  };

  return {
    method: 'POST',
    url: config.webhook_url || (config.url as string),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(adaptiveCard),
  };
}
