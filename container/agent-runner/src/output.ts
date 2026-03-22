export interface AssistantContentBlock {
  type?: string;
  text?: string;
}

export interface AssistantMessagePayload {
  content?: string | AssistantContentBlock[];
  stop_reason?: string | null;
}

export interface SDKResultPayload {
  subtype?: string;
  result?: string | null;
  errors?: string[];
  is_error?: boolean;
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

  // Thinking blocks are OpenRouter/nemotron protocol artifacts — they arrive
  // as `thinking` (plaintext) and/or `redacted_thinking` (Base64-wrapped)
  // blocks alongside the actual text. Skip both instead of bailing out.
  const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

  const hasOtherNonTextBlocks = content.some(
    (block) =>
      block &&
      block.type &&
      block.type !== 'text' &&
      !THINKING_BLOCK_TYPES.has(block.type),
  );
  if (hasOtherNonTextBlocks) return null;

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

export function isSdkErrorResult(message: SDKResultPayload): boolean {
  return typeof message.subtype === 'string' && message.subtype.startsWith('error_');
}

export function isSdkHostNotice(message: SDKResultPayload): boolean {
  return isSdkErrorResult(message) || message.is_error === true;
}

export function labelHostNotice(text: string | null | undefined): string | null {
  const normalized =
    typeof text === 'string' ? normalizeAssistantText(text) : null;
  if (!normalized) return null;
  return `[Agent Host Notice]\n${normalized}`;
}

export function summarizeSdkError(message: SDKResultPayload): string | null {
  const firstError = message.errors?.find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  if (firstError) {
    const summary = firstError
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (summary) return summary;
  }

  if (typeof message.result === 'string') {
    const normalized = normalizeAssistantText(message.result);
    if (normalized) return normalized;
  }

  return typeof message.subtype === 'string'
    ? `Agent SDK reported ${message.subtype}`
    : null;
}
