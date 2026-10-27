/** The two parts of every email: the designed HTML and its plain-text twin. */
export interface EmailBody {
  html: string;
  text: string;
}

/** Optional per-message settings every provider honours. */
export interface SendOptions {
  /** Address replies should go to (the Reply-To header), e.g. a form submitter. */
  replyTo?: string;
  /** Display name for the Reply-To address. */
  replyToName?: string;
}

/**
 * Common interface for all email providers.
 * Each provider implements sendEmail() using its own API/protocol and always sends both parts
 * of the body (multipart/alternative, or the provider's own html and text fields).
 */
export interface EmailProvider {
  readonly type: string;
  sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    senderName?: string,
    options?: SendOptions,
  ): Promise<void>;
}

/**
 * Options passed when constructing a provider from stored config.
 */
export interface ProviderConfig {
  [key: string]: unknown;
}
