import type { TelegramChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';
import { fitText, rawOnlyText, visibleEntries } from './raw';

const TELEGRAM_MAX_TEXT = 4096;

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
  const filteredBody = visibleEntries(context.body);
  const raw = rawOnlyText(context.body);

  // Build HTML formatted text. Every submitted value is escaped: under parse_mode HTML a
  // stray "<" makes Telegram reject the message, and real tags would render as links or markup.
  const titleText = `${context.subjectPrefix} New Submission`;
  const title = `<b>${escapeHtml(titleText)}</b>`;
  // Telegram's 4096 limit counts the text after entity parsing, so the raw text is cut before escaping.
  const fields = raw !== null
    ? escapeHtml(fitText(raw, Math.max(1, TELEGRAM_MAX_TEXT - titleText.length - 2)))
    : filteredBody
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
