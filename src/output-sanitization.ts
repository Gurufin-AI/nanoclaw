const INTERNAL_BLOCKS = /<internal>[\s\S]*?<\/internal>/g;
const DISALLOWED_CONTROL_OR_FORMAT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/gu;
const VISIBLE_TEXT_CHARS = /[^\s]/u;

export function sanitizeOutboundText(text: string): string | null {
  const sanitized = text
    .replace(INTERNAL_BLOCKS, '')
    .replace(DISALLOWED_CONTROL_OR_FORMAT_CHARS, '')
    .trim();

  if (!sanitized || !VISIBLE_TEXT_CHARS.test(sanitized)) {
    return null;
  }

  return sanitized;
}
