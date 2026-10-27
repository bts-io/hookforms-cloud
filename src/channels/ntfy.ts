import type { NtfyChannelConfig } from '../types';
import type { ChannelPayload, ChannelContext } from './base';
import { formatValue } from '../services/format-value';
import { fitBytes, rawOnlyText, visibleEntries } from './raw';

const NTFY_MAX_BYTES = 4096;

/**
 * Ntfy channel adapter
 * Formats messages as plain text with custom headers
 */
export function buildNtfyPayload(
  config: NtfyChannelConfig,
  context: ChannelContext,
): ChannelPayload {
  // Filter out sensitive/internal fields
  const filteredBody = visibleEntries(context.body);
  const raw = rawOnlyText(context.body);

  // Build plain text body
  const lines = filteredBody.map(([k, v]) => {
    const fieldName = k.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    return `${fieldName}: ${formatValue(v)}`;
  });

  // ntfy turns a message over 4096 bytes into an attachment, so raw text is capped by bytes.
  const body = raw !== null ? fitBytes(raw, NTFY_MAX_BYTES) : lines.join('\n');

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    Title: `${context.subjectPrefix} New Submission`,
    Tags: 'incoming_envelope',
  };

  // Add priority if specified
  if (config.priority !== undefined) {
    headers.Priority = String(config.priority);
  }

  return {
    method: 'POST',
    url: config.url,
    headers,
    body,
  };
}
