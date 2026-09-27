import { describe, it, expect, vi } from 'vitest';
import { runSuggest, parseTextFallback, postProcessSuggestions, SUGGEST_DEADLINE_MS, TEXT_FALLBACK_NOTICE } from '../suggest';
import { SUGGEST_SCHEMA } from '../schemas';
import { TEXT_FALLBACK_INSTRUCTION } from '../prompts';
import { ProviderError } from '../../providers/errors';
import { response } from '../../../../test/setup';
import { makeCfg, mockFetch, successBody, bodyOf, KEY } from '../../../../test/fixtures';

const CFG = { providerId: 'gemini', model: 'gemini-2.5-flash', entry: { adapter: 'gemini' } };
const BIB = { title: 'Cats of Japan', author: 'Tanaka', abstract: 'About cats.', tableOfContents: '', notes: '', images: [] };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'responseSchema', usage: {} });
const text = (t) => ({ text: t, json: null, finish: 'stop', mode: 'text', usage: {} });

describe('[P4 row3] suggest: JSON path', () => {
  it('calls generate with the schema, 0.2, 2048 tokens, the images and the 90 s deadline', async () => {
    const generateImpl = vi.fn(async () => answer({
      subjectAnalysis: ' A book about cats. ',
      suggestions: [{ heading: ' Cats--Japan ', kind: 'topical', reason: ' Main topic. ' }]
    }));
    const result = await runSuggest({
      cfg: CFG, bibliographicInfo: { ...BIB, images: [{ data: 'data:image/png;base64,AA', type: 'image/png', name: 'a', size: 1 }] }, rules: 'R', generateImpl
    });
    const [cfg, req] = generateImpl.mock.calls[0];
    expect(cfg).toBe(CFG);
    expect(req).toMatchObject({ schema: SUGGEST_SCHEMA, temperature: 0.2, maxOutputTokens: 2048, deadlineMs: SUGGEST_DEADLINE_MS });
    expect(req.images).toEqual([{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' }]);
    expect(req.system.endsWith('\nR')).toBe(true);
    expect(req.userText).toContain('Title: Cats of Japan');
    expect(result).toEqual({
      subjectAnalysis: 'A book about cats.',
      suggestions: [{ id: 's1', heading: 'Cats--Japan', kind: 'topical', reason: 'Main topic.' }],
      suggestMode: 'json',
      provenance: { providerId: 'gemini', model: 'gemini-2.5-flash' }
    });
  });

  it('ids s1..sN in model order; duplicates merged (normalizeLabel, first kept); no-letter headings dropped', () => {
    expect(postProcessSuggestions([
      { heading: 'Cats', kind: 'topical', reason: 'a' },
      { heading: '---', kind: 'topical', reason: 'b' },
      { heading: 'cats.', kind: 'name', reason: 'c' },
      { heading: 'Motion pictures -- Japan', kind: 'topical', reason: 'd' },
      { heading: 'Motion pictures--Japan', kind: 'genre', reason: 'e' },
      { heading: '日本', kind: 'geographic', reason: 'f' }
    ])).toEqual([
      { id: 's1', heading: 'Cats', kind: 'topical', reason: 'a' },
      { id: 's2', heading: 'Motion pictures -- Japan', kind: 'topical', reason: 'd' },
      { id: 's3', heading: '日本', kind: 'geographic', reason: 'f' }
    ]);
  });

  it('no suggestion left after post-processing → invalid_output (no text fallback)', async () => {
    const generateImpl = vi.fn(async () => answer({ subjectAnalysis: 'x', suggestions: [{ heading: '...', kind: 'topical', reason: '' }] }));
    await expect(runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl })).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(generateImpl).toHaveBeenCalledTimes(1);
  });

  it('through the real Gemini adapter: the canonical schema reaches the request, and the result is parsed', async () => {
    const cfg = await makeCfg('gemini', { model: 'gemini-2.5-flash' });
    const json = { subjectAnalysis: 'About cats.', suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'Topic.' }] };
    const fetchMock = mockFetch(response(successBody('gemini', JSON.stringify(json))));
    const result = await runSuggest({ cfg, bibliographicInfo: BIB, rules: 'R' });
    const body = bodyOf(fetchMock);
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0.2 });
    expect(body.generationConfig.responseSchema.properties.suggestions.maxItems).toBe(8);
    expect(result.suggestions).toEqual([{ id: 's1', heading: 'Cats', kind: 'topical', reason: 'Topic.' }]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('[P4 row3] suggest: disclosed text fallback', () => {
  it('invalid_output → ONE text retry with the instruction, same images and signal; suggestMode recorded', async () => {
    const signal = new AbortController().signal;
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('invalid_output', {}))
      .mockResolvedValueOnce(text('1. Cats\n2. **Cats--Japan**\n- Japan'));
    const images = [{ data: 'data:image/png;base64,AA', type: 'image/png' }];
    const result = await runSuggest({ cfg: CFG, bibliographicInfo: { ...BIB, images }, rules: 'R', signal, generateImpl });
    expect(generateImpl).toHaveBeenCalledTimes(2);
    const [first, second] = generateImpl.mock.calls.map((c) => c[1]);
    expect(second.schema).toBeNull();
    expect(second.system).toBe(`${first.system}\n\n${TEXT_FALLBACK_INSTRUCTION}`);
    expect(TEXT_FALLBACK_INSTRUCTION).toBe('List the headings only, one per line, at most 8.');
    expect(second.images).toEqual(first.images);
    expect(second.signal).toBe(signal);
    expect(second.deadlineMs).toBeLessThanOrEqual(SUGGEST_DEADLINE_MS);
    expect(result).toEqual({
      subjectAnalysis: '',
      suggestions: [
        { id: 's1', heading: 'Cats', kind: 'unknown', reason: '' },
        { id: 's2', heading: 'Cats--Japan', kind: 'unknown', reason: '' },
        { id: 's3', heading: 'Japan', kind: 'unknown', reason: '' }
      ],
      suggestMode: 'text-fallback',
      provenance: { providerId: 'gemini', model: 'gemini-2.5-flash' }
    });
    expect(TEXT_FALLBACK_NOTICE).toBe('The model did not return structured output; suggestions were read from plain text.');
  });

  it('the 90 s budget covers both attempts: the retry gets only the remaining time', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const generateImpl = vi.fn(async (cfg, req) => {
        if (req.schema) {
          vi.setSystemTime(60000);
          throw new ProviderError('invalid_output', {});
        }
        return text('Cats');
      });
      await runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl });
      expect(generateImpl.mock.calls[1][1].deadlineMs).toBe(30000);
      generateImpl.mockImplementation(async (cfg, req) => {
        vi.setSystemTime(Date.now() + 90000);
        throw new ProviderError('invalid_output', {});
      });
      await expect(runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl })).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('parser bounds: fence, numbering, bold, > 200 characters, > 8 lines, dedupe', () => {
    const long = 'x'.repeat(201);
    expect(parseTextFallback('```\n1) Cats\n* Dogs\n• Birds\n**Fish**\n```')).toEqual(['Cats', 'Dogs', 'Birds', 'Fish']);
    expect(parseTextFallback('```text\n- Cats\n```')).toEqual(['Cats']);
    expect(parseTextFallback(`Cats\n${long}\n${'y'.repeat(200)}\n\n   \nCATS.`)).toEqual(['Cats', 'y'.repeat(200)]);
    const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. Heading ${i + 1}`).join('\n');
    expect(parseTextFallback(nine)).toEqual(Array.from({ length: 8 }, (_, i) => `Heading ${i + 1}`));
    expect(parseTextFallback('12. Japan--History')).toEqual(['Japan--History']);
  });

  it('zero lines → invalid_output', async () => {
    expect(parseTextFallback('```\n\n```')).toEqual([]);
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('invalid_output', {}))
      .mockResolvedValueOnce(text('   \n---\n'));
    await expect(runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl })).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it.each(['truncated', 'auth', 'network', 'timeout', 'rate_limit', 'refused', 'too_long', 'cancelled', 'images_unsupported', 'not_configured'])(
    'a %s error propagates (no fallback)',
    async (kind) => {
      const generateImpl = vi.fn().mockRejectedValue(new ProviderError(kind, {}));
      await expect(runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl })).rejects.toMatchObject({ kind });
      expect(generateImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('a failing fallback propagates its error', async () => {
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('invalid_output', {}))
      .mockRejectedValueOnce(new ProviderError('network', {}));
    await expect(runSuggest({ cfg: CFG, bibliographicInfo: BIB, rules: '', generateImpl })).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('[P4 row3] suggest: requests through real adapters (ported P3 row 23 checks)', () => {
  it('Anthropic requests contain no temperature', async () => {
    const cfg = await makeCfg('anthropic', { model: 'claude-sonnet-5' });
    const json = { subjectAnalysis: 'x', suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }] };
    const fetchMock = mockFetch(response(successBody('anthropic', JSON.stringify(json))));
    await runSuggest({ cfg, bibliographicInfo: BIB, rules: '' });
    const body = bodyOf(fetchMock);
    expect('temperature' in body).toBe(false);
    expect(body.output_config.format.type).toBe('json_schema');
  });

  it('the Gemini text fallback sends no responseSchema', async () => {
    const cfg = await makeCfg('gemini', { model: 'gemini-2.5-flash' });
    const fetchMock = mockFetch(response(successBody('gemini', 'not json at all')), response(successBody('gemini', 'Cats\nDogs')));
    const result = await runSuggest({ cfg, bibliographicInfo: BIB, rules: '' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).generationConfig.responseSchema).toBeUndefined();
    expect(result.suggestMode).toBe('text-fallback');
  });
});
