import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  extractSystemText,
  mapAnthropicMessagesToOpenAI,
  mapAnthropicToolsToOpenAI,
  mapFinishReason,
} from '../../lib/llm.js';

describe('llm OpenRouter adapter — Anthropic → OpenAI translation', () => {
  it('flattens a system array of text blocks into a single string', () => {
    const system: Anthropic.MessageCreateParams['system'] = [
      { type: 'text', text: 'You are Nyx.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Be concise.' },
    ];
    expect(extractSystemText(system)).toBe('You are Nyx.\nBe concise.');
    expect(extractSystemText('plain string')).toBe('plain string');
  });

  it('prepends a system message and passes through simple turns', () => {
    const out = mapAnthropicMessagesToOpenAI('SYS', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('converts assistant tool_use blocks into OpenAI tool_calls', () => {
    const out = mapAnthropicMessagesToOpenAI('', [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'nyx' } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: JSON.stringify({ q: 'nyx' }) },
          },
        ],
      },
    ]);
  });

  it('converts user tool_result blocks into dedicated tool messages', () => {
    const out = mapAnthropicMessagesToOpenAI('', [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'the answer' }],
      },
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'the answer' }]);
  });

  it('maps Anthropic tools to OpenAI function tools, stripping cache_control', () => {
    const tools: Anthropic.MessageCreateParams['tools'] = [
      {
        name: 'search',
        description: 'search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        cache_control: { type: 'ephemeral' },
      },
    ];
    expect(mapAnthropicToolsToOpenAI(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ]);
    expect(mapAnthropicToolsToOpenAI(undefined)).toBeUndefined();
  });

  it('maps OpenAI finish reasons to Anthropic stop reasons', () => {
    expect(mapFinishReason('length')).toBe('max_tokens');
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
    expect(mapFinishReason('stop')).toBe('end_turn');
    expect(mapFinishReason(null)).toBe('end_turn');
  });
});
