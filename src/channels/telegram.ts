import type { TelegramChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';

/** The four characters Telegram's HTML parse mode requires escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Telegram channel adapter
 * Formats messages as HTML for Telegram sendMessage API
 */
export function buildTelegramPayload(
  config: TelegramChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = Object.entries(context.body)
    .filter(([k]) => k !== 'cf-turnstile-response' && k !== 'raw');

  // Build HTML formatted text. Every submitted value is escaped: under parse_mode HTML a
  // stray "<" makes Telegram reject the message, and real tags would render as links or markup.
  const title = `<b>${escapeHtml(context.subjectPrefix)} New Submission</b>`;
  const fields = filteredBody
    .map(([k, v]) => {
      const fieldName = k.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      return `<b>${escapeHtml(fieldName)}:</b> ${escapeHtml(formatValue(v))}`;
    })
    .join('\n');

  const text = `${title}\n\n${fields}`;

  const payload = {
    chat_id: config.chat_id,
    text,
    parse_mode: 'HTML',
  };

  return {
    method: 'POST',
    url: config.bot_url,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}
