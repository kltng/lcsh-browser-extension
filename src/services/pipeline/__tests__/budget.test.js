import { describe, it, expect, vi } from 'vitest';
import { trimAtWord, budgetBibliographic, candidateLimit, isNano, SUGGEST_LIMITS, NANO_RETRY_CANDIDATES } from '../budget';
import { runAiSelect, RETRY_ID_OFFSET } from '../select';
import { runSuggest } from '../suggest';
import { ProviderError } from '../../providers/errors';
import { C, SUGGESTIONS, RESULTS, result } from '../../../../test/pipelineFixtures';

const NANO = { providerId: 'gemini-nano', model: 'gemini-nano', entry: { adapter: 'chrome-nano' } };
const CLOUD = { providerId: 'gemini', model: 'gemini-2.5-flash', entry: { adapter: 'gemini' } };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'responseConstraint', usage: {} });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('[P4 row10] budget: trimming', () => {
  it('cuts at a word boundary, then …, within the limit', () => {
    expect(trimAtWord('short', 10)).toBe('short');
    expect(trimAtWord('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect([...trimAtWord(words(1000), 2000)].length).toBeLessThanOrEqual(2000);
    expect(trimAtWord(words(1000), 2000).endsWith('…')).toBe(true);
    expect(trimAtWord('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(trimAtWord('日本電影人物志日本電影人物志', 5)).toBe('日本電影…');
  });

  it('Nano trims abstract / TOC / notes to 2,000 / 1,500 / 800; cloud to 8,000 / 4,000 / 2,000', () => {
    const info = { title: 'T', author: 'A', abstract: words(3000), tableOfContents: words(3000), notes: words(3000), images: [{ data: 'x' }] };
    const nano = budgetBibliographic(info, NANO);
    expect([...nano.abstract].length).toBeLessThanOrEqual(2000);
    expect([...nano.abstract].length).toBeGreaterThan(1900);
    expect([...nano.tableOfContents].length).toBeLessThanOrEqual(1500);
    expect([...nano.notes].length).toBeLessThanOrEqual(800);
    const cloud = budgetBibliographic(info, CLOUD);
    expect([...cloud.abstract].length).toBeLessThanOrEqual(8000);
    expect([...cloud.abstract].length).toBeGreaterThan(7900);
    expect([...cloud.tableOfContents].length).toBeLessThanOrEqual(4000);
    expect([...cloud.notes].length).toBeLessThanOrEqual(2000);
    expect(SUGGEST_LIMITS).toEqual({ nano: { abstract: 2000, tableOfContents: 1500, notes: 800 }, cloud: { abstract: 8000, tableOfContents: 4000, notes: 2000 } });
    expect(nano.images).toBeUndefined();
    expect(info.abstract.length).toBeGreaterThan(8000);
  });

  it('the suggest prompt of Nano carries the trimmed text', async () => {
    const generateImpl = vi.fn(async () => answer({ subjectAnalysis: 'x', suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }] }));
    await runSuggest({ cfg: NANO, bibliographicInfo: { title: 'T', abstract: words(3000) }, rules: '', generateImpl });
    const abstractLine = generateImpl.mock.calls[0][1].userText.split('\n').find((l) => l.startsWith('Abstract: '));
    expect([...abstractLine].length).toBeLessThanOrEqual(2000 + 'Abstract: '.length);
  });

  it('candidates per suggestion: Nano 4, cloud 10', () => {
    expect(candidateLimit(NANO)).toBe(4);
    expect(candidateLimit(CLOUD)).toBe(10);
    expect(isNano(NANO)).toBe(true);
    expect(isNano(null)).toBe(false);
  });
});

describe('[P4 row10] budget: the Nano too_long retry', () => {
  const many = { s3: result('s3', 'found', [C.japanSh, C.japanN, C.japanHistory, C.mp, C.mpjh]) };
  const s3 = [SUGGESTIONS[2]];

  const idsOf = (text) => [...text.matchAll(/\b(s\d+c\d+):/g)].map((m) => m[1]);

  it('ONE retry with 2 candidates per suggestion and NEW presentation ids DISJOINT from attempt 1', async () => {
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('too_long', {}))
      .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's3', choice: 's3c102', confidence: 90 }], additional: [] }));
    const out = await runAiSelect({ cfg: NANO, bibliographicInfo: { title: 'T' }, suggestions: s3, results: many, generateImpl });
    expect(generateImpl).toHaveBeenCalledTimes(2);
    const first = idsOf(generateImpl.mock.calls[0][1].userText);
    const second = idsOf(generateImpl.mock.calls[1][1].userText);
    expect(first).toEqual(['s3c1', 's3c2', 's3c3', 's3c4']);
    expect(second).toEqual([`s3c${RETRY_ID_OFFSET + 1}`, `s3c${RETRY_ID_OFFSET + 2}`]);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(NANO_RETRY_CANDIDATES).toBe(2);
    expect(out).toMatchObject({ mode: 'ai', choices: { s3: { cid: C.japanN.cid, confidence: 90 } } });
  });

  it('an id from attempt 1 is rejected in attempt 2 (validated only against the new map)', async () => {
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('too_long', {}))
      .mockResolvedValueOnce(answer({
        selections: [{ suggestionId: 's3', choice: 's3c1', confidence: 90 }],
        additional: [{ choice: 's3c2', confidence: 40 }, { choice: 's3c101', confidence: 30 }]
      }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runAiSelect({ cfg: NANO, bibliographicInfo: {}, suggestions: s3, results: many, generateImpl });
    expect(out.choices).toEqual({});
    expect(out.additional).toEqual([{ cid: C.japanSh.cid, confidence: 30, suggestionId: 's3' }]);
    expect(warn).toHaveBeenCalledWith('[select]', { invalid_selection: 2 });
  });

  it('the first attempt presents 4 candidates to Nano', async () => {
    const generateImpl = vi.fn(async () => answer({ selections: [], additional: [] }));
    await runAiSelect({ cfg: NANO, bibliographicInfo: {}, suggestions: s3, results: many, generateImpl });
    const text = generateImpl.mock.calls[0][1].userText;
    expect(text).toContain('s3c4:');
    expect(text).not.toContain('s3c5:');
  });

  it('a second too_long → §5.2 (automatic exact-only fallback)', async () => {
    const generateImpl = vi.fn().mockRejectedValue(new ProviderError('too_long', {}));
    const out = await runAiSelect({ cfg: NANO, bibliographicInfo: {}, suggestions: SUGGESTIONS, results: RESULTS, generateImpl });
    expect(generateImpl).toHaveBeenCalledTimes(2);
    expect(out.mode).toBe('exact-fallback');
  });

  it('a stop kind in the retry stops the step', async () => {
    const generateImpl = vi.fn()
      .mockRejectedValueOnce(new ProviderError('too_long', {}))
      .mockRejectedValueOnce(new ProviderError('unavailable', {}));
    await expect(runAiSelect({ cfg: NANO, bibliographicInfo: {}, suggestions: SUGGESTIONS, results: RESULTS, generateImpl }))
      .rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('cloud too_long goes straight to the fallback (no retry)', async () => {
    const generateImpl = vi.fn().mockRejectedValue(new ProviderError('too_long', {}));
    const out = await runAiSelect({ cfg: CLOUD, bibliographicInfo: {}, suggestions: SUGGESTIONS, results: RESULTS, generateImpl });
    expect(generateImpl).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe('exact-fallback');
  });
});
