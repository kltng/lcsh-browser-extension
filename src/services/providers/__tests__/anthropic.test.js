import { describe, it, expect } from 'vitest';
import { parseAnthropicResponse } from '../anthropic';
import { makeCfg } from '../../../../test/fixtures';

const expectKind = (fn, kind) => {
  try {
    fn();
  } catch (err) {
    expect(err.kind).toBe(kind);
    return;
  }
  throw new Error(`expected ${kind}`);
};

describe('[row 8] answer mapping: anthropic', () => {
  it.each(['end_turn', 'stop_sequence'])('%s → finish stop', async (reason) => {
    const cfg = await makeCfg('anthropic');
    const data = { content: [{ type: 'text', text: 'Hello' }], stop_reason: reason, usage: { input_tokens: 4, output_tokens: 1 } };
    expect(parseAnthropicResponse(cfg, data)).toEqual({ text: 'Hello', finish: 'stop', usage: { inputTokens: 4, outputTokens: 1 } });
  });

  it('another stop reason → other', async () => {
    const cfg = await makeCfg('anthropic');
    expect(parseAnthropicResponse(cfg, { content: [{ type: 'text', text: 'x' }], stop_reason: 'pause_turn' }).finish).toBe('other');
  });

  it('max_tokens → truncated; refusal → refused', async () => {
    const cfg = await makeCfg('anthropic');
    expectKind(() => parseAnthropicResponse(cfg, { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }), 'truncated');
    expectKind(() => parseAnthropicResponse(cfg, { content: [], stop_reason: 'refusal' }), 'refused');
  });

  it('empty content → invalid_output', async () => {
    const cfg = await makeCfg('anthropic');
    expectKind(() => parseAnthropicResponse(cfg, { content: [], stop_reason: 'end_turn' }), 'invalid_output');
    expectKind(() => parseAnthropicResponse(cfg, { stop_reason: 'end_turn' }), 'invalid_output');
  });

  it('reads only text blocks', async () => {
    const cfg = await makeCfg('anthropic');
    const data = {
      content: [
        { type: 'thinking', thinking: 'hidden', signature: 'x' },
        { type: 'text', text: 'Part 1. ' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
        { type: 'text', text: 'Part 2.' }
      ],
      stop_reason: 'end_turn'
    };
    expect(parseAnthropicResponse(cfg, data).text).toBe('Part 1. Part 2.');
    expectKind(() => parseAnthropicResponse(cfg, { content: [{ type: 'thinking', thinking: 'only' }], stop_reason: 'end_turn' }), 'invalid_output');
  });
});
