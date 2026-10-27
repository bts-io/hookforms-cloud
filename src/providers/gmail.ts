import type { EmailProvider } from './base';
import type { GmailProviderConfig } from '../types';
import { encodeHeaderWord, formatMailbox, sanitizeAddress } from './headers';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Module-level access token cache.
 * Shared across all GmailProvider instances within the same worker invocation.
 * Access tokens last ~3600s; we cache with a 5-minute safety margin.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Gmail email provider using OAuth2 refresh token flow.
 * Works with both stored config (from email_providers table) and
 * environment secrets (legacy fallback).
 *
 * Caches access tokens in memory to avoid hammering Google's OAuth endpoint
 * on every email send (which can trigger token revocation).
 */
export class GmailProvider implements EmailProvider {
  readonly type = 'gmail';

  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private senderEmail: string;

  constructor(config: GmailProviderConfig) {
    this.clientId = config.client_id;
    this.clientSecret = config.client_secret;
    this.refreshToken = config.refresh_token;
    this.senderEmail = config.sender_email;
  }

  /**
   * Create a GmailProvider from environment secrets (legacy path).
   * Returns null if Gmail is not configured in env.
   */
  static fromEnv(env: {
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REFRESH_TOKEN?: string;
    GMAIL_SENDER_EMAIL?: string;
  }): GmailProvider | null {
    if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
      return null;
    }
    return new GmailProvider({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      sender_email: env.GMAIL_SENDER_EMAIL || 'noreply@example.com',
    });
  }

  /** Cache key based on client_id + refresh_token prefix (unique per credential set) */
  private get cacheKey(): string {
    return `${this.clientId}:${this.refreshToken.slice(0, 16)}`;
  }

  private async getAccessToken(): Promise<string> {
    // Check cache first
    const cached = tokenCache.get(this.cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gmail token refresh failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as TokenResponse;

    // Cache with 5-minute safety margin (tokens typically last 3600s)
    const expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    tokenCache.set(this.cacheKey, { token: data.access_token, expiresAt });

    return data.access_token;
  }

  async sendEmail(
    to: string,
    subject: string,
    htmlBody: string,
    senderName?: string,
  ): Promise<void> {
    const accessToken = await this.getAccessToken();
    const displayName = senderName || 'HookForms';

    // Build RFC 2822 message. Every header value goes through the shared sanitizer so submitted
    // text cannot add headers, and non-ASCII values are RFC 2047 encoded.
    const message = [
      `From: ${formatMailbox(displayName, this.senderEmail)}`,
      `To: ${sanitizeAddress(to)}`,
      `Subject: ${encodeHeaderWord(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
    ].join('\r\n');

    // Base64url encode
    const raw = btoa(unescape(encodeURIComponent(message)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const resp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gmail send failed: ${resp.status} ${text}`);
    }
  }
}
