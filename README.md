<p align="center">
  <img src="logo.png" alt="HookForms Cloud" width="340">
</p>

<p align="center">
  <strong>One-click deployable webhook inbox with multi-channel notifications.</strong><br>
  Runs entirely on Cloudflare Workers. Send form submissions to Discord, Slack, Teams, Telegram, email, and more.
</p>

<p align="center">
  <a href="https://hookforms-docs.h1n054ur.dev">Docs</a> &middot;
  <a href="https://github.com/bts-io/hookforms">Self-Hosted Version</a> &middot;
  <a href="https://hookforms-docs.h1n054ur.dev/getting-started/cloudflare-workers/">Quick Start Guide</a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/bts-io/hookforms-cloud">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare">
  </a>
</p>

---

```
HTML Form  -->  POST /hooks/your-inbox  -->  Discord, Slack, Email, Telegram, ...
```

> This is the Cloudflare-native version of [hookforms](https://github.com/bts-io/hookforms) (the self-hosted Docker Compose version). Same API surface, same features, zero infrastructure to manage.

## Features

- **Multi-channel notifications** -- route submissions to Discord, Slack, Microsoft Teams, Telegram, ntfy, email, or any webhook URL
- **Auto-detection** -- paste a URL and HookForms detects the channel type automatically
- **Multiple email providers** -- Gmail (OAuth), Resend, SendGrid -- configure globally or per-inbox
- **Queue-based email** -- email delivery is decoupled from the request path via Cloudflare Queues
- **Turnstile bot protection** -- optional Cloudflare Turnstile verification per inbox
- **Security hardened** -- SSRF blocklist, secret redaction in API responses, scoped API keys
- **Rate limiting** -- KV-backed per-IP rate limiting
- **Event history** -- stored events with configurable retention
- **One-click deploy** -- fork, deploy, done
- **Backward compatible** -- legacy `notify_email` and `forward_url` still work

## Architecture

| Component | Cloudflare Service | Purpose |
|---|---|---|
| API | Workers (Hono) | HTTP handling, routing, notification dispatch |
| Database | D1 | Inboxes, events, channels, email providers, API keys |
| Rate Limiting | KV | Per-IP request counters |
| Email Queue | Queues | Async email delivery |

```
HTML Form --> Cloudflare Worker (Hono) --> D1 (database)
                    |
                    +--> KV (rate limiting)
                    |
                    +--> Channel Dispatcher
                            |
                            +--> Discord / Slack / Teams / Telegram / ntfy
                            +--> Generic Webhooks
                            +--> Queue --> Email Provider (Gmail / Resend / SendGrid)
```

## Quick Start

### One-Click Deploy

Click the deploy button above. After the deploy completes:

```bash
# Set your admin API key
bunx wrangler secret put ADMIN_API_KEY

# Run database migrations
bunx wrangler d1 execute hookforms-db --remote --file=migrations/0001_init.sql
bunx wrangler d1 execute hookforms-db --remote --file=migrations/0002_notification_channels.sql
```

### Manual CLI Setup

```bash
git clone https://github.com/bts-io/hookforms-cloud.git
cd hookforms-cloud
bun install

# Create resources
bunx wrangler d1 create hookforms-db
bunx wrangler kv namespace create RATE_LIMIT
# Paste the IDs into wrangler.jsonc

# Set admin key
bunx wrangler secret put ADMIN_API_KEY

# Deploy
bunx wrangler deploy

# Run migrations
bunx wrangler d1 execute hookforms-db --remote --file=migrations/0001_init.sql
bunx wrangler d1 execute hookforms-db --remote --file=migrations/0002_notification_channels.sql
```

## Usage

### 1. Create an inbox

```bash
curl -X POST https://YOUR_WORKER_URL/v1/hooks/inboxes \
  -H "X-API-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "contact-form",
    "description": "Website contact form"
  }'
```

### 2. Add notification channels

```bash
# Send to Discord (auto-detected from URL)
curl -X POST https://YOUR_WORKER_URL/v1/hooks/inboxes/contact-form/channels \
  -H "X-API-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "webhook", "config": {"url": "https://discord.com/api/webhooks/123/abc"}}'

# Send to Slack
curl -X POST https://YOUR_WORKER_URL/v1/hooks/inboxes/contact-form/channels \
  -H "X-API-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "webhook", "config": {"url": "https://hooks.slack.com/services/T00/B00/xxx"}}'

# Send email via configured provider
curl -X POST https://YOUR_WORKER_URL/v1/hooks/inboxes/contact-form/channels \
  -H "X-API-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "email", "config": {"recipients": ["team@example.com"]}}'
```

### 3. Point your form at it

```html
<form action="https://YOUR_WORKER_URL/hooks/contact-form" method="POST">
  <input type="text" name="name" placeholder="Name" required>
  <input type="email" name="email" placeholder="Email" required>
  <textarea name="message" placeholder="Message" required></textarea>
  <button type="submit">Send</button>
</form>
```

Submissions are delivered to all configured channels with rich formatting (Discord embeds, Slack blocks, HTML emails, etc.).

## Notification Channels

| Channel | Auto-detected from |
|---------|-------------------|
| Discord | `discord.com/api/webhooks/` |
| Slack | `hooks.slack.com/services/` |
| Microsoft Teams | `*.webhook.office.com/` |
| Telegram | `api.telegram.org/bot` |
| ntfy | `ntfy.sh/` |
| Webhook | Any other URL |
| Email | Set `type: "email"` with config |

## Email Providers

Configure a global provider or override per-inbox:

```bash
curl -X PUT https://YOUR_WORKER_URL/v1/hooks/config/email-provider \
  -H "X-API-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "resend", "config": {"api_key": "re_...", "from_email": "noreply@yourdomain.com"}}'
```

Supported: **Gmail** (OAuth), **Resend**, **SendGrid**.

Provider resolution: inbox-specific > global > env-based Gmail.

### Gmail Setup

```bash
bunx wrangler secret put GMAIL_CLIENT_ID
bunx wrangler secret put GMAIL_CLIENT_SECRET
bunx wrangler secret put GMAIL_REFRESH_TOKEN
bunx wrangler secret put GMAIL_SENDER_EMAIL
```

Use the `gmail_auth.py` script from the [self-hosted repo](https://github.com/bts-io/hookforms) to obtain your OAuth credentials.

## Security

- **SSRF blocklist** -- blocks private IPs, localhost, link-local addresses, and cloud metadata endpoints on all outbound channel requests.
- **Secret redaction** -- channel configs and provider credentials are masked in API read responses.
- **Scoped API keys** -- fine-grained access control with `webhooks` and `admin` scopes.
- **Rate limiting** -- KV-backed per-IP fixed window (100 req per minute).
- **Email rate limiting** -- email goes out for at most 10 submissions per inbox per 10-minute window, channels and notify_email alike.

## API Reference

Full documentation at [hookforms-docs.h1n054ur.dev](https://hookforms-docs.h1n054ur.dev).

### Public (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `ANY` | `/hooks/{slug}` | Receive a webhook event |
| `GET` | `/health` | Health check |

### Authenticated (`X-API-Key` header)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/hooks/inboxes` | Create inbox |
| `GET` | `/v1/hooks/inboxes` | List inboxes |
| `PATCH` | `/v1/hooks/inboxes/{slug}` | Update inbox |
| `DELETE` | `/v1/hooks/inboxes/{slug}` | Delete inbox + events |
| `GET` | `/v1/hooks/{slug}/events` | List events |
| `POST` | `/v1/hooks/inboxes/{slug}/channels` | Add notification channel |
| `GET` | `/v1/hooks/inboxes/{slug}/channels` | List channels |
| `PATCH` | `/v1/hooks/inboxes/{slug}/channels/{id}` | Update channel |
| `DELETE` | `/v1/hooks/inboxes/{slug}/channels/{id}` | Remove channel |
| `PUT` | `/v1/hooks/config/email-provider` | Set email provider |
| `GET` | `/v1/hooks/config/email-provider` | Get email provider config |
| `DELETE` | `/v1/hooks/config/email-provider` | Remove email provider |
| `POST` | `/v1/auth/keys` | Create API key (admin) |
| `GET` | `/v1/auth/keys` | List API keys (admin) |
| `DELETE` | `/v1/auth/keys/{id}` | Revoke API key (admin) |

## Cost

| Plan | Request limit | Price |
|------|--------------|-------|
| **Free** | 100,000 requests/day | $0 |
| **Paid** | 10,000,000 requests/month | $5/month |

A typical form backend will comfortably stay within the free tier.

## License

[MIT](LICENSE)
