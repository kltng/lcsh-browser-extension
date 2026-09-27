import { describe, it, expect } from 'vitest';
import { parseGeminiResponse, base64Of } from '../gemini';
import { makeCfg } from '../../../../test/fixtures';

const candidate = (parts, finishReason = 'STOP') => ({ candidates: [{ content: { parts }, finishReason }] });

const expectKind = (fn, kind) => {
  try {
    fn();
  } catch (err) {
    expect(err.kind).toBe(kind);
    return;
  }
  throw new Error(`expected ${kind}`);
};

describe('[row 8] answer mapping: gemini', () => {
  it('STOP → finish stop, with usage', async () => {
    const cfg = await makeCfg('gemini');
    const data = { ...candidate([{ text: 'Hel' }, { text: 'lo' }]), usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } };
    expect(parseGeminiResponse(cfg, data)).toEqual({ text: 'Hello', finish: 'stop', usage: { inputTokens: 7, outputTokens: 2 } });
  });

  it('another finish reason → other', async () => {
    const cfg = await makeCfg('gemini');
    expect(parseGeminiResponse(cfg, candidate([{ text: 'x' }], 'OTHER')).finish).toBe('other');
  });

  it('MAX_TOKENS → truncated', async () => {
    const cfg = await makeCfg('gemini');
    expectKind(() => parseGeminiResponse(cfg, candidate([{ text: 'x' }], 'MAX_TOKENS')), 'truncated');
  });

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])('%s → refused', async (reason) => {
    const cfg = await makeCfg('gemini');
    expectKind(() => parseGeminiResponse(cfg, candidate([{ text: 'x' }], reason)), 'refused');
  });

  it('promptFeedback.blockReason → refused, with or without candidates', async () => {
    const cfg = await makeCfg('gemini');
    expectKind(() => parseGeminiResponse(cfg, { promptFeedback: { blockReason: 'SAFETY' } }), 'refused');
    expectKind(() => parseGeminiResponse(cfg, { ...candidate([{ text: '' }]), promptFeedback: { blockReason: 'OTHER' } }), 'refused');
  });

  it('no candidates or empty text → invalid_output', async () => {
    const cfg = await makeCfg('gemini');
    expectKind(() => parseGeminiResponse(cfg, {}), 'invalid_output');
    expectKind(() => parseGeminiResponse(cfg, candidate([{ text: '  ' }])), 'invalid_output');
    expectKind(() => parseGeminiResponse(cfg, candidate([])), 'invalid_output');
  });

  it('skips thought parts', async () => {
    const cfg = await makeCfg('gemini');
    const data = candidate([{ text: 'secret plan', thought: true }, { text: 'Answer' }]);
    expect(parseGeminiResponse(cfg, data).text).toBe('Answer');
    expectKind(() => parseGeminiResponse(cfg, candidate([{ text: 'only thoughts', thought: true }])), 'invalid_output');
  });

  it('base64Of keeps only the data part', () => {
    expect(base64Of('data:image/png;base64,QUJD')).toBe('QUJD');
  });
});
