import { rawOnlyText } from '../channels/raw';
import { formatValue } from './format-value';

/**
 * The notification email HookForms sends for a submission: a designed HTML part (table layout,
 * one 600px column, inline styles, light only, system fonts) and a plain-text twin, both built
 * from the same rows so they never drift apart.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";
const CANVAS = '#f4f5f7';
const PAPER = '#ffffff';
const INK = '#1a1a2e';
const BODY = '#333333';
const MUTED = '#666666';
const RULE = '#e5e7eb';
const TINT = '#f6f7f9';
const GOLD = '#d4a843';

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PREHEADER_FILL = '&#847;&zwnj;&nbsp;'.repeat(30);

/**
 * Build the notification email for a submission. `subject` carries the inbox's own prefix and
 * becomes the document title; `senderName` is the inbox's sender name.
 */
export function buildEmail(
  slug: string,
  body: Record<string, unknown>,
  subject: string,
  senderName?: string,
): RenderedEmail {
  const skipKeys = new Set(['source', 'cf-turnstile-response']);
  const raw = rawOnlyText(body);
  const rows =
    raw !== null
      ? []
      : Object.entries(body)
          .filter(([key, val]) => !skipKeys.has(key) && val)
          .map(([key, val]) => ({
            label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            value: formatValue(val),
          }));

  const name = String(body.name || 'Unknown');
  const email = String(body.email || '');
  const headline = name !== 'Unknown' ? `New submission from ${name}` : 'New submission';
  const preheader = name !== 'Unknown' ? `New submission from ${name}.` : 'A new submission arrived.';
  const intro = raw !== null ? 'A new submission was received:' : 'A new form submission was received:';
  const reason = `You get this email because the inbox /hooks/${slug} sends its submissions here.`;
  const sentBy = `Delivered by ${senderName || 'HookForms'}.`;

  let content: string;
  if (raw !== null) {
    content = `<pre style="margin:0 0 20px;padding:12px 14px;font-family:${MONO};font-size:13px;line-height:1.5;color:${INK};background-color:${TINT};border:1px solid ${RULE};white-space:pre-wrap;word-break:break-word;">${escape(raw)}</pre>`;
  } else if (rows.length) {
    const cells = rows
      .map((row, i) => {
        const border = i < rows.length - 1 ? `border-bottom:1px solid ${RULE};` : '';
        return `<tr><td width="35%" valign="top" style="padding:10px 14px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};${border}">${escape(row.label)}</td><td valign="top" style="padding:10px 14px;font-family:${FONT};font-size:15px;line-height:1.5;font-weight:600;color:${INK};word-break:break-word;${border}">${escape(row.value).replace(/\r?\n/g, '<br>')}</td></tr>`;
      })
      .join('');
    content = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;margin:0 0 20px;border:1px solid ${RULE};">${cells}</table>`;
  } else {
    content = `<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${MUTED};">The submission had no fields.</p>`;
  }

  const button = email
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px;"><tr><td bgcolor="${INK}" style="border-radius:6px;background-color:${INK};"><a href="mailto:${escape(email)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:bold;line-height:1.2;color:#ffffff;background-color:${INK};border-radius:6px;text-decoration:none;">Reply to ${escape(name)}</a></td></tr></table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escape(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
body{margin:0;padding:0;background-color:${CANVAS};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;}
@media only screen and (max-width:620px){
.container{width:100% !important;}
.pad{padding-left:20px !important;padding-right:20px !important;}
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${CANVAS};" bgcolor="${CANVAS}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(preheader)}${PREHEADER_FILL}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;background-color:${CANVAS};" bgcolor="${CANVAS}">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellspacing="0" cellpadding="0" border="0" class="container" width="600" align="center" style="width:600px;max-width:600px;background-color:${PAPER};" bgcolor="${PAPER}">
<tr><td class="pad" bgcolor="${INK}" style="padding:20px 32px;background-color:${INK};font-family:${FONT};font-size:20px;line-height:1.2;font-weight:800;color:#ffffff;">HookForms</td></tr>
<tr><td style="height:4px;font-size:0;line-height:0;background-color:${GOLD};" bgcolor="${GOLD}">&nbsp;</td></tr>
<tr><td class="pad" style="padding:28px 32px 0;">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:26px;line-height:1.25;font-weight:800;color:${INK};">${escape(headline)}</h1>
</td></tr>
<tr><td class="pad" style="padding:0 32px 12px;">
<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${BODY};">${escape(intro)}</p>
${content}
${button}
</td></tr>
<tr><td class="pad" style="padding:20px 32px 28px;border-top:1px solid ${RULE};">
<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${escape(reason)}</p>
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${escape(sentBy)}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;

  const parts = [headline, intro];
  if (raw !== null) parts.push(raw);
  else if (rows.length) parts.push(rows.map((r) => `${r.label}: ${r.value}`).join('\n'));
  else parts.push('The submission had no fields.');
  if (email) parts.push(`Reply to ${name}: mailto:${email}`);
  const text = `${parts.join('\n\n')}\n\n--\n${reason}\n${sentBy}\n`;

  return { subject, html, text };
}
