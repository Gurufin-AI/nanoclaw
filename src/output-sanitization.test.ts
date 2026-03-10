import { describe, expect, it } from 'vitest';

import { sanitizeOutboundText } from './output-sanitization.js';

describe('sanitizeOutboundText', () => {
  it('drops control-only output', () => {
    expect(sanitizeOutboundText('\b\u0000\u0000\u0000')).toBeNull();
  });

  it('removes internal blocks and control bytes', () => {
    expect(
      sanitizeOutboundText('Hi<internal>ignore</internal>\u0000 there\b'),
    ).toBe('Hi there');
  });

  it('preserves normal multiline output', () => {
    expect(sanitizeOutboundText('line 1\nline 2')).toBe('line 1\nline 2');
  });
});
