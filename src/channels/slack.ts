import type { SlackChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';
import { fitText, rawOnlyText, visibleEntries } from './raw';

const SLACK_MAX_SECTION_TEXT = 3000;

/** The three characters Slack mrkdwn requires escaped. */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Section text for a body that was not a form or JSON object: the text itself, escaped and capped. */
export function slackRawText(raw: string): string {
  return fitText(raw, SLACK_MAX_SECTION_TEXT, escapeMrkdwn);
}

/**
 * Slack channel adapter
 * Formats messages as Slack blocks with mrkdwn
 */
export function buildSlackPayload(
  config: SlackChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = visibleEntries(context.body);
  const raw = rawOnlyText(context.body);

  // Build Slack mrkdwn lines
  const lines =
    raw !== null
      ? [slackRawText(raw)]
      : filteredBody.map(([k, v]) => `*${k.replace(/_/g, ' ')}:* ${formatValue(v)}`);

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
