export interface AssistantContentBlock {
  type?: string;
  text?: string;
}

export interface AssistantMessagePayload {
  content?: string | AssistantContentBlock[];
}

const CONTROL_OR_FORMAT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/gu;
const VISIBLE_TEXT_CHARS = /[^\s]/u;

export function normalizeAssistantText(text: string): string | null {
  const normalized = text.replace(CONTROL_OR_FORMAT_CHARS, '').trim();
  if (!normalized || !VISIBLE_TEXT_CHARS.test(normalized)) {
    return null;
  }
  return normalized;
}

export function extractAssistantText(message: {
  message?: AssistantMessagePayload;
}): string | null {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return normalizeAssistantText(content);
  }
  if (!Array.isArray(content)) return null;

  const hasNonTextBlocks = content.some(
    (block) => block && block.type && block.type !== 'text',
  );
  if (hasNonTextBlocks) return null;

  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => normalizeAssistantText(block.text!))
    .filter((block): block is string => Boolean(block))
    .join('\n')
    .trim();

  if (!text || isPlaceholderResult(text)) return null;
  return text;
}

export function isPlaceholderResult(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return /^\([^)]+\)$/.test(trimmed);
}
