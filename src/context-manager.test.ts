import { describe, expect, it } from 'vitest';

import {
  classifyOverflow,
  resolveObservedOverflow,
} from './context-manager.js';

describe('context manager', () => {
  it('classifies known overflow markers', () => {
    expect(classifyOverflow('exceed_context_size_error')).toBe(
      'session_too_large',
    );
    expect(classifyOverflow('Prompt is too long')).toBe('input_too_large');
    expect(classifyOverflow('[Agent Host Notice]\nPrompt is too long')).toBe(
      'input_too_large',
    );
    expect(classifyOverflow('__NANOCLAW_PLACEHOLDER_OUTPUT__')).toBe(
      'placeholder',
    );
    expect(classifyOverflow(null)).toBe('none');
  });

  it('prefers streamed overflow over final null result', () => {
    expect(resolveObservedOverflow('session_too_large', null)).toBe(
      'session_too_large',
    );
    expect(resolveObservedOverflow('input_too_large', null)).toBe(
      'input_too_large',
    );
  });

  it('falls back to final result classification when no streamed overflow exists', () => {
    expect(resolveObservedOverflow('none', 'Prompt is too long')).toBe(
      'input_too_large',
    );
    expect(resolveObservedOverflow('none', null)).toBe('none');
  });
});
