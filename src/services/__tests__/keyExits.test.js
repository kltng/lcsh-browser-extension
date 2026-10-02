/**
 * P6 fix 13: no string that repeats a key leaves the model-output pipeline,
 * whatever transformations ran before the exit. The reviewer's traces are
 * run through the REAL workflow, lookup coordinator, history and exports.
 *
 * This file uses only APIs that existed before fix 13, so it also runs on the
 * old code (the new keyGuard registry is reset through a dynamic import).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkflow } from '../pipeline/workflow';
import { createScheduler } from '../lookup/scheduler';
import { copyAllText, recommendationsCsv } from '../pipeline/exports';
import { selectionsOf, buildRun } from '../pipeline/run';
import { buildHistoryEntry, saveHistoryEntry, loadHistory } from '../history';
import { providerKey } from '../settings';
import { fakes } from '../../../test/setup';
import { EVIDENCE, mockLoc } from '../../../test/locFixtures';
import { builtRun } from '../../../test/pipelineFixtures';

beforeEach(async () => {
  const guard = await import('../keyGuard').catch(() => null);
  guard?.resetKeyRegistry?.();
});

const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const suggested = (...headings) => answer({
  subjectAnalysis: 'A book about cats.',
  suggestions: headings.map((heading) => ({ heading, kind: 'topical', reason: 'Topic.' }))
});
/** The q of every LOC request that was sent. */
const sentQueries = (loc) => loc.fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('q'));

const make = ({ apiKey, generateImpl, settings = { lookupBackend: 'loc-api', providers: {} } }) => {
  let n = 0;
  return createWorkflow({
    loadConfig: async () => ({
      cfg: { providerId: 'lmstudio', model: 'm', apiKey, entry: { adapter: 'openai-style' } },
      settings
    }),
    generateImpl,
    scheduler: createScheduler({ spacingMs: 0, maxInFlight: 8 }),
    uuid: () => `run-${++n}`
  });
};

describe('[P6 fix13] the reviewer\'s traces, each at its exit', () => {
  it('(a) key "a", heading "a." → the LOC query would be "a": refused, nothing sent', async () => {
    const loc = mockLoc({});
    const wf = make({ apiKey: 'a', generateImpl: vi.fn().mockResolvedValueOnce(suggested('a.', 'Cats')) });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    expect(wf.getState().suggest.suggestions.map((s) => s.heading)).toEqual(['a.', 'Cats']);
    await wf.lookupAll();
    expect(sentQueries(loc)).not.toContain('a');
    const result = wf.getState().lookup.results.s1;
    expect(result.outcome).toBe('failed');
    expect(result.errorKind).toBe('key_echo');
    // The other suggestion is searched normally.
    expect(sentQueries(loc)).toContain('Cats');
  });

  it('(a) key "sk--secret", heading "sk—secret" → normalized to "sk--secret": refused, nothing sent', async () => {
    const loc = mockLoc({});
    const wf = make({ apiKey: 'sk--secret', generateImpl: vi.fn().mockResolvedValueOnce(suggested('sk—secret')) });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    await wf.lookupAll();
    // The left-anchored query would have been exactly the key; it is never built.
    // (The keyword form "sk secret" does not contain the key and may be sent.)
    expect(sentQueries(loc).some((q) => q.includes('sk--secret'))).toBe(false);
    expect(wf.getState().lookup.results.s1.errorKind).toBe('key_echo');
  });

  it('(d) key "a", heading "Cats--a" → its dropped subdivision would be "a": the suggest step fails with local text', async () => {
    const wf = make({ apiKey: 'a', generateImpl: vi.fn().mockResolvedValueOnce(suggested('Cats--a')) });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    const state = wf.getState();
    expect(state.suggest).toBeNull();
    expect(state.suggestError).toEqual({ kind: 'key_echo', message: 'The AI answer repeats an API key, so it was not used.' });
  });
});

describe('[P6 fix13] other exits and other keys', () => {
  it('(a) a key of ANOTHER stored provider in a heading → the LOC query is refused', async () => {
    const OTHER = 'sk-other-provider-0001';
    const loc = mockLoc({});
    const settings = { lookupBackend: 'loc-api', providers: { openai: { apiKey: OTHER }, lmstudio: { apiKey: 'run-key-1234567' } } };
    const wf = make({ apiKey: 'run-key-1234567', settings, generateImpl: vi.fn().mockResolvedValueOnce(suggested(`Cats ${OTHER}`)) });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    await wf.lookupAll();
    expect(sentQueries(loc).some((q) => q.includes(OTHER))).toBe(false);
    expect(wf.getState().lookup.results.s1.errorKind).toBe('key_echo');
  });

  it('(b) a history entry that contains a stored key → refused, nothing written', async () => {
    const STORED = 'sk-stored-history-key-77';
    await fakes.storage.local.set({ [providerKey('openai')]: { apiKey: STORED } });
    const run = builtRun();
    const entry = buildHistoryEntry({ run: { ...run, input: { ...run.input, notes: `see ${STORED}` } }, id: 'e1', timestamp: 't' });
    const setsBefore = fakes.storage.calls.set.length;
    await expect(saveHistoryEntry(entry)).rejects.toMatchObject({
      kind: 'key_echo', message: 'This run contains text that repeats an API key, so it was not saved to history.'
    });
    expect(fakes.storage.calls.set.slice(setsBefore)).toEqual([]);
    expect(await loadHistory()).toEqual([]);
  });

  it('(b) key "a": a saved selection whose dropped subdivision is exactly "a" → refused', async () => {
    await fakes.storage.local.set({ [providerKey('lmstudio')]: { apiKey: 'a', baseURL: 'http://localhost:1234/v1' } });
    const run = builtRun();
    const s1 = run.suggest.suggestions[0];
    const withSub = { ...run, suggest: { ...run.suggest, suggestions: [{ ...s1, heading: `${s1.heading}--a` }, ...run.suggest.suggestions.slice(1)] } };
    expect(selectionsOf(withSub).some((s) => s.droppedSubdivisions.includes('a'))).toBe(true);
    await expect(saveHistoryEntry(buildHistoryEntry({ run: withSub, id: 'e2', timestamp: 't' })))
      .rejects.toMatchObject({ kind: 'key_echo' });
    expect(await loadHistory()).toEqual([]);
  });

  it('(b) key "a": MARC subfield CODES "a" are saved, but a subfield VALUE equal to the key is refused', async () => {
    await fakes.storage.local.set({ [providerKey('lmstudio')]: { apiKey: 'a', baseURL: 'http://localhost:1234/v1' } });
    const run = buildRun(builtRun());
    expect(run.recommendations.some((r) => r.marc.subfields?.some(([code]) => code === 'a'))).toBe(true);
    expect(await saveHistoryEntry(buildHistoryEntry({ run, id: 'codes', timestamp: 't' }))).toHaveLength(1);
    const withValue = {
      ...run,
      recommendations: run.recommendations.map((r, i) => (i === 0 ? { ...r, marc: { ...r.marc, subfields: [['a', 'a']] } } : r))
    };
    await expect(saveHistoryEntry(buildHistoryEntry({ run: withValue, id: 'value', timestamp: 't' })))
      .rejects.toMatchObject({ kind: 'key_echo' });
    expect((await loadHistory()).map((e) => e.id)).toEqual(['codes']);
  });

  it('(c) Copy all and CSV whose final text contains the run\'s key → refused', async () => {
    const KEY7 = 'k7sEcrt';
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const wf = make({
      apiKey: KEY7,
      generateImpl: vi.fn()
        .mockResolvedValueOnce(suggested('Cats'))
        .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] }))
    });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    await wf.lookupAll();
    await wf.select();
    wf.build();
    const state = wf.getState();
    // The export text as it would leave, with the key in a label.
    const recs = state.recommendations.map((r) => ({ ...r, label: `${r.label} (${KEY7})` }));
    const selections = selectionsOf(state);
    for (const text of [copyAllText(recs, selections), recommendationsCsv(recs, selections)]) {
      expect(() => wf.guard('export', text)).toThrow('This text repeats an API key, so it was not copied or exported.');
    }
    // The real recommendations pass.
    expect(wf.guard('export', copyAllText(state.recommendations, selections))).toContain('Cats');
  });
});

// P6 fix 14, finding 4: the AI-selection request is a network exit too.
describe('[P6 fix14] the selection request never carries a known key', () => {
  it('provider C\'s stored key inside a heading → the select request is NOT sent; the step fails with local text', async () => {
    const KEY_C = 'sk-provider-c-key-0042';
    const settings = { lookupBackend: 'loc-api', providers: { custom: { apiKey: KEY_C }, lmstudio: { apiKey: 'run-key-A-12345' } } };
    // The main heading "Cats" is still found, so there is something to select.
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats], 'lcsh keyword "Cats"': [EVIDENCE.cats] });
    const generateImpl = vi.fn()
      .mockResolvedValueOnce(suggested(`Cats--${KEY_C}`))
      .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] }));
    const wf = make({ apiKey: 'run-key-A-12345', settings, generateImpl });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    expect(wf.getState().suggestError).toBeNull();
    await wf.lookupAll();
    expect(wf.getState().lookup.results.s1.candidates.length).toBeGreaterThan(0);
    await wf.select();
    // Only the suggest call: nothing was sent for selection.
    expect(generateImpl).toHaveBeenCalledTimes(1);
    expect(wf.getState().select.error).toEqual({ kind: 'key_echo', message: 'The AI answer repeats an API key, so it was not used.' });
  });

  // P6 fix 15, item 2: the FINISHED prompt is checked too.
  it('a stored key "Cats" (kind: topical) that only the prompt FORMAT assembles → the select request is NOT sent', async () => {
    const ASSEMBLED = 'Cats" (kind: topical)';
    const settings = { lookupBackend: 'loc-api', providers: { custom: { apiKey: ASSEMBLED }, lmstudio: { apiKey: 'run-key-A-12345' } } };
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const generateImpl = vi.fn()
      .mockResolvedValueOnce(suggested('Cats'))
      .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] }));
    const wf = make({ apiKey: 'run-key-A-12345', settings, generateImpl });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    await wf.lookupAll();
    expect(wf.getState().lookup.results.s1.candidates.length).toBeGreaterThan(0);
    await wf.select();
    expect(generateImpl).toHaveBeenCalledTimes(1);
    expect(wf.getState().select.error).toMatchObject({ kind: 'key_echo' });
  });

  it('an ordinary selection request is still sent', async () => {
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const settings = { lookupBackend: 'loc-api', providers: { custom: { apiKey: 'sk-provider-c-key-0042' } } };
    const generateImpl = vi.fn()
      .mockResolvedValueOnce(suggested('Cats'))
      .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] }));
    const wf = make({ apiKey: 'run-key-A-12345', settings, generateImpl });
    await wf.suggest({ bibliographicInfo: { title: 'T' }, rules: '' });
    await wf.lookupAll();
    await wf.select();
    expect(generateImpl).toHaveBeenCalledTimes(2);
    expect(wf.getState().select.error).toBeFalsy();
    expect(wf.getState().run.stage).toBe('selected');
  });
});

describe('[P6 fix13] ordinary runs are unaffected', () => {
  it('key "a": suggest, lookup, select, build, export and history all work', async () => {
    await fakes.storage.local.set({ [providerKey('lmstudio')]: { apiKey: 'a', baseURL: 'http://localhost:1234/v1' } });
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const wf = make({
      apiKey: 'a',
      generateImpl: vi.fn()
        .mockResolvedValueOnce(answer({
          subjectAnalysis: 'A book about a cat and a city.',
          suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'It is a main topic.' }, { heading: 'Cats--Japan', kind: 'topical', reason: 'A place.' }]
        }))
        .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] }))
    });
    await wf.suggest({ bibliographicInfo: { title: 'A cat' }, rules: '' });
    expect(wf.getState().suggestError).toBeNull();
    await wf.lookupAll();
    expect(sentQueries(loc)).toContain('Cats');
    await wf.select();
    wf.build();
    const state = wf.getState();
    expect(state.recommendations).toHaveLength(1);
    const text = copyAllText(state.recommendations, selectionsOf(state));
    expect(wf.guard('export', text)).toBe(text);
    expect(wf.guard('export', recommendationsCsv(state.recommendations, selectionsOf(state)))).toContain('Cats');
    const saved = await saveHistoryEntry(buildHistoryEntry({ run: state, id: 'ok', timestamp: 't' }));
    expect(saved).toHaveLength(1);
  });
});
