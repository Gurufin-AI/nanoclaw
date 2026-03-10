import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToOpenAiChat,
  openAiResponseToAnthropic,
} from './anthropic-openai-proxy.js';

describe('anthropic-openai proxy conversion', () => {
  it('maps tool_use and tool_result blocks to OpenAI chat format', () => {
    const converted = anthropicRequestToOpenAiChat({
      model: 'test-model',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'WebSearch',
              input: { query: 'nanoclaw' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'result payload' }],
            },
          ],
        },
      ],
      tools: [
        {
          name: 'WebSearch',
          description: 'Search the web',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ],
      tool_choice: { type: 'any' },
      stream: true,
    });

    expect(converted).toMatchObject({
      model: 'test-model',
      stream: false,
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'WebSearch',
          },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'Searching',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'WebSearch',
                arguments: '{"query":"nanoclaw"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: 'result payload',
        },
      ],
    });
  });

  it('maps OpenAI tool calls back to Anthropic content blocks', () => {
    const converted = openAiResponseToAnthropic(
      {
        id: 'chatcmpl-1',
        model: 'test-model',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Need a tool',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'WebFetch',
                    arguments: '{"url":"https://example.com"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
      },
      'fallback-model',
    );

    expect(converted).toMatchObject({
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
      content: [
        { type: 'text', text: 'Need a tool' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'WebFetch',
          input: { url: 'https://example.com' },
        },
      ],
    });
  });
});
