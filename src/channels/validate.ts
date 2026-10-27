import type { ChannelType, EmailProviderType } from '../types';

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
 * Check if a URL points to a blocked destination (SSRF protection).
 */
function isBlockedUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
      return true;
    }

    // Block common metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return true;
    }

    // Block private IP ranges (simple pattern match)
    if (/^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^192\.168\./.test(hostname)) {
      return true;
    }

    // Block 0.0.0.0
    if (hostname === '0.0.0.0') {
      return true;
    }

    // Block link-local
    if (/^169\.254\./.test(hostname) || /^fe80:/i.test(hostname)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
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

function validateEmail(config: Record<string, unknown>): ValidationResult {
  const recipients = config.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { valid: false, error: 'Email channel requires a non-empty recipients array' };
  }
  for (const r of recipients) {
    if (typeof r !== 'string' || !r.includes('@')) {
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
