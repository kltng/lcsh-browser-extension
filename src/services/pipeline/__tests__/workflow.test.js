import { describe, it, expect, vi } from 'vitest';
import { createWorkflow } from '../workflow';
import { selectionsOf } from '../run';
import { createScheduler } from '../../lookup/scheduler';
import { ProviderError } from '../../providers/errors';
import { KEY, successBody } from '../../../../test/fixtures';
import { fakes, response } from '../../../../test/setup';
import { EVIDENCE, mockLoc } from '../../../../test/locFixtures';

const CFG = { providerId: 'deepseek', model: 'deepseek-flash', apiKey: KEY, entry: { adapter: 'openai-style' } };
const SETTINGS = { lookupBackend: 'loc-api' };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const SUGGESTED = answer({
  subjectAnalysis: 'Cats in Japan.',
  suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'Topic.' }, { heading: 'Zzz', kind: 'topical', reason: 'None.' }]
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const make = (generateImpl, extra = {}) => {
  let n = 0;
  return createWorkflow({
    loadConfig: async () => ({ cfg: CFG, settings: SETTINGS }),
    generateImpl,
    scheduler: createScheduler({ spacingMs: 0, maxInFlight: 8 }),
    uuid: () => `run-${++n}`,
    ...extra
  });
};

describe('[P4 row12] run.js: the workflow controller', () => {
  it('a full run: suggest → lookup → AI select → build; no key in the state', async () => {
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const generateImpl = vi.fn()
      .mockResolvedValueOnce(SUGGESTED)
      .mockResolvedValueOnce(answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 88 }], additional: [] }));
    const wf = make(generateImpl);
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    expect(wf.getState().run).toMatchObject({ runId: 'run-1', stage: 'suggested', snapshots: { suggest: { providerId: 'deepseek', model: 'deepseek-flash' } } });
    await wf.lookupAll();
    expect(wf.getState().run.stage).toBe('looked-up');
    expect(wf.getState().lookup.results.s2.outcome).toBe('no-results');
    await wf.select();
    wf.build();
    const state = wf.getState();
    expect(state.run.stage).toBe('built');
    expect(state.recommendations.map((r) => [r.cid, r.marc.text])).toEqual([['lcsh:sh85021262', '650 _0 $a Cats']]);
    expect(selectionsOf(state)[1]).toMatchObject({ cid: null, noneReason: 'no-results' });
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('abort on unmount: dispose aborts the running step and nothing is committed', async () => {
    let seenSignal;
    const generateImpl = vi.fn((cfg, req) => new Promise((resolve, reject) => {
      seenSignal = req.signal;
      req.signal.addEventListener('abort', () => reject(new ProviderError('cancelled', {})));
    }));
    const wf = make(generateImpl);
    const running = wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    await settle();
    expect(wf.getState().run.stage).toBe('suggesting');
    wf.dispose();
    await running;
    expect(seenSignal.aborted).toBe(true);
    expect(wf.getState().suggest).toBeNull();
    expect(wf.getState().suggestError).toBeNull();
  });

  it('a new suggest aborts the old run; the late old result is dropped', async () => {
    let resolveFirst;
    const generateImpl = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(SUGGESTED);
    const wf = make(generateImpl);
    const first = wf.suggest({ bibliographicInfo: { title: 'A' }, rules: '' });
    await settle();
    await wf.suggest({ bibliographicInfo: { title: 'B' }, rules: '' });
    resolveFirst(answer({ subjectAnalysis: 'OLD', suggestions: [{ heading: 'Old', kind: 'topical', reason: '' }] }));
    await first;
    expect(wf.getState().run.runId).toBe('run-2');
    expect(wf.getState().suggest.subjectAnalysis).toBe('Cats in Japan.');
  });

  it('leaving the Matches step aborts lookups (the requests see the abort)', async () => {
    const signals = [];
    mockLoc({ 'lcsh leftanchored "Cats"': (url, init) => { signals.push(init.signal); return new Promise(() => {}); } });
    const wf = make(vi.fn().mockResolvedValueOnce(SUGGESTED));
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    const lookups = wf.lookupAll();
    await settle();
    wf.leave('lookup');
    await lookups;
    expect(signals[0].aborted).toBe(true);
    expect(wf.getState().lookup.pending).toEqual({});
    expect(wf.getState().lookup.results.s1).toBeUndefined();
  });

  it('a stop error in the AI step is stored (Retry / Settings / Continue without AI)', async () => {
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const generateImpl = vi.fn().mockResolvedValueOnce(SUGGESTED).mockRejectedValueOnce(new ProviderError('permission', { host: 'api.deepseek.com' }));
    const wf = make(generateImpl);
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    await wf.lookupAll();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await wf.select();
    expect(wf.getState().select.error).toEqual({ kind: 'permission', message: expect.stringContaining('api.deepseek.com') });
    wf.continueWithoutAi();
    expect(wf.getState().select.mode).toBe('exact-fallback');
    expect(selectionsOf(wf.getState())[0]).toMatchObject({ method: 'exact', cid: 'lcsh:sh85021262' });
  });

  it('a config error before suggesting is shown, with no run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = make(vi.fn(), { loadConfig: async () => { throw new ProviderError('not_configured', { provider: 'OpenAI', missing: 'no model is chosen' }); } });
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    expect(wf.getState().suggestError).toEqual({ kind: 'not_configured', message: 'OpenAI is not set up: no model is chosen. Open Settings.' });
  });

  it('Retry lookup bypasses the run cache and clears that suggestion\'s manual choice', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const wf = make(vi.fn().mockResolvedValueOnce(SUGGESTED));
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    await wf.lookupAll();
    wf.choose('s1', null);
    expect(wf.getState().select.manual).toEqual({ s1: { cid: null } });
    const before = loc.fetch.mock.calls.length;
    await wf.retryLookup('s1');
    expect(loc.fetch.mock.calls.length).toBe(before + 1);
    expect(wf.getState().select.manual).toEqual({});
  });
});

/** A config loader whose calls resolve (or reject) only when the test says so. */
const deferredLoader = () => {
  const pending = [];
  const loadConfig = vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  return {
    loadConfig,
    resolve: (i, cfg = CFG) => pending[i].resolve({ cfg, settings: SETTINGS }),
    reject: (i, err) => pending[i].reject(err)
  };
};

const TWO_FOUND = answer({
  subjectAnalysis: 'Cats and dogs.',
  suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }, { heading: 'Dogs', kind: 'topical', reason: '' }]
});
const DOGS = { aLabel: 'Dogs', token: 'sh85038796', uri: 'http://id.loc.gov/authorities/subjects/sh85038796', more: { marcKeys: ['150  $aDogs'] } };
const pick = (s1, s2) => answer({
  selections: [{ suggestionId: 's1', choice: s1, confidence: 80 }, { suggestionId: 's2', choice: s2, confidence: 70 }],
  additional: []
});

/** A workflow that has looked up "Cats" (s1) and "Dogs" (s2); later config loads come from `loader`. */
const lookedUpWorkflow = async (generateImpl, loader) => {
  mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats], 'lcsh leftanchored "Dogs"': [DOGS] });
  let first = true;
  const wf = make(generateImpl, {
    loadConfig: (...args) => {
      if (first) {
        first = false;
        return Promise.resolve({ cfg: CFG, settings: SETTINGS });
      }
      return loader.loadConfig(...args);
    }
  });
  await wf.suggest({ bibliographicInfo: { title: 'Pets' }, rules: '' });
  await wf.lookupAll();
  return wf;
};

describe('[P4 row12] run.js: operation identity is reserved before any await (fix-1 #1)', () => {
  it('(a) select A waits for settings; select B starts and finishes; A\'s settings resolve → A commits nothing', async () => {
    const loader = deferredLoader();
    const generateImpl = vi.fn().mockResolvedValueOnce(TWO_FOUND).mockResolvedValueOnce(pick('s1c1', 'none'));
    const wf = await lookedUpWorkflow(generateImpl, loader);
    const a = wf.select();
    const b = wf.select();
    loader.resolve(1);
    await b;
    const afterB = wf.getState();
    expect(afterB.select.choices).toEqual({ s1: { cid: 'lcsh:sh85021262', confidence: 80 }, s2: { cid: null, confidence: 70 } });
    loader.resolve(0);
    await a;
    expect(wf.getState()).toBe(afterB);
    expect(generateImpl).toHaveBeenCalledTimes(2);
  });

  it('(b) leaving Matches while select is preparing → nothing is committed', async () => {
    const loader = deferredLoader();
    const generateImpl = vi.fn().mockResolvedValueOnce(TWO_FOUND);
    const wf = await lookedUpWorkflow(generateImpl, loader);
    const running = wf.select();
    expect(wf.getState().select.pending).toBe(true);
    wf.leave('select');
    loader.resolve(0);
    await running;
    const state = wf.getState();
    expect(state.select).toMatchObject({ pending: false, mode: null, choices: {}, error: null });
    expect(state.run.stage).toBe('looked-up');
    expect(state.run.snapshots.select).toBeNull();
    expect(generateImpl).toHaveBeenCalledTimes(1);
  });

  it('(b2) dispose while select is preparing → nothing is committed', async () => {
    const loader = deferredLoader();
    const wf = await lookedUpWorkflow(vi.fn().mockResolvedValueOnce(TWO_FOUND), loader);
    const running = wf.select();
    wf.dispose();
    loader.resolve(0);
    await running;
    expect(wf.getState().select).toMatchObject({ pending: false, mode: null });
  });

  it('(c) a new run while Suggest is preparing → the old Suggest commits nothing and does not replace the backend', async () => {
    const loader = deferredLoader();
    const generateImpl = vi.fn().mockResolvedValue(SUGGESTED);
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const backends = [];
    const wf = make(generateImpl, {
      loadConfig: loader.loadConfig,
      createBackend: (settings) => {
        const backend = { id: 'loc-api', lookup: vi.fn(async (s) => ({ suggestionId: s.id, candidates: [], failures: [], incomplete: false, rejectedHits: 0, requests: [] })) };
        backends.push(backend);
        return backend;
      }
    });
    const a = wf.suggest({ bibliographicInfo: { title: 'A' }, rules: '' });
    const b = wf.suggest({ bibliographicInfo: { title: 'B' }, rules: '' });
    loader.resolve(1);
    await b;
    loader.resolve(0);
    await a;
    const state = wf.getState();
    expect(state.run.runId).toBe('run-2');
    expect(state.input.title).toBe('B');
    expect(generateImpl).toHaveBeenCalledTimes(1);
    expect(backends).toHaveLength(1);
    await wf.lookupAll();
    expect(backends[0].lookup).toHaveBeenCalled();
    expect(loc.fetch).not.toHaveBeenCalled();
  });

  it('(c2) leaving step 1 while Suggest is preparing → nothing is committed', async () => {
    const loader = deferredLoader();
    const generateImpl = vi.fn().mockResolvedValue(SUGGESTED);
    const wf = make(generateImpl, { loadConfig: loader.loadConfig });
    const running = wf.suggest({ bibliographicInfo: { title: 'A' }, rules: '' });
    wf.leave('suggest');
    loader.resolve(0);
    await running;
    expect(wf.getState().run.stage).toBe('idle');
    expect(wf.getState().suggest).toBeNull();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('(d) a preparation error of a superseded operation is not shown (Suggest and Select)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loader = deferredLoader();
    const wf = make(vi.fn().mockResolvedValue(SUGGESTED), { loadConfig: loader.loadConfig });
    const a = wf.suggest({ bibliographicInfo: { title: 'A' }, rules: '' });
    const b = wf.suggest({ bibliographicInfo: { title: 'B' }, rules: '' });
    loader.resolve(1);
    await b;
    loader.reject(0, new ProviderError('not_configured', { provider: 'OpenAI', missing: 'no model is chosen' }));
    await a;
    expect(wf.getState().suggestError).toBeNull();
    expect(wf.getState().run.stage).toBe('suggested');

    const selLoader = deferredLoader();
    const wf2 = await lookedUpWorkflow(vi.fn().mockResolvedValueOnce(TWO_FOUND).mockResolvedValueOnce(pick('s1c1', 's2c1')), selLoader);
    const sa = wf2.select();
    const sb = wf2.select();
    selLoader.resolve(1);
    await sb;
    selLoader.reject(0, new ProviderError('permission', { host: 'api.deepseek.com' }));
    await sa;
    expect(wf2.getState().select.error).toBeNull();
    expect(wf2.getState().select.mode).toBe('ai');
  });

  it('a current preparation error IS shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loader = deferredLoader();
    const wf = await lookedUpWorkflow(vi.fn().mockResolvedValueOnce(TWO_FOUND), loader);
    const running = wf.select();
    loader.reject(0, new ProviderError('permission', { host: 'api.deepseek.com' }));
    await running;
    expect(wf.getState().select.error).toMatchObject({ kind: 'permission' });
  });
});

describe('[P4 row12] run.js: a lookup retry during the AI step (fix-1 #2, controller level)', () => {
  it('retrying s2 while the AI runs: the late AI result does not restore s2 (same cid in the new list); s1 is kept', async () => {
    let releaseAi;
    const aiAnswer = pick('s1c1', 's2c1');
    const generateImpl = vi.fn()
      .mockResolvedValueOnce(TWO_FOUND)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseAi = () => resolve(aiAnswer); }));
    const loader = { loadConfig: async () => ({ cfg: CFG, settings: SETTINGS }) };
    const wf = await lookedUpWorkflow(generateImpl, loader);
    const selecting = wf.select();
    await settle();
    await wf.retryLookup('s2');
    expect(wf.getState().lookup.results.s2.candidates[0].cid).toBe('lcsh:sh85038796');
    releaseAi();
    await selecting;
    const selections = selectionsOf(wf.getState());
    expect(selections[0]).toMatchObject({ method: 'ai', cid: 'lcsh:sh85021262' });
    expect(selections[1]).toMatchObject({ method: 'none', cid: null, noneReason: 'not-chosen' });
  });
});

describe('[P4 row13] history: the entry describes the input the model received (fix-1 #3)', () => {
  it('submit title A, edit the form to B during Suggest, finish, save → the entry has A', async () => {
    let release;
    const generateImpl = vi.fn(() => new Promise((resolve) => { release = () => resolve(SUGGESTED); }));
    const wf = make(generateImpl);
    const form = { title: 'A', author: 'Author A', abstract: 'About A.', images: [{ data: 'data:image/png;base64,AA', name: 'a.png', type: 'image/png', size: 2 }] };
    const running = wf.suggest({ bibliographicInfo: form, rules: '' });
    await settle();
    // The cataloger edits the form while Suggest runs.
    form.title = 'B';
    form.abstract = 'About B.';
    release();
    await running;
    const { buildHistoryEntry, saveHistoryEntry } = await import('../../history');
    const entry = buildHistoryEntry({ run: wf.getState() });
    expect(entry.bibliographicInfo).toMatchObject({ title: 'A', author: 'Author A', abstract: 'About A.' });
    expect(entry.bibliographicInfo.images).toEqual([{ name: 'a.png', type: 'image/png', size: 2 }]);
    const [saved] = await saveHistoryEntry(entry);
    expect(saved.bibliographicInfo.title).toBe('A');
    expect(JSON.stringify(saved)).not.toContain('data:image');
  });
});

describe('[P4 row13] history: Suggest/Select provenance with a settings change DURING each request (fix-1 #8; P3 row 19 coverage)', () => {
  it('each step keeps the ONE snapshot taken at its start; the saved entry records both providers', async () => {
    const { loadActiveConfig } = await import('../../../context/AppContext');
    const { setActiveProvider, updateProvider } = await import('../../settings');
    const { buildHistoryEntry } = await import('../../history');
    fakes.storage.seed({
      settingsVersion: 2, activeProviderId: 'gemini', lookupBackend: 'loc-api',
      'provider:gemini': { apiKey: KEY, model: 'gemini-2.5-flash' },
      'provider:deepseek': { apiKey: KEY, model: 'deepseek-flash' }
    });
    fakes.permissions.granted.add('https://generativelanguage.googleapis.com/*');
    fakes.permissions.granted.add('https://api.deepseek.com/*');
    mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const locFetch = globalThis.fetch;
    const providerCalls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).startsWith('https://id.loc.gov/')) return locFetch(url, init);
      providerCalls.push({ url, body: JSON.parse(init.body) });
      if (String(url).includes('generativelanguage')) {
        // During the Suggest request: switch provider and change the model.
        await setActiveProvider('deepseek');
        await updateProvider('gemini', { model: 'gemini-3.8-flash' });
        const json = { subjectAnalysis: 'Cats.', suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }] };
        return response(successBody('gemini', JSON.stringify(json)));
      }
      // During the Select request: switch back and change DeepSeek's model.
      await setActiveProvider('gemini');
      await updateProvider('deepseek', { model: 'deepseek-v4-pro' });
      const json = { selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 77 }], additional: [] };
      return response(successBody('openai-style', JSON.stringify(json)));
    });
    const wf = createWorkflow({ loadConfig: loadActiveConfig, scheduler: createScheduler({ spacingMs: 0 }) });
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    expect(wf.getState().run.snapshots.suggest).toEqual({ providerId: 'gemini', model: 'gemini-2.5-flash' });
    expect(providerCalls[0].url).toContain('/models/gemini-2.5-flash:generateContent');
    await wf.lookupAll();
    await wf.select();
    const state = wf.getState();
    expect(state.run.snapshots.select).toEqual({ providerId: 'deepseek', model: 'deepseek-flash' });
    expect(providerCalls[1].url).toBe('https://api.deepseek.com/chat/completions');
    expect(providerCalls[1].body.model).toBe('deepseek-flash');
    expect(providerCalls[1].body.temperature).toBe(0.1);
    expect(fakes.storage.data.get('activeProviderId')).toBe('gemini');
    wf.build();
    const entry = buildHistoryEntry({ run: wf.getState() });
    expect(entry.provenance).toEqual({
      suggest: { providerId: 'gemini', model: 'gemini-2.5-flash' },
      select: { providerId: 'deepseek', model: 'deepseek-flash' }
    });
    expect(entry.recommendations[0].selections).toEqual([{ suggestionId: 's1', method: 'ai', confidence: 77, lexicalSimilarity: 100 }]);
    expect(JSON.stringify(entry)).not.toContain(KEY);
  });
});
