import { formatValue } from './format-value';
import { rawOnlyText } from '../channels/raw';

/**
 * Build the HTML email body from form fields.
 */
export function buildEmailHtml(
  slug: string,
  body: Record<string, unknown>,
  senderName?: string,
): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const skipKeys = new Set(['source', 'cf-turnstile-response']);
  let fieldRows = '';

  // A body that was not a form or JSON object is shown as the submitted text.
  const raw = rawOnlyText(body);
  if (raw !== null) {
    fieldRows = `<tr>
      <td style="padding:10px 14px;color:#222;"><pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:Menlo,Consolas,monospace;font-size:13px;">${escape(raw)}</pre></td>
    </tr>`;
  }

  for (const [key, val] of raw !== null ? [] : Object.entries(body)) {
    if (skipKeys.has(key) || !val) continue;
    const label = escape(key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
    const value = escape(formatValue(val));
    fieldRows += `<tr>
      <td style="padding:10px 14px;font-weight:600;color:#555;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eee;">${label}</td>
      <td style="padding:10px 14px;color:#222;border-bottom:1px solid #eee;">${value}</td>
    </tr>`;
  }

  const name = escape(String(body.name || 'Unknown'));
  const email = String(body.email || '');
  const emailEscaped = escape(email);
  const subjectDetail = name !== 'Unknown' ? `from ${name}` : 'New Submission';
  const footerName = escape(senderName || 'HookForms');
  const slugEscaped = escape(slug);

  const replyButton = email
    ? `<tr><td style="padding:0 32px 24px;"><a href="mailto:${emailEscaped}" style="display:inline-block;padding:10px 20px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:5px;font-size:14px;">Reply to ${escape(name)}</a></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#1a1a2e;padding:24px 32px;">
            <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${subjectDetail}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px;">
            <p style="margin:0 0 16px;color:#666;font-size:14px;">A new form submission was received:</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;">
              ${fieldRows}
            </table>
          </td>
        </tr>
        ${replyButton}
        <tr>
          <td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;">
            <p style="margin:0;color:#999;font-size:12px;">Delivered by ${footerName} &middot; <code style="background:#eee;padding:2px 6px;border-radius:3px;font-size:11px;">/hooks/${slugEscaped}</code></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
