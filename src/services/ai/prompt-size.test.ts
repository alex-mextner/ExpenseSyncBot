// Tests for the estimated prompt-size breakdown recorded with every provider attempt
import { describe, expect, it } from 'bun:test';
import type OpenAI from 'openai';
import { estimatePromptSize } from './prompt-size';

const tokens = (chars: number) => Math.ceil(chars / 3.5);

const TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: { name: 'get_expenses', description: 'List expenses', parameters: { type: 'object' } },
};

describe('estimatePromptSize', () => {
  it('splits system, history and the final user message; counts messages and tools', () => {
    const size = estimatePromptSize(
      [
        { role: 'system', content: 'a'.repeat(700) },
        { role: 'user', content: 'b'.repeat(70) },
        { role: 'assistant', content: 'c'.repeat(35) },
        { role: 'user', content: 'd'.repeat(7) },
      ],
      [TOOL],
    );
    expect(size).toEqual({
      systemPromptTokens: 200,
      toolCatalogTokens: tokens(JSON.stringify([TOOL]).length),
      historyTokens: 30,
      userTokens: 2,
      toolCount: 1,
      messageCount: 4,
    });
  });

  it('no tools is a known zero catalog, not unknown', () => {
    const size = estimatePromptSize([{ role: 'user', content: 'hi' }], undefined);
    expect(size).toMatchObject({ toolCatalogTokens: 0, toolCount: 0, systemPromptTokens: 0 });
    expect(estimatePromptSize([{ role: 'user', content: 'hi' }], [])).toMatchObject({
      toolCatalogTokens: 0,
      toolCount: 0,
    });
  });

  it('a conversation not ending in a user message has no user part; everything lands in history', () => {
    const size = estimatePromptSize(
      [
        { role: 'user', content: 'x'.repeat(35) },
        { role: 'assistant', content: 'y'.repeat(35) },
      ],
      undefined,
    );
    expect(size).toMatchObject({ userTokens: 0, historyTokens: 20 });
  });

  it('counts assistant tool-call arguments and tool results as history', () => {
    const size = estimatePromptSize(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'f', arguments: 'a'.repeat(70) } },
          ],
        },
        { role: 'tool', tool_call_id: '1', content: 'r'.repeat(70) },
        { role: 'user', content: 'again' },
      ],
      undefined,
    );
    expect(size.historyTokens).toBeGreaterThanOrEqual(tokens(70) * 2);
    expect(size.userTokens).toBe(tokens(5));
  });

  it('counts only text parts of multi-part content; images add nothing', () => {
    const size = estimatePromptSize(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 't'.repeat(35) },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'Z'.repeat(5000)}` } },
          ],
        },
      ],
      undefined,
    );
    expect(size.userTokens).toBe(10);
  });
});
