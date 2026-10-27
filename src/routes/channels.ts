import { Hono } from 'hono';
import type { Env, Inbox, NotificationChannel, ChannelType, EmailProviderType } from '../types';
import { requireScope } from '../middleware/auth';
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
    if (sensitiveKeys.has(key) && typeof value === 'string' && value.length > 8) {
      redacted[key] = value.slice(0, 4) + '***' + value.slice(-4);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
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

  // Validate channel type
  let channelType = body.type;
  if (!VALID_CHANNEL_TYPES.includes(channelType)) {
    const suggestion = suggestChannelType(channelType);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    return c.json({ error: { code: 400, message: `Invalid channel type: ${channelType}.${hint}` } }, 400);
  }

  // Auto-detect webhook URL type (check both 'url' and 'webhook_url' keys)
  if (channelType === 'webhook') {
    const url = (body.config.url || body.config.webhook_url) as string | undefined;
    if (url) {
      const detected = detectChannelType(url);
      if (detected !== 'webhook') {
        channelType = detected as ChannelType;
      }
    }
  }

  // Validate config for the resolved channel type
  const validation = validateChannelConfig(channelType, body.config);
  if (!validation.valid) {
    return c.json({ error: { code: 400, message: validation.error } }, 400);
  }

  const config = normalizeChannelConfig(channelType, body.config);

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

  const allowed = ['type', 'label', 'config', 'is_active'];
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of allowed) {
    if (field in body) {
      if (field === 'config') {
        const type = ((body.type as ChannelType | undefined) ?? existing.type) as ChannelType;
        updates.push('config = ?');
        values.push(JSON.stringify(normalizeChannelConfig(type, body.config as Record<string, unknown>)));
      } else if (field === 'type') {
        const newType = body.type as string;
        if (!VALID_CHANNEL_TYPES.includes(newType as ChannelType)) {
          return c.json({ error: { code: 400, message: `Invalid channel type: ${newType}` } }, 400);
        }
        updates.push('type = ?');
        values.push(newType);
      } else {
        updates.push(`${field} = ?`);
        values.push(body[field] ?? null);
      }
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
      config: provider ? JSON.parse(provider.config as string) : null,
    },
  });
});

channels.delete('/config/email-provider', requireScope('webhooks'), async (c) => {
  const inboxSlug = c.req.query('inbox');

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
