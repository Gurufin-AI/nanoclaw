import { describe, expect, it } from 'vitest';

import { extractAssistantText, normalizeAssistantText } from './output.js';

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
});
