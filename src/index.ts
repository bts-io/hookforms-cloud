import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, EmailJob } from './types';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { webhooks, publicWebhooks } from './routes/webhooks';
import { auth } from './routes/auth';
import { channels } from './routes/channels';
import { resolveEmailProvider, resolveEmailProviderWithSource, GmailProvider } from './providers';
import { requireScope } from './middleware/auth';
import { buildEmail } from './services/email-template';

const app = new Hono<{ Bindings: Env }>();

// Delays between email send attempts: 30 s, 2 min, then 10 min for any later attempt.
const RETRY_DELAYS_SECONDS = [30, 120, 600];

export function retryDelaySeconds(attempts: number): number {
  return RETRY_DELAYS_SECONDS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_SECONDS.length) - 1];
}

// CORS
app.use('*', cors());

// Rate limiting + security headers
app.use('*', rateLimitMiddleware);

// Root
app.get('/', (c) =>
  c.json({ name: 'HookForms', status: 'ok', version: '0.1.0' }),
);

// Health check
app.get('/health', async (c) => {
  let dbStatus = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    dbStatus = 'unavailable';
  }

  return c.json({
    status: dbStatus === 'ok' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    checks: { d1: dbStatus },
  });
});

// ---------------------------------------------------------------------------
// Admin diagnostic: test Gmail OAuth + send test email
// ---------------------------------------------------------------------------
app.get('/v1/diag/gmail', requireScope('admin'), async (c) => {
  const checks: Record<string, unknown> = {
    has_client_id: !!c.env.GMAIL_CLIENT_ID,
    has_client_secret: !!c.env.GMAIL_CLIENT_SECRET,
    has_refresh_token: !!c.env.GMAIL_REFRESH_TOKEN,
    has_sender_email: !!c.env.GMAIL_SENDER_EMAIL,
    sender_email: c.env.GMAIL_SENDER_EMAIL || null,
  };

  if (c.env.GMAIL_CLIENT_ID && c.env.GMAIL_CLIENT_SECRET && c.env.GMAIL_REFRESH_TOKEN) {
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.env.GMAIL_CLIENT_ID,
          client_secret: c.env.GMAIL_CLIENT_SECRET,
          refresh_token: c.env.GMAIL_REFRESH_TOKEN,
          grant_type: 'refresh_token',
        }),
      });
      const text = await resp.text();
      checks.token_refresh_status = resp.status;
      if (resp.ok) {
        const data = JSON.parse(text);
        checks.token_refresh = 'success';
        checks.token_type = data.token_type;
        checks.expires_in = data.expires_in;
      } else {
        checks.token_refresh = 'failed';
        checks.token_refresh_error = text;
      }
    } catch (err) {
      checks.token_refresh = 'error';
      checks.token_refresh_error = String(err);
    }
  } else {
    checks.token_refresh = 'skipped - missing credentials';
  }

  return c.json({ data: checks });
});

// Sends one email through the same provider a real notification would use: the inbox's own
// provider when ?inbox= is given, else the global provider, else env Gmail.
app.post('/v1/diag/test-email', requireScope('admin'), async (c) => {
  const body = await c.req.json<{ to?: string }>();
  const to = body.to || c.env.GMAIL_SENDER_EMAIL || '';

  if (!to) {
    return c.json({ error: { code: 400, message: 'No recipient - provide "to" or set GMAIL_SENDER_EMAIL' } }, 400);
  }

  const inboxSlug = c.req.query('inbox');
  let inbox: { id: string; sender_name: string | null } | null = null;
  if (inboxSlug) {
    inbox = await c.env.DB.prepare('SELECT id, sender_name FROM webhook_inboxes WHERE slug = ?')
      .bind(inboxSlug)
      .first<{ id: string; sender_name: string | null }>();
    if (!inbox) {
      return c.json({ error: { code: 404, message: 'Inbox not found' } }, 404);
    }
  }

  let providerInfo: { source: string; type: string } | undefined;
  try {
    const resolved = await resolveEmailProviderWithSource(c.env, inbox?.id ?? null);
    if (!resolved) {
      return c.json({ error: { code: 500, message: 'No email provider configured' } }, 500);
    }
    providerInfo = { source: resolved.source, type: resolved.provider.type };
    const senderName = inbox?.sender_name || undefined;

    const mail = buildEmail(
      inboxSlug || 'diag-test',
      {
        name: 'Diagnostic Test',
        email: 'diag@hookforms.dev',
        message: `This is a test email sent at ${new Date().toISOString()} through the ${resolved.source} ${resolved.provider.type} provider.`,
      },
      '[HookForms Diag] Test Email',
    );

    await resolved.provider.sendEmail(to, mail.subject, { html: mail.html, text: mail.text }, senderName);

    return c.json({ data: { status: 'sent', to, provider: providerInfo } });
  } catch (err) {
    return c.json({
      error: {
        code: 500,
        message: 'Email send failed',
        detail: String(err),
        provider: providerInfo ?? null,
      },
    }, 500);
  }
});

// Public webhook receiver (no auth)
app.route('/', publicWebhooks);

// Authenticated routes
app.route('/v1/hooks', webhooks);
app.route('/v1/hooks', channels);  // /v1/hooks/inboxes/:slug/channels
app.route('/v1', channels);        // /v1/config/email-provider
app.route('/v1/auth', auth);

// 404
app.notFound((c) =>
  c.json({ error: { code: 404, message: 'Not found' } }, 404),
);

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: { code: 500, message: 'Internal server error' } }, 500);
});

export default {
  fetch: app.fetch,

  // Queue consumer: send emails via resolved provider. Jobs that run out of retries land in the
  // dead-letter queue, whose consumer only logs them.
  async queue(batch: MessageBatch<EmailJob>, env: Env): Promise<void> {
    if (batch.queue.endsWith('-dlq')) {
      for (const msg of batch.messages) {
        // Ids and counts only: never the recipient, subject or body.
        console.log(
          `Email job dead-lettered: message=${msg.id} inbox=${msg.body?.inbox_id || 'env'} attempts=${msg.attempts}`,
        );
        msg.ack();
      }
      return;
    }

    // Cache providers per inbox to avoid repeated DB lookups within a batch
    const providerCache = new Map<string, Awaited<ReturnType<typeof resolveEmailProvider>>>();

    for (const msg of batch.messages) {
      try {
        const job = msg.body;

        // Resolve provider: inbox-specific -> global -> env Gmail
        const cacheKey = job.inbox_id || '__env__';
        let provider = providerCache.get(cacheKey);
        if (provider === undefined) {
          provider = job.inbox_id
            ? await resolveEmailProvider(env, job.inbox_id)
            : GmailProvider.fromEnv(env);
          providerCache.set(cacheKey, provider);
        }

        if (!provider) {
          console.error(`No email provider available for inbox ${job.inbox_id || 'env'}`);
          msg.ack(); // Don't retry if no provider configured
          continue;
        }

        await provider.sendEmail(job.to, job.subject, { html: job.body, text: job.text }, job.sender_name);
        msg.ack();
      } catch (err) {
        console.error('Email send failed:', err);
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      }
    }
  },

  // Scheduled: cleanup old events (daily at 3am UTC)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // received_at is datetime('now') text ("YYYY-MM-DD HH:MM:SS"), so the cutoff is computed
    // in SQL in the same format. An ISO string ("...T...Z") compares wrong within the cutoff day.
    try {
      const result = await env.DB.prepare(
        "DELETE FROM webhook_events WHERE received_at < datetime('now', '-30 days')",
      ).run();

      console.log(`Cleaned up ${result.meta.changes} old webhook events`);
    } catch (err) {
      console.error('Event cleanup failed:', err);
    }
  },
};
