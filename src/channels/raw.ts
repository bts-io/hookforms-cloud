/**
 * Helpers for submissions that arrive as something other than a JSON object or a form
 * (a JSON array or primitive, text/plain, unparsable JSON). Those are stored as `{ raw: text }`,
 * and the senders show that text instead of an empty field list.
 */

const INTERNAL_KEYS = new Set(['cf-turnstile-response']);

/**
 * The submitted text when the body holds nothing but `raw`, else null. A form field named
 * `raw` next to other fields is an ordinary field and returns null.
 */
export function rawOnlyText(body: Record<string, unknown>): string | null {
  const keys = Object.keys(body).filter((k) => !INTERNAL_KEYS.has(k));
  if (keys.length !== 1 || keys[0] !== 'raw') return null;
  return typeof body.raw === 'string' ? body.raw : null;
}

/** Body entries without internal fields such as the Turnstile token. */
export function visibleEntries(body: Record<string, unknown>): [string, unknown][] {
  return Object.entries(body).filter(([k]) => !INTERNAL_KEYS.has(k));
}

const ELLIPSIS = '…';

/**
 * Cut `text` so that `escape(text)` is at most `max` characters, ending with an ellipsis when
 * anything was cut. Cuts happen before escaping, so an escape sequence is never split.
 */
export function fitText(text: string, max: number, escape: (s: string) => string = (s) => s): string {
  const whole = escape(text);
  if (whole.length <= max) return whole;
  const chars = Array.from(text);
  let keep = Math.min(chars.length, max - 1);
  while (keep > 0) {
    const out = escape(chars.slice(0, keep).join('')) + ELLIPSIS;
    if (out.length <= max) return out;
    keep -= Math.max(1, out.length - max);
  }
  return ELLIPSIS;
}

/** Cut `text` to at most `maxBytes` of UTF-8, without splitting a character. */
export function fitBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  const budget = maxBytes - enc.encode(ELLIPSIS).length;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > budget) break;
    used += n;
    out += ch;
  }
  return out + ELLIPSIS;
}

/** Content type for forwarding the original text: JSON when it parses as JSON, else plain text. */
export function rawContentType(text: string): string {
  try {
    JSON.parse(text);
    return 'application/json';
  } catch {
    return 'text/plain';
  }
}
