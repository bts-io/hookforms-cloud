import { Hono } from 'hono';
import type { Env, Inbox, NotificationChannel, ChannelType, EmailProviderType } from '../types';
import { keyHasScope, requireScope } from '../middleware/auth';
import { detectChannelType } from '../channels/detect';
import {
  normalizeChannelConfig,
  validateChannelConfig,
  validateProviderConfig,
  suggestChannelType,
} from '../channels/validate';

const channels = new Hono<{ Bindings: Env }>();

const VALID_CHANNEL_TYPES: ChannelType[] = [
  'email', 'discord', 'slack', 'teams', 'telegram', 'ntfy', 'webhook',
];

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    'webhook_url', 'url', 'bot_url', 'api_key', 'client_id',
    'client_secret', 'refresh_token', 'password',
  ]);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (sensitiveKeys.has(key) && typeof value === 'string') {
      // Short values would be shown almost whole by the prefix and suffix, so hide them fully.
      redacted[key] = value.length > 12 ? value.slice(0, 4) + '***' + value.slice(-4) : '***';
    } else if (key === 'custom_headers' && value && typeof value === 'object') {
      // Header names stay visible; their values are often credentials.
      redacted[key] = Object.fromEntries(Object.keys(value).map((name) => [name, '***']));
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Check a channel type and config the same way for create and update: known type, webhook URL
 * auto-detection, per-type validation (including the SSRF blocklist), then key normalisation.
 */
function resolveChannel(
  type: unknown,
  config: unknown,
): { type: ChannelType; config: Record<string, unknown> } | { error: string } {
  if (typeof type !== 'string' || !VALID_CHANNEL_TYPES.includes(type as ChannelType)) {
    const suggestion = typeof type === 'string' ? suggestChannelType(type) : null;
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    return { error: `Invalid channel type: ${String(type)}.${hint}` };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'config must be an object' };
  }
  const cfg = config as Record<string, unknown>;
  let channelType = type as ChannelType;

  // Auto-detect webhook URL type (check both 'url' and 'webhook_url' keys)
  if (channelType === 'webhook') {
    const url = cfg.url || cfg.webhook_url;
    if (typeof url === 'string' && url) {
      const detected = detectChannelType(url);
      if (detected !== 'webhook') channelType = detected as ChannelType;
    }
  }

  const validation = validateChannelConfig(channelType, cfg);
  if (!validation.valid) return { error: validation.error || 'Invalid config' };

  return { type: channelType, config: normalizeChannelConfig(channelType, cfg) };
}

// ---------------------------------------------------------------------------
// Channel CRUD (nested under /inboxes/:slug/channels)
// ---------------------------------------------------------------------------

channels.post('/inboxes/:slug/channels', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');

  const inbox = await c.env.DB.prepare('SELECT * FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<Inbox>();
  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const body = await c.req.json<{
    type: ChannelType;
    label?: string;
    config: Record<string, unknown>;
  }>();

  if (!body.type || !body.config) {
    return c.json({ error: { code: 400, message: 'type and config are required' } }, 400);
  }

  const resolved = resolveChannel(body.type, body.config);
  if ('error' in resolved) {
    return c.json({ error: { code: 400, message: resolved.error } }, 400);
  }
  const { type: channelType, config } = resolved;

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO notification_channels (id, inbox_id, type, label, config, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  )
    .bind(id, inbox.id, channelType, body.label || null, JSON.stringify(config))
    .run();

  const channel = await c.env.DB.prepare('SELECT * FROM notification_channels WHERE id = ?')
    .bind(id)
    .first<NotificationChannel>();

  return c.json({
    data: {
      ...channel,
      config: channel ? JSON.parse(channel.config) : null,
    },
  }, 201);
});

channels.get('/inboxes/:slug/channels', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const results = await c.env.DB.prepare(
    'SELECT * FROM notification_channels WHERE inbox_id = ? ORDER BY created_at DESC',
  )
    .bind(inbox.id)
    .all<NotificationChannel>();

  const items = (results.results || []).map((ch) => ({
    ...ch,
    config: redactConfig(JSON.parse(ch.config)),
  }));

  return c.json({ data: items });
});

channels.patch('/inboxes/:slug/channels/:channelId', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');
  const channelId = c.req.param('channelId');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const existing = await c.env.DB.prepare(
    'SELECT * FROM notification_channels WHERE id = ? AND inbox_id = ?',
  )
    .bind(channelId, inbox.id)
    .first<NotificationChannel>();
  if (!existing) {
    return c.json({ error: { code: 404, message: 'Channel not found' } }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();

  const updates: string[] = [];
  const values: unknown[] = [];

  // A new type or config is checked as a whole, exactly as on create.
  if ('type' in body || 'config' in body) {
    const type = 'type' in body ? body.type : existing.type;
    const config = 'config' in body ? body.config : JSON.parse(existing.config);
    const resolved = resolveChannel(type, config);
    if ('error' in resolved) {
      return c.json({ error: { code: 400, message: resolved.error } }, 400);
    }
    updates.push('type = ?', 'config = ?');
    values.push(resolved.type, JSON.stringify(resolved.config));
  }

  for (const field of ['label', 'is_active']) {
    if (field in body) {
      updates.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
  }

  if (updates.length > 0) {
    values.push(channelId, inbox.id);
    await c.env.DB.prepare(
      `UPDATE notification_channels SET ${updates.join(', ')} WHERE id = ? AND inbox_id = ?`,
    )
      .bind(...values)
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM notification_channels WHERE id = ?')
    .bind(channelId)
    .first<NotificationChannel>();

  return c.json({
    data: {
      ...updated,
      config: updated ? JSON.parse(updated.config) : null,
    },
  });
});

channels.delete('/inboxes/:slug/channels/:channelId', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');
  const channelId = c.req.param('channelId');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM notification_channels WHERE id = ? AND inbox_id = ?',
  )
    .bind(channelId, inbox.id)
    .first();
  if (!existing) {
    return c.json({ error: { code: 404, message: 'Channel not found' } }, 404);
  }

  await c.env.DB.prepare('DELETE FROM notification_channels WHERE id = ? AND inbox_id = ?')
    .bind(channelId, inbox.id)
    .run();

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Email provider config
// ---------------------------------------------------------------------------

channels.get('/config/email-provider', requireScope('webhooks'), async (c) => {
  const inboxSlug = c.req.query('inbox');

  let inboxId: string | null = null;
  if (inboxSlug) {
    const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
      .bind(inboxSlug)
      .first<{ id: string }>();
    if (!inbox) {
      return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
    }
    inboxId = inbox.id;
  }

  const query = inboxId
    ? c.env.DB.prepare('SELECT * FROM email_providers WHERE inbox_id = ? AND is_active = 1').bind(inboxId)
    : c.env.DB.prepare('SELECT * FROM email_providers WHERE inbox_id IS NULL AND is_active = 1');

  const provider = await query.first();

  if (!provider) {
    // Check if env-based Gmail is available
    const hasEnvGmail = !!(c.env.GMAIL_CLIENT_ID && c.env.GMAIL_CLIENT_SECRET && c.env.GMAIL_REFRESH_TOKEN);
    return c.json({
      data: null,
      meta: { fallback: hasEnvGmail ? 'env_gmail' : null },
    });
  }

  return c.json({
    data: {
      ...provider,
      config: redactConfig(JSON.parse(provider.config as string)),
    },
  });
});

channels.put('/config/email-provider', requireScope('webhooks'), async (c) => {
  const body = await c.req.json<{
    inbox?: string; // inbox slug — omit for global
    type: string;
    config: Record<string, unknown>;
  }>();

  if (!body.type || !body.config) {
    return c.json({ error: { code: 400, message: 'type and config are required' } }, 400);
  }

  // The global provider sends for every inbox without its own, so only admin keys may set it.
  if (!body.inbox && !keyHasScope(c, 'admin')) {
    return c.json(
      { error: { code: 403, message: 'Changing the global email provider needs an admin key' } },
      403,
    );
  }

  const validTypes = ['gmail', 'resend', 'sendgrid'];
  if (!validTypes.includes(body.type)) {
    return c.json({ error: { code: 400, message: `Invalid provider type: ${body.type}` } }, 400);
  }

  // Validate provider config
  const providerValidation = validateProviderConfig(body.type as EmailProviderType, body.config);
  if (!providerValidation.valid) {
    return c.json({ error: { code: 400, message: providerValidation.error } }, 400);
  }

  let inboxId: string | null = null;
  if (body.inbox) {
    const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
      .bind(body.inbox)
      .first<{ id: string }>();
    if (!inbox) {
      return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
    }
    inboxId = inbox.id;
  }

  // Upsert: delete existing then insert
  if (inboxId) {
    await c.env.DB.prepare('DELETE FROM email_providers WHERE inbox_id = ?').bind(inboxId).run();
  } else {
    await c.env.DB.prepare('DELETE FROM email_providers WHERE inbox_id IS NULL').run();
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO email_providers (id, inbox_id, type, config, is_active) VALUES (?, ?, ?, ?, 1)',
  )
    .bind(id, inboxId, body.type, JSON.stringify(body.config))
    .run();

  const provider = await c.env.DB.prepare('SELECT * FROM email_providers WHERE id = ?')
    .bind(id)
    .first();

  return c.json({
    data: {
      ...provider,
      config: provider ? redactConfig(JSON.parse(provider.config as string)) : null,
    },
  });
});

channels.delete('/config/email-provider', requireScope('webhooks'), async (c) => {
  const inboxSlug = c.req.query('inbox');

  if (!inboxSlug && !keyHasScope(c, 'admin')) {
    return c.json(
      { error: { code: 403, message: 'Changing the global email provider needs an admin key' } },
      403,
    );
  }

  if (inboxSlug) {
    const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
      .bind(inboxSlug)
      .first<{ id: string }>();
    if (!inbox) {
      return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
    }
    await c.env.DB.prepare('DELETE FROM email_providers WHERE inbox_id = ?').bind(inbox.id).run();
  } else {
    await c.env.DB.prepare('DELETE FROM email_providers WHERE inbox_id IS NULL').run();
  }

  return c.body(null, 204);
});

export { channels };
