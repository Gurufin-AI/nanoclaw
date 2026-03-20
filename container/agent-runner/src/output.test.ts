import { describe, expect, it } from 'vitest';

import {
  extractAssistantText,
  isSdkErrorResult,
  normalizeAssistantText,
  summarizeSdkError,
} from './output.js';

describe('agent-runner output extraction', () => {
  it('drops control-only assistant text', () => {
    expect(normalizeAssistantText('\b\u0000\u0000\u0000')).toBeNull();
    expect(
      extractAssistantText({
        message: {
          content: '\b\u0000\u0000\u0000',
        },
      }),
    ).toBeNull();
  });

  it('strips embedded control characters from visible text', () => {
    expect(normalizeAssistantText('Hello\u0000 world\b')).toBe('Hello world');
  });

  it('preserves normal multiline output', () => {
    expect(normalizeAssistantText('line 1\nline 2')).toBe('line 1\nline 2');
  });

  it('ignores text blocks that become empty after normalization', () => {
    expect(
      extractAssistantText({
        message: {
          content: [
            { type: 'text', text: '\u0000' },
            { type: 'text', text: 'Actual reply' },
          ],
        },
      }),
    ).toBe('Actual reply');
  });

  it('extracts text alongside thinking blocks (OpenRouter/nemotron dedup)', () => {
    expect(
      extractAssistantText({
        message: {
          content: [
            { type: 'thinking', text: 'Internal reasoning...' },
            { type: 'text', text: 'The answer is 42.' },
          ],
        },
      }),
    ).toBe('The answer is 42.');
  });

  it('extracts text alongside redacted_thinking blocks', () => {
    expect(
      extractAssistantText({
        message: {
          content: [
            { type: 'redacted_thinking', text: 'openrouter.reasoning:eyJ0ZXh0...' },
            { type: 'text', text: 'Here is my response.' },
          ],
        },
      }),
    ).toBe('Here is my response.');
  });

  it('returns null for thinking-only messages with no text block', () => {
    expect(
      extractAssistantText({
        message: {
          content: [
            { type: 'thinking', text: 'Just thinking...' },
            { type: 'redacted_thinking', text: 'openrouter.reasoning:eyJ0...' },
          ],
        },
      }),
    ).toBeNull();
  });

  it('still returns null for messages containing tool_use blocks', () => {
    expect(
      extractAssistantText({
        message: {
          content: [
            { type: 'text', text: 'Calling tool...' },
            { type: 'tool_use', text: undefined },
          ],
        },
      }),
    ).toBeNull();
  });

  it('classifies SDK error result subtypes', () => {
    expect(isSdkErrorResult({ subtype: 'error_during_execution' })).toBe(true);
    expect(isSdkErrorResult({ subtype: 'success' })).toBe(false);
  });

  it('summarizes SDK errors from the first error line', () => {
    expect(
      summarizeSdkError({
        subtype: 'error_during_execution',
        errors: [
          'AxiosError: Request failed with status code 401\n    at stack frame',
          'TypeError: secondary failure',
        ],
      }),
    ).toBe('AxiosError: Request failed with status code 401');
  });
});
