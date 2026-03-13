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
