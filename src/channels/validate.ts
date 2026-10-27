import type { ChannelType, EmailProviderType } from '../types';
import { parseMailbox } from '../providers/headers';

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate channel config for a given channel type.
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export function validateChannelConfig(
  type: ChannelType,
  config: Record<string, unknown>,
): ValidationResult {
  switch (type) {
    case 'email':
      return validateEmail(config);
    case 'discord':
      return validateDiscord(config);
    case 'slack':
      return validateSlack(config);
    case 'teams':
      return validateTeams(config);
    case 'telegram':
      return validateTelegram(config);
    case 'ntfy':
      return validateNtfy(config);
    case 'webhook':
      return validateWebhook(config);
    default:
      return { valid: false, error: `Unknown channel type: ${type}` };
  }
}

/**
 * Store the URL under the key the sender for this type reads: `webhook_url` for Discord,
 * Slack and Teams, `url` for generic webhooks. Validation accepts either key, so a config
 * saved with the other one would otherwise reach a sender that cannot find its URL.
 */
export function normalizeChannelConfig(
  type: ChannelType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...config };
  if (type === 'discord' || type === 'slack' || type === 'teams') {
    if (!out.webhook_url && out.url) out.webhook_url = out.url;
    delete out.url;
  } else if (type === 'webhook') {
    if (!out.url && out.webhook_url) out.url = out.webhook_url;
    delete out.webhook_url;
  }
  return out;
}

/**
 * Validate email provider config for a given provider type.
 */
export function validateProviderConfig(
  type: EmailProviderType,
  config: Record<string, unknown>,
): ValidationResult {
  switch (type) {
    case 'gmail':
      return requireFields(config, ['client_id', 'client_secret', 'refresh_token', 'sender_email']);
    case 'resend':
      return requireFields(config, ['api_key', 'from_email']);
    case 'sendgrid':
      return requireFields(config, ['api_key', 'from_email']);
    case 'smtp':
      return requireFields(config, ['host', 'port', 'from_email']);
    default:
      return { valid: false, error: `Unknown provider type: ${type}` };
  }
}

/** The config key that holds the sender address for each provider type. */
function senderKey(type: EmailProviderType): 'sender_email' | 'from_email' {
  return type === 'gmail' ? 'sender_email' : 'from_email';
}

/**
 * Turn a provider's sender into a bare address. The providers add their own display name, so
 * `Name <address>` would otherwise reach them as an invalid sender (Resend answers 422). A name
 * given that way is kept as `from_name` unless the config already sets one.
 */
export function normalizeProviderConfig(
  type: EmailProviderType,
  config: Record<string, unknown>,
): { valid: true; config: Record<string, unknown> } | { valid: false; error: string } {
  const key = senderKey(type);
  const parsed = parseMailbox(config[key]);
  if (!parsed) {
    return {
      valid: false,
      error: `${key} must be an email address, either "you@example.com" or "Name <you@example.com>"`,
    };
  }
  const out: Record<string, unknown> = { ...config, [key]: parsed.email };
  if (parsed.name && !(typeof out.from_name === 'string' && out.from_name.trim())) {
    out.from_name = parsed.name;
  }
  return { valid: true, config: out };
}

/**
 * Suggest correct type if a typo is detected.
 */
export function suggestChannelType(input: string): string | null {
  const types: ChannelType[] = ['email', 'discord', 'slack', 'teams', 'telegram', 'ntfy', 'webhook'];

  // Exact match
  if (types.includes(input as ChannelType)) return null;

  // Simple Levenshtein-like matching for common typos
  const suggestions: Record<string, string> = {
    'discrod': 'discord',
    'dicord': 'discord',
    'disocrd': 'discord',
    'slak': 'slack',
    'sclack': 'slack',
    'team': 'teams',
    'ms-teams': 'teams',
    'msteams': 'teams',
    'microsoft-teams': 'teams',
    'telegarm': 'telegram',
    'telgram': 'telegram',
    'tg': 'telegram',
    'emal': 'email',
    'mail': 'email',
    'e-mail': 'email',
    'webhok': 'webhook',
    'hook': 'webhook',
    'nfty': 'ntfy',
    'notify': 'ntfy',
  };

  return suggestions[input.toLowerCase()] || null;
}

// --- Internal validators ---

function requireFields(config: Record<string, unknown>, fields: string[]): ValidationResult {
  for (const field of fields) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }
  return { valid: true };
}

/**
 * Parse an IPv4 host the way URL parsers and resolvers do: one to four parts, each decimal,
 * hex (0x) or octal (leading 0), the last part filling the remaining bytes. Returns the
 * address as a number, or null when the host is not an IPv4 literal.
 */
function parseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let addr = last;
  nums.forEach((n, i) => (addr += n * 256 ** (3 - i)));
  return addr;
}

function inV4(addr: number, base: string, bits: number): boolean {
  const b = base.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - bits);
  return Math.floor(addr / size) === Math.floor(b / size);
}

function isBlockedV4(addr: number): boolean {
  return (
    inV4(addr, '0.0.0.0', 8) ||
    inV4(addr, '10.0.0.0', 8) ||
    inV4(addr, '100.64.0.0', 10) ||
    inV4(addr, '127.0.0.0', 8) ||
    inV4(addr, '169.254.0.0', 16) ||
    inV4(addr, '172.16.0.0', 12) ||
    inV4(addr, '192.168.0.0', 16)
  );
}

/** Expand an IPv6 literal (no brackets) into eight 16-bit groups, or null if it is not one. */
function parseIPv6(host: string): number[] | null {
  let h = host.split('%')[0];
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = h.match(/^(.*:)([^:]+\.[^:]+)$/);
  if (v4) {
    const a = parseIPv4(v4[2]);
    if (a === null) return null;
    h = `${v4[1]}${Math.floor(a / 65536).toString(16)}:${(a % 65536).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isBlockedV6(g: number[]): boolean {
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses carry an IPv4 target.
  if (zeroTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedV4(g[6] * 65536 + g[7]);
  }
  return false;
}

/**
 * Check if a URL points to a blocked destination (SSRF protection): loopback, private,
 * link-local, carrier-grade NAT and metadata addresses, in any IPv4 or IPv6 spelling.
 */
export function isBlockedUrl(urlStr: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  if (!hostname) return true;

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'metadata.google.internal') return true;

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const groups = parseIPv6(hostname.slice(1, -1));
    return groups === null || isBlockedV6(groups);
  }

  const v4 = parseIPv4(hostname);
  if (v4 !== null) return isBlockedV4(v4);
  return false;
}

/**
 * Check an outbound URL a user configures (channel or inbox forward): http(s) only and not
 * a blocked destination. Returns an error message, or null when the URL is fine.
 */
export function checkOutboundUrl(value: unknown, fieldName: string): string | null {
  const err = validateUrl(value, fieldName);
  return err ? err.error || `${fieldName} is invalid` : null;
}

function validateUrl(value: unknown, fieldName: string): ValidationResult | null {
  if (typeof value !== 'string' || !value) {
    return { valid: false, error: `Missing required field: ${fieldName}` };
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: `${fieldName} must use http or https protocol` };
    }
  } catch {
    return { valid: false, error: `${fieldName} is not a valid URL` };
  }
  if (isBlockedUrl(value)) {
    return { valid: false, error: `${fieldName} points to a blocked destination` };
  }
  return null; // no error
}

// One address, no spaces or line breaks, something on both sides of a single @ and a dot in the domain.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function validateEmail(config: Record<string, unknown>): ValidationResult {
  const recipients = config.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { valid: false, error: 'Email channel requires a non-empty recipients array' };
  }
  for (const r of recipients) {
    if (typeof r !== 'string' || !EMAIL_RE.test(r)) {
      return { valid: false, error: `Invalid email address: ${r}` };
    }
  }
  return { valid: true };
}

function validateDiscord(config: Record<string, unknown>): ValidationResult {
  const url = config.webhook_url || config.url;
  const urlErr = validateUrl(url, 'webhook_url');
  if (urlErr) return urlErr;
  if (typeof url === 'string' && !url.includes('discord.com/api/webhooks')) {
    return { valid: false, error: 'Discord webhook_url must be a discord.com webhook URL' };
  }
  return { valid: true };
}

function validateSlack(config: Record<string, unknown>): ValidationResult {
  const url = config.webhook_url || config.url;
  const urlErr = validateUrl(url, 'webhook_url');
  if (urlErr) return urlErr;
  if (typeof url === 'string' && !url.includes('hooks.slack.com/')) {
    return { valid: false, error: 'Slack webhook_url must be a hooks.slack.com URL' };
  }
  return { valid: true };
}

function validateTeams(config: Record<string, unknown>): ValidationResult {
  const url = config.webhook_url || config.url;
  const urlErr = validateUrl(url, 'webhook_url');
  if (urlErr) return urlErr;
  return { valid: true };
}

function validateTelegram(config: Record<string, unknown>): ValidationResult {
  const urlErr = validateUrl(config.bot_url, 'bot_url');
  if (urlErr) return urlErr;
  if (!config.chat_id) {
    return { valid: false, error: 'Telegram channel requires chat_id' };
  }
  return { valid: true };
}

function validateNtfy(config: Record<string, unknown>): ValidationResult {
  const urlErr = validateUrl(config.url, 'url');
  if (urlErr) return urlErr;
  if (config.priority !== undefined) {
    const p = Number(config.priority);
    if (isNaN(p) || p < 1 || p > 5) {
      return { valid: false, error: 'Ntfy priority must be between 1 and 5' };
    }
  }
  return { valid: true };
}

function validateWebhook(config: Record<string, unknown>): ValidationResult {
  const url = config.url || config.webhook_url;
  const urlErr = validateUrl(url, 'url');
  if (urlErr) return urlErr;
  if (config.custom_headers !== undefined && typeof config.custom_headers !== 'object') {
    return { valid: false, error: 'custom_headers must be an object' };
  }
  return { valid: true };
}
