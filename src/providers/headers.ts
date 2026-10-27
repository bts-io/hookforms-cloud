/**
 * Header value hygiene shared by every email provider.
 *
 * Subjects and sender names are built from submitted form fields, so they must never carry
 * CR/LF (which would start a new header in a raw message) or other control characters.
 */

/** C0 controls, DEL and C1 controls, plus Unicode line and paragraph separators. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** Replace control characters (CR, LF, tab, NUL...) with a single space and trim. */
export function sanitizeHeaderValue(value: string): string {
  let out = '';
  for (const ch of String(value ?? '')) {
    out += isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** An address has no spaces or control characters at all; anything after them is dropped. */
export function sanitizeAddress(value: string): string {
  return sanitizeHeaderValue(value).split(/\s/)[0] ?? '';
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * RFC 2047 "B" encoding for a header value that is not plain ASCII. Encoded words stay under the
 * 75 character limit and never split a character; they are joined by folding whitespace.
 */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (isPrintableAscii(clean)) return clean;

  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    // 45 bytes of UTF-8 encode to 60 base64 characters, plus 12 for "=?UTF-8?B?" and "?=".
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
  return words.join('\r\n ');
}

/** `Display Name <email>` for a raw message: the name is encoded or quoted as needed. */
export function formatMailbox(name: string, email: string): string {
  const cleanName = sanitizeHeaderValue(name);
  const cleanEmail = sanitizeAddress(email);
  if (!cleanName) return cleanEmail;
  if (!isPrintableAscii(cleanName)) return `${encodeHeaderWord(cleanName)} <${cleanEmail}>`;
  if (/[()<>[\]:;@\\,."]/.test(cleanName)) {
    return `"${cleanName.replace(/(["\\])/g, '\\$1')}" <${cleanEmail}>`;
  }
  return `${cleanName} <${cleanEmail}>`;
}
