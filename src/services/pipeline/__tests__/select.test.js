import { describe, it, expect, vi } from 'vitest';
import {
  presentCandidates, validateSelectAnswer, exactOnlyChoices, runAiSelect, mergeSelections, buildRecommendations,
  lexicalSimilarity, subdivisionInfo, subdivisionNote, AUTO_FALLBACK_KINDS, FALLBACK_BANNER
} from '../select';
import { SELECT_SCHEMA } from '../schemas';
import { ProviderError } from '../../providers/errors';
import { isSelection } from '../types';
import { C, SUGGESTIONS, RESULTS, result } from '../../../../test/pipelineFixtures';
import { response } from '../../../../test/setup';
import { makeCfg, mockFetch, successBody, bodyOf } from '../../../../test/fixtures';

const CLOUD = { providerId: 'deepseek', model: 'deepseek-flash', entry: { adapter: 'openai-style' } };
const BIB = { title: '日本電影人物志', author: '', abstract: '', tableOfContents: '', notes: '' };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const presentation = () => presentCandidates(SUGGESTIONS, RESULTS, 10);

describe('[P4 row9] select: presentation', () => {
  it('only found/partial suggestions are presented, with s{n}c{m} ids and no URIs', () => {
    const { presented, snapshot } = presentation();
    expect(presented.map((p) => p.suggestionId)).toEqual(['s1', 's2', 's3', 's6']);
    expect(presented[0].candidates.map((c) => c.pid)).toEqual(['s1c1', 's1c2']);
    expect(snapshot.get('s3c2')).toEqual({ suggestionId: 's3', cid: 'lcnaf:n78089021' });
    expect(JSON.stringify(presented)).not.toContain('id.loc.gov');
  });

  it('the per-suggestion limit cuts the ranked list', () => {
    expect(presentCandidates(SUGGESTIONS, RESULTS, 2).presented.find((p) => p.suggestionId === 's3').candidates).toHaveLength(2);
  });
});

describe('[P4 row9] select: validation rules', () => {
  it('valid choices, "none", a cross-suggestion id, an unknown id, a duplicate suggestionId, an unpresented suggestion', () => {
    const v = validateSelectAnswer({
      selections: [
        { suggestionId: 's1', choice: 's1c1', confidence: 85 },
        { suggestionId: 's2', choice: 's1c2', confidence: 70 },
        { suggestionId: 's3', choice: 's3c9', confidence: 50 },
        { suggestionId: 's1', choice: 's1c2', confidence: 99 },
        { suggestionId: 's4', choice: 'none', confidence: 10 },
        { suggestionId: 's6', choice: 'none', confidence: 60 }
      ],
      additional: []
    }, presentation());
    expect(v.choices).toEqual({ s1: { cid: 'lcsh:sh2008108026', confidence: 85 }, s6: { cid: null, confidence: 60 } });
    expect(v.invalidCount).toBe(4);
  });

  it('a first occurrence that is invalid blocks later ones of the same suggestion', () => {
    const v = validateSelectAnswer({
      selections: [{ suggestionId: 's1', choice: 's3c1', confidence: 1 }, { suggestionId: 's1', choice: 's1c1', confidence: 2 }],
      additional: []
    }, presentation());
    expect(v.choices).toEqual({});
    expect(v.invalidCount).toBe(2);
  });

  it('additional: presented ids only, not chosen by a valid selection, dedupe by cid, at most 3', () => {
    const v = validateSelectAnswer({
      selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 85 }],
      additional: [
        { choice: 's6c2', confidence: 50 },
        { choice: 's1c2', confidence: 40 },
        { choice: 's6c1', confidence: 30 },
        { choice: 'zz', confidence: 20 }
      ]
    }, presentation());
    expect(v.additional).toEqual([{ cid: 'lcsh:sh85088164', confidence: 40, suggestionId: 's1' }]);
    expect(v.invalidCount).toBe(3);
    const capped = validateSelectAnswer({
      selections: [],
      additional: [{ choice: 's3c1', confidence: 1 }, { choice: 's3c2', confidence: 2 }, { choice: 's3c3', confidence: 3 }, { choice: 's2c1', confidence: 4 }]
    }, presentation());
    expect(capped.additional).toHaveLength(3);
  });

  it('logs only the invalid count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateImpl = vi.fn(async () => answer({ selections: [{ suggestionId: 's9', choice: 'none', confidence: 1 }], additional: [] }));
    await runAiSelect({ cfg: CLOUD, bibliographicInfo: BIB, suggestions: SUGGESTIONS, results: RESULTS, generateImpl });
    expect(warn).toHaveBeenCalledWith('[select]', { invalid_selection: 1 });
  });
});

describe('[P4 row9] select: the AI call and the §5.2 table', () => {
  it('sends the select schema, the bibliographic text and no images', async () => {
    const generateImpl = vi.fn(async () => answer({ selections: [], additional: [] }));
    await runAiSelect({ cfg: CLOUD, bibliographicInfo: { ...BIB, images: [{ data: 'x' }] }, suggestions: SUGGESTIONS, results: RESULTS, generateImpl });
    const req = generateImpl.mock.calls[0][1];
    expect(req.schema).toBe(SELECT_SCHEMA);
    expect(req.images).toBeUndefined();
    expect(req.userText).toContain('Title: 日本電影人物志');
  });

  it('no presented candidate → no provider call', async () => {
    const generateImpl = vi.fn();
    const out = await runAiSelect({ cfg: CLOUD, bibliographicInfo: BIB, suggestions: [SUGGESTIONS[3]], results: RESULTS, generateImpl });
    expect(out).toEqual({ mode: 'ai', choices: {}, additional: [], called: false });
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it.each([...AUTO_FALLBACK_KINDS])('%s → automatic exact-only fallback', async (kind) => {
    const generateImpl = vi.fn().mockRejectedValue(new ProviderError(kind, {}));
    const out = await runAiSelect({ cfg: CLOUD, bibliographicInfo: BIB, suggestions: SUGGESTIONS, results: RESULTS, generateImpl });
    expect(out.mode).toBe('exact-fallback');
    expect(out.fallbackKind).toBe(kind);
    expect(generateImpl).toHaveBeenCalledTimes(1);
    expect(FALLBACK_BANNER).toBe('The AI could not choose; only exact matches were kept.');
  });

  it.each(['auth', 'permission', 'billing', 'not_configured', 'forbidden', 'bad_request', 'images_unsupported', 'network',
    'timeout', 'rate_limit', 'server', 'overloaded', 'refused', 'unavailable', 'something_new'])('%s → the step stops (error thrown)', async (kind) => {
    const generateImpl = vi.fn().mockRejectedValue(new ProviderError(kind, {}));
    await expect(runAiSelect({ cfg: CLOUD, bibliographicInfo: BIB, suggestions: SUGGESTIONS, results: RESULTS, generateImpl }))
      .rejects.toMatchObject({ kind });
  });

  it('cancelled → thrown (nothing changes)', async () => {
    const generateImpl = vi.fn().mockRejectedValue(new ProviderError('cancelled', {}));
    await expect(runAiSelect({ cfg: CLOUD, bibliographicInfo: BIB, suggestions: SUGGESTIONS, results: RESULTS, generateImpl }))
      .rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('[P4 row9] select: exact-only fallback', () => {
  it('a unique exact-full is kept; an ambiguous one (LCSH and LCNAF) gives none; no fuzzy acceptance', () => {
    const choices = exactOnlyChoices(SUGGESTIONS, RESULTS);
    expect(choices).toEqual({ s1: { cid: 'lcsh:sh2008108026' }, s2: { cid: null }, s3: { cid: null }, s6: { cid: 'lcsh:sh2008108026' } });
    const sel = mergeSelections({ suggestions: SUGGESTIONS, results: RESULTS, mode: 'exact-fallback', choices });
    expect(sel.map((s) => [s.suggestionId, s.method, s.noneReason])).toEqual([
      ['s1', 'exact', null], ['s2', 'none', 'ai-unavailable'], ['s3', 'none', 'ai-unavailable'],
      ['s4', 'none', 'no-results'], ['s5', 'none', 'lookup-failed'], ['s6', 'exact', null]
    ]);
  });
});

describe('[P4 row9] select: merge, manual override, noneReason per case', () => {
  const ai = { s1: { cid: C.mpjh.cid, confidence: 85 }, s2: { cid: null, confidence: 40 }, s6: { cid: C.mp.cid, confidence: 70 } };

  it('noneReason: lookup-failed, no-results, ai-chose-none, not-chosen', () => {
    const sel = mergeSelections({ suggestions: SUGGESTIONS, results: RESULTS, mode: 'ai', choices: ai });
    expect(sel.map((s) => [s.suggestionId, s.method, s.cid, s.noneReason, s.confidence])).toEqual([
      ['s1', 'ai', C.mpjh.cid, null, 85],
      ['s2', 'none', null, 'ai-chose-none', null],
      ['s3', 'none', null, 'not-chosen', null],
      ['s4', 'none', null, 'no-results', null],
      ['s5', 'none', null, 'lookup-failed', null],
      ['s6', 'ai', C.mp.cid, null, 70]
    ]);
    expect(sel.every(isSelection)).toBe(true);
  });

  it('manual choices override AI and exact choices; "Use none" → manual-none', () => {
    const manual = { s1: { cid: C.mp.cid }, s3: { cid: C.japanN.cid }, s6: { cid: null } };
    const sel = mergeSelections({ suggestions: SUGGESTIONS, results: RESULTS, mode: 'ai', choices: ai, manual });
    expect(sel[0]).toMatchObject({ method: 'manual', cid: C.mp.cid, confidence: null });
    expect(sel[2]).toMatchObject({ method: 'manual', cid: C.japanN.cid });
    expect(sel[5]).toMatchObject({ method: 'manual', cid: null, noneReason: 'manual-none' });
    const exact = mergeSelections({ suggestions: SUGGESTIONS, results: RESULTS, mode: 'exact-fallback', choices: exactOnlyChoices(SUGGESTIONS, RESULTS), manual });
    expect(exact[0]).toMatchObject({ method: 'manual', cid: C.mp.cid });
  });

  it('mainHeadingOnly + droppedSubdivisions (ordered normalized components)', () => {
    expect(subdivisionInfo('Motion pictures', 'Motion pictures--Japan--Biography')).toEqual({ mainHeadingOnly: true, droppedSubdivisions: ['Japan', 'Biography'] });
    expect(subdivisionInfo('Motion pictures--Japan--History', 'Motion pictures--Japan--Biography')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: ['Biography'] });
    expect(subdivisionInfo('Motion pictures--Japan--History', 'motion pictures -- japan -- history.')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
    expect(subdivisionInfo('Japan--History', 'History--Japan')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
    expect(subdivisionInfo('Japan--Kyoto--History', 'Japan--History--Kyoto')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: ['Kyoto'] });
    expect(subdivisionInfo('Cats', 'Cats')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
    const sel = mergeSelections({ suggestions: SUGGESTIONS, results: RESULTS, mode: 'ai', choices: ai });
    expect(sel[5]).toMatchObject({ mainHeadingOnly: true, droppedSubdivisions: ['Japan', 'Biography'] });
  });

  it('lexicalSimilarity is on normalized strings', () => {
    expect(lexicalSimilarity('Cats', 'cats.')).toBe(100);
    expect(lexicalSimilarity('Motion pictures', 'Motion pictures--Japan--Biography')).toBe(45);
    expect(lexicalSimilarity('日本', '日本語')).toBe(67);
  });
});

describe('[P4 row9] select: recommendations aggregated by cid', () => {
  it('one per distinct cid, suggestion order then additional order; additional deduped against final choices', () => {
    const selections = mergeSelections({
      suggestions: SUGGESTIONS, results: RESULTS, mode: 'ai',
      choices: { s1: { cid: C.mpjh.cid, confidence: 85 }, s6: { cid: C.mpjh.cid, confidence: 60 } },
      manual: { s3: { cid: C.japanN.cid } }
    });
    const recs = buildRecommendations({
      selections,
      additional: [{ cid: C.japanN.cid, confidence: 50 }, { cid: C.actors.cid, confidence: 45 }],
      results: RESULTS
    });
    expect(recs.map((r) => r.cid)).toEqual([C.mpjh.cid, C.japanN.cid, C.actors.cid]);
    expect(recs[0].selections).toEqual([
      { suggestionId: 's1', method: 'ai', confidence: 85, lexicalSimilarity: 100 },
      { suggestionId: 's6', method: 'ai', confidence: 60, lexicalSimilarity: expect.any(Number) }
    ]);
    expect(recs[1].selections).toEqual([{ suggestionId: 's3', method: 'manual', confidence: null, lexicalSimilarity: 100 }]);
    expect(recs[2]).toMatchObject({
      label: C.actors.label, authority: 'lcsh', localId: 'sh2010102453', uri: C.actors.uri, source: 'loc-api',
      selections: [{ suggestionId: null, method: 'ai', confidence: 45, lexicalSimilarity: null }]
    });
    expect(recs[0].marc.text).toBe('650 _0 $a Motion pictures $z Japan $x History');
    expect(subdivisionNote(recs[0], selections)).toBe('The selected heading does not include these suggested subdivisions: Biography');
    expect(subdivisionNote(recs[1], selections)).toBeNull();
  });

  it('MARC unavailable reasons flow into the recommendation', () => {
    const results = { s1: result('s1', 'found', [C.japanSh, C.mismatch]) };
    const recs = buildRecommendations({
      selections: mergeSelections({ suggestions: [SUGGESTIONS[0]], results, mode: 'ai', manual: {}, choices: { s1: { cid: C.japanSh.cid, confidence: 1 } } }),
      additional: [{ cid: C.mismatch.cid, confidence: 2 }],
      results
    });
    expect(recs.map((r) => r.marc.reason)).toEqual(['no key', 'key does not match label']);
  });
});

describe('[P4 row9] select: subdivisions compared per normalized component (fix-1 #4)', () => {
  it('Cats--History.--Bibliography vs Cats--History--Bibliography → nothing dropped', () => {
    expect(subdivisionInfo('Cats--History--Bibliography', 'Cats--History.--Bibliography')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
    expect(subdivisionInfo('Cats--History.--Bibliography', 'Cats--History--Bibliography')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
  });

  it('internal trailing punctuation, spaced dashes and case on any component', () => {
    expect(subdivisionInfo('Japan--History--1868-', 'JAPAN. -- History... — 1868-')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: [] });
    expect(subdivisionInfo('Japan--History', 'Japan.--History.--Bibliography.')).toEqual({ mainHeadingOnly: false, droppedSubdivisions: ['Bibliography.'] });
  });

  it('mainHeadingOnly with a trailing period on the main heading', () => {
    expect(subdivisionInfo('Motion pictures', 'Motion pictures.--Japan')).toEqual({ mainHeadingOnly: true, droppedSubdivisions: ['Japan'] });
    expect(subdivisionInfo('Motion pictures.', 'Motion pictures--Japan')).toEqual({ mainHeadingOnly: true, droppedSubdivisions: ['Japan'] });
  });

  it('the displayed dropped subdivision keeps its original text', () => {
    expect(subdivisionInfo('Cats', 'Cats -- Behavior -- Juvenile literature').droppedSubdivisions).toEqual(['Behavior', 'Juvenile literature']);
  });
});

describe('[P4 row9] select: the Anthropic SELECT path through the real adapter (fix-1 #8)', () => {
  it('sends no temperature, uses output_config with the select schema, and validates the answer', async () => {
    const cfg = await makeCfg('anthropic', { model: 'claude-sonnet-5' });
    const json = { selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [{ choice: 's3c2', confidence: 50 }] };
    const fetchMock = mockFetch(response(successBody('anthropic', JSON.stringify(json))));
    const out = await runAiSelect({ cfg, bibliographicInfo: BIB, suggestions: SUGGESTIONS, results: RESULTS });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    const body = bodyOf(fetchMock);
    expect('temperature' in body).toBe(false);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(['selections', 'additional']);
    expect(body.messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('s1c1: Motion pictures--Japan--History') }]);
    expect(out).toMatchObject({
      mode: 'ai',
      choices: { s1: { cid: C.mpjh.cid, confidence: 90 } },
      additional: [{ cid: C.japanN.cid, confidence: 50, suggestionId: 's3' }]
    });
  });
});
