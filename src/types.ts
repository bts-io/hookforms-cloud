export interface Env {
  DB: D1Database;
  RATE_LIMIT: KVNamespace;
  STORAGE: R2Bucket;
  EMAIL_QUEUE: Queue;
  ADMIN_API_KEY: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_SENDER_EMAIL?: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  is_active: number;
  last_used_at: string | null;
  created_at: string;
}

export interface Inbox {
  id: string;
  slug: string;
  description: string | null;
  forward_url: string | null;
  notify_email: string | null;
  email_subject_prefix: string | null;
  sender_name: string | null;
  turnstile_secret: string | null;
  is_active: number;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  inbox_id: string;
  method: string;
  headers: string;
  body: string | null;
  query_params: string;
  source_ip: string | null;
  received_at: string;
}

export interface EmailJob {
  to: string;
  subject: string;
  /** Designed HTML part. */
  body: string;
  /** Plain-text twin, built from the same rows. */
  text: string;
  sender_name?: string;
  /** Inbox ID for provider resolution. If absent, falls back to env Gmail. */
  inbox_id?: string;
}

export type ChannelType = 'email' | 'discord' | 'slack' | 'teams' | 'telegram' | 'ntfy' | 'webhook';

export interface NotificationChannel {
  id: string;
  inbox_id: string;
  type: ChannelType;
  label: string | null;
  config: string; // JSON string in D1
  is_active: number;
  created_at: string;
}

export type EmailProviderType = 'gmail' | 'resend' | 'sendgrid' | 'smtp';

export interface EmailProviderRecord {
  id: string;
  inbox_id: string | null; // null = global default
  type: EmailProviderType;
  config: string; // JSON string in D1
  is_active: number;
  created_at: string;
}

// Parsed config shapes for each channel type. New rows are saved with the key the sender reads
// (see normalizeChannelConfig); `url` / `webhook_url` cover rows saved before that.
export interface DiscordChannelConfig {
  webhook_url: string;
  url?: string;
}

export interface SlackChannelConfig {
  webhook_url: string;
  url?: string;
}

export interface TeamsChannelConfig {
  webhook_url: string;
  url?: string;
}

export interface TelegramChannelConfig {
  bot_url: string; // https://api.telegram.org/bot<TOKEN>/sendMessage
  chat_id: string;
}

export interface NtfyChannelConfig {
  url: string; // https://ntfy.sh/<topic> or self-hosted
  priority?: number;
}

export interface WebhookChannelConfig {
  url: string;
  webhook_url?: string;
  custom_headers?: Record<string, string>;
}

export interface EmailChannelConfig {
  recipients: string[];
}

// Email provider config shapes
export interface GmailProviderConfig {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  sender_email: string;
  // Display name for the From header when the inbox sets none.
  from_name?: string;
}

export interface ResendProviderConfig {
  api_key: string;
  from_email: string;
  // Display name for the From header when the inbox sets none.
  from_name?: string;
}

export interface SendGridProviderConfig {
  api_key: string;
  from_email: string;
  // Display name for the From header when the inbox sets none.
  from_name?: string;
}

export interface SmtpProviderConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  use_tls: boolean;
  from_email: string;
}
