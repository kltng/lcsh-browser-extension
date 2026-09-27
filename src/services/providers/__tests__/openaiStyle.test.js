import { describe, it, expect } from 'vitest';
import { parseOpenAIResponse } from '../openaiStyle';
import { makeCfg } from '../../../../test/fixtures';

const body = (message, finishReason = 'stop', extra = {}) => ({ choices: [{ message, finish_reason: finishReason }], ...extra });

const expectKind = (fn, kind) => {
  try {
    fn();
  } catch (err) {
    expect(err.kind).toBe(kind);
    return;
  }
  throw new Error(`expected ${kind}`);
};

describe('[row 8] answer mapping: openai-style', () => {
  it('stop → finish stop, with usage', async () => {
    const cfg = await makeCfg('openai');
    expect(parseOpenAIResponse(cfg, body({ content: 'Hello' }, 'stop', { usage: { prompt_tokens: 3, completion_tokens: 1 } })))
      .toEqual({ text: 'Hello', finish: 'stop', usage: { inputTokens: 3, outputTokens: 1 } });
  });

  it('another finish reason → other', async () => {
    const cfg = await makeCfg('openai');
    expect(parseOpenAIResponse(cfg, body({ content: 'Hello' }, 'tool_calls')).finish).toBe('other');
  });

  it('length → truncated, also when the content is empty', async () => {
    const cfg = await makeCfg('deepseek');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: 'partial' }, 'length')), 'truncated');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: '' }, 'length')), 'truncated');
  });

  it('a non-empty refusal → refused', async () => {
    const cfg = await makeCfg('openai');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: null, refusal: 'I cannot help with that.' })), 'refused');
  });

  it('content_filter → refused', async () => {
    const cfg = await makeCfg('openai');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: 'x' }, 'content_filter')), 'refused');
  });

  it('empty content, missing choices or non-string content → invalid_output', async () => {
    const cfg = await makeCfg('openai');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: '' })), 'invalid_output');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: '  ' })), 'invalid_output');
    expectKind(() => parseOpenAIResponse(cfg, { choices: [] }), 'invalid_output');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: 42 })), 'invalid_output');
  });

  it('strips <think> blocks when the provider needs it, and ignores reasoning fields', async () => {
    const cfg = await makeCfg('minimax');
    const result = parseOpenAIResponse(cfg, body({ content: '<think>hmm</think>Answer', reasoning_content: 'secret', reasoning: 'x' }));
    expect(result.text).toBe('Answer');
    expectKind(() => parseOpenAIResponse(cfg, body({ content: '<think>never closed' })), 'invalid_output');
    const plain = await makeCfg('openai');
    expect(parseOpenAIResponse(plain, body({ content: '<think>kept</think>A' })).text).toBe('<think>kept</think>A');
  });
});
