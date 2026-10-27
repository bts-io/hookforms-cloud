import { Hono } from 'hono';
import type { Env, Inbox } from '../types';
import { requireScope } from '../middleware/auth';
import { verifyTurnstile } from '../services/turnstile';
import { buildEmailHtml } from '../services/email-template';
import { dispatchNotifications, takeEmailSlot } from '../channels/dispatcher';
import { formatValue } from '../services/format-value';
import { buildDiscordPayload } from '../channels/discord';
import { checkOutboundUrl } from '../channels/validate';

const webhooks = new Hono<{ Bindings: Env }>();

/**
 * Build the request for an inbox's legacy forward_url. Discord and Slack URLs get a formatted
 * message (Discord through the same builder as Discord channels: empty values skipped, at most
 * 25 fields); any other URL gets the raw body with the original method, and GET or HEAD forwards
 * carry no body, since fetch refuses one there.
 */
export function buildLegacyForward(
  inbox: Pick<Inbox, 'forward_url' | 'email_subject_prefix' | 'sender_name'>,
  slug: string,
  body: Record<string, unknown>,
  method: string,
): { method: string; headers: Record<string, string>; body?: string } {
  const url = inbox.forward_url || '';
  const subjectPrefix = inbox.email_subject_prefix || `[${slug}]`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Forwarded-From': `hookforms/hooks/${slug}`,
  };

  if (url.includes('discord.com/api/webhooks')) {
    const payload = buildDiscordPayload(
      { webhook_url: url },
      { slug, subjectPrefix, senderName: inbox.sender_name || 'HookForms', body },
    );
    return { method: 'POST', headers, body: payload.body };
  }

  if (url.includes('hooks.slack.com/')) {
    const lines = Object.entries(body)
      .filter(([k, v]) => v && k !== 'cf-turnstile-response')
      .map(([k, v]) => `*${k.replace(/_/g, ' ')}:* ${formatValue(v)}`);
    return {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: `${subjectPrefix} New Submission`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
      }),
    };
  }

  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { method: m, headers };
  return { method: m, headers, body: JSON.stringify(body) };
}

/** forward_url may be empty (no forward) or a public http(s) URL. */
function forwardUrlError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return checkOutboundUrl(value, 'forward_url');
}

// ---------------------------------------------------------------------------
// Public: receive webhooks
// ---------------------------------------------------------------------------

const publicWebhooks = new Hono<{ Bindings: Env }>();

publicWebhooks.all('/hooks/:slug', async (c) => {
  const slug = c.req.param('slug');

  const inbox = await c.env.DB.prepare(
    'SELECT * FROM webhook_inboxes WHERE slug = ? AND is_active = 1',
  )
    .bind(slug)
    .first<Inbox>();

  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  // Parse body — check content-type first to avoid consuming the stream
  let body: Record<string, unknown> | null = null;
  const contentType = c.req.header('content-type') || '';

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const formData = await c.req.formData();
      body = {};
      for (const [key, val] of formData.entries()) {
        if (typeof val === 'string') body[key] = val;
      }
    } catch {
      /* fall through to raw text */
    }
  } else if (contentType.includes('application/json')) {
    try {
      body = await c.req.json();
    } catch {
      /* fall through to raw text */
    }
  } else {
    // Unknown content-type: try JSON first, then raw text
    try {
      body = await c.req.json();
    } catch {
      /* fall through to raw text */
    }
  }

  if (!body) {
    try {
      const raw = await c.req.text();
      if (raw) body = { raw };
    } catch {
      /* empty */
    }
  }

  // Turnstile verification: an inbox with a secret needs a token on every request, empty ones included.
  if (inbox.turnstile_secret) {
    const token = body?.['cf-turnstile-response'];
    if (body) delete body['cf-turnstile-response'];

    if (typeof token !== 'string' || !token) {
      return c.json(
        { error: { code: 400, message: 'Missing Turnstile verification token' } },
        400,
      );
    }

    const ip = c.req.header('CF-Connecting-IP') || '';
    const valid = await verifyTurnstile(inbox.turnstile_secret, token, ip);
    if (!valid) {
      return c.json({ error: { code: 403, message: 'Turnstile verification failed' } }, 403);
    }
  }

  // Store event
  const eventId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO webhook_events (id, inbox_id, method, headers, body, query_params, source_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      inbox.id,
      c.req.method,
      JSON.stringify(Object.fromEntries(c.req.raw.headers.entries())),
      body ? JSON.stringify(body) : null,
      JSON.stringify(Object.fromEntries(new URL(c.req.url).searchParams.entries())),
      c.req.header('CF-Connecting-IP') || null,
    )
    .run();

  // Dispatch notifications via channels or legacy fields
  if (body) {
    // Check if this inbox has any notification channel rows
    const channelCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM notification_channels WHERE inbox_id = ? AND is_active = 1',
    )
      .bind(inbox.id)
      .first<{ cnt: number }>();

    if (channelCount && channelCount.cnt > 0) {
      // Use the new channel dispatcher (handles all channel types including email)
      c.executionCtx.waitUntil(
        dispatchNotifications(inbox, body, c.executionCtx, c.env).catch((err) => {
          console.error('Notification dispatch failed:', err);
        }),
      );
    } else {
      // Legacy: forward_url + notify_email (backward compat for inboxes without channel rows)
      if (inbox.forward_url) {
        const forward = buildLegacyForward(inbox, slug, body, c.req.method);
        c.executionCtx.waitUntil(fetch(inbox.forward_url, forward).catch(() => {}));
      }

      if (inbox.notify_email && !(await takeEmailSlot(c.env, inbox.id))) {
        console.warn(`Email rate limit hit for inbox ${slug}`);
      } else if (inbox.notify_email) {
        const prefix = inbox.email_subject_prefix || `[${slug}]`;
        const name = String(body.name || 'Unknown');
        const subjectDetail = name !== 'Unknown' ? `from ${name}` : 'New Submission';
        const htmlBody = buildEmailHtml(slug, body, inbox.sender_name ?? undefined);

        const recipients = inbox.notify_email.split(',').map((e: string) => e.trim()).filter(Boolean);

        for (const to of recipients) {
          c.executionCtx.waitUntil(
            c.env.EMAIL_QUEUE.send({
              to,
              subject: `${prefix} ${subjectDetail}`,
              body: htmlBody,
              sender_name: inbox.sender_name ?? undefined,
              inbox_id: inbox.id,
            }),
          );
        }
      }
    }
  }

  return c.json({ status: 'received', event_id: eventId });
});

publicWebhooks.get('/demo/events', async (c) => {
  const inbox = await c.env.DB.prepare(
    'SELECT id FROM webhook_inboxes WHERE slug = ? AND is_active = 1',
  )
    .bind('demo')
    .first<{ id: string }>();

  if (!inbox) {
    return c.json({ data: [] });
  }

  // Only the event the visitor just sent, by id. Listing recent events would show other visitors' data.
  const eventId = c.req.query('id');
  if (!eventId) {
    return c.json({ error: { code: 400, message: 'id is required' } }, 400);
  }

  const event = await c.env.DB.prepare(
    'SELECT id, method, body, received_at FROM webhook_events WHERE id = ? AND inbox_id = ?',
  )
    .bind(eventId, inbox.id)
    .first<Record<string, unknown>>();

  if (!event) {
    return c.json({ data: [] });
  }

  return c.json({
    data: [
      {
        id: event.id,
        method: event.method,
        body: event.body ? JSON.parse(event.body as string) : null,
        received_at: event.received_at,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Authenticated: manage inboxes
// ---------------------------------------------------------------------------

webhooks.get('/inboxes', requireScope('webhooks'), async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const total = await c.env.DB.prepare('SELECT COUNT(*) as count FROM webhook_inboxes').first<{
    count: number;
  }>();

  const results = await c.env.DB.prepare(
    'SELECT * FROM webhook_inboxes ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(limit, offset)
    .all<Inbox>();

  const items = (results.results || []).map((i) => ({
    ...i,
    has_turnstile: !!i.turnstile_secret,
    turnstile_secret: undefined,
  }));

  return c.json({ data: items, meta: { total: total?.count || 0, limit, offset } });
});

webhooks.post('/inboxes', requireScope('webhooks'), async (c) => {
  const body = await c.req.json<{
    slug: string;
    description?: string;
    forward_url?: string;
    notify_email?: string;
    email_subject_prefix?: string;
    sender_name?: string;
    turnstile_secret?: string;
  }>();

  if (!body.slug) {
    return c.json({ error: { code: 400, message: 'slug is required' } }, 400);
  }

  const forwardErr = forwardUrlError(body.forward_url);
  if (forwardErr) {
    return c.json({ error: { code: 400, message: forwardErr } }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO webhook_inboxes (id, slug, description, forward_url, notify_email, email_subject_prefix, sender_name, turnstile_secret)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.slug,
      body.description || null,
      body.forward_url || null,
      body.notify_email || null,
      body.email_subject_prefix || null,
      body.sender_name || null,
      body.turnstile_secret || null,
    )
    .run();

  const inbox = await c.env.DB.prepare('SELECT * FROM webhook_inboxes WHERE id = ?')
    .bind(id)
    .first<Inbox>();

  return c.json(
    {
      data: {
        ...inbox,
        has_turnstile: !!inbox?.turnstile_secret,
        turnstile_secret: undefined,
      },
    },
    201,
  );
});

webhooks.patch('/inboxes/:slug', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Record<string, unknown>>();

  const inbox = await c.env.DB.prepare('SELECT * FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<Inbox>();

  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  if ('forward_url' in body) {
    const forwardErr = forwardUrlError(body.forward_url);
    if (forwardErr) {
      return c.json({ error: { code: 400, message: forwardErr } }, 400);
    }
  }

  const allowed = [
    'description',
    'forward_url',
    'notify_email',
    'email_subject_prefix',
    'sender_name',
    'turnstile_secret',
    'is_active',
  ];
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of allowed) {
    if (field in body) {
      updates.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
  }

  if (updates.length > 0) {
    values.push(slug);
    await c.env.DB.prepare(
      `UPDATE webhook_inboxes SET ${updates.join(', ')} WHERE slug = ?`,
    )
      .bind(...values)
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<Inbox>();

  return c.json({
    data: {
      ...updated,
      has_turnstile: !!updated?.turnstile_secret,
      turnstile_secret: undefined,
    },
  });
});

webhooks.delete('/inboxes/:slug', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();

  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  await c.env.DB.prepare('DELETE FROM webhook_inboxes WHERE slug = ?').bind(slug).run();
  return c.body(null, 204);
});

webhooks.get('/:slug/events', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();

  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM webhook_events WHERE inbox_id = ?',
  )
    .bind(inbox.id)
    .first<{ count: number }>();

  const results = await c.env.DB.prepare(
    'SELECT * FROM webhook_events WHERE inbox_id = ? ORDER BY received_at DESC LIMIT ? OFFSET ?',
  )
    .bind(inbox.id, limit, offset)
    .all();

  const items = (results.results || []).map((e: Record<string, unknown>) => ({
    ...e,
    headers: JSON.parse(e.headers as string),
    body: e.body ? JSON.parse(e.body as string) : null,
    query_params: JSON.parse(e.query_params as string),
  }));

  return c.json({ data: items, meta: { total: total?.count || 0, limit, offset } });
});

webhooks.get('/:slug/events/:eventId', requireScope('webhooks'), async (c) => {
  const slug = c.req.param('slug');
  const eventId = c.req.param('eventId');

  const inbox = await c.env.DB.prepare('SELECT id FROM webhook_inboxes WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();

  if (!inbox) {
    return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
  }

  const event = await c.env.DB.prepare(
    'SELECT * FROM webhook_events WHERE id = ? AND inbox_id = ?',
  )
    .bind(eventId, inbox.id)
    .first<Record<string, unknown>>();

  if (!event) {
    return c.json({ error: { code: 404, message: 'Event not found' } }, 404);
  }

  return c.json({
    data: {
      ...event,
      headers: JSON.parse(event.headers as string),
      body: event.body ? JSON.parse(event.body as string) : null,
      query_params: JSON.parse(event.query_params as string),
    },
  });
});

export { webhooks, publicWebhooks };
