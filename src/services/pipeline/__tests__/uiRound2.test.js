/**
 * SPEC-UI2 §13 acceptance coverage at the workflow level: §1 Next, §2 edits
 * and their fences, §3 order after name keys. The lookup backend, the AI
 * and the name-key resolver are fakes the test controls, so every race is
 * driven step by step.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWorkflow } from '../workflow';
import { createRunCache } from '../../lookup/scheduler';
import { ProviderError } from '../../providers/errors';
import {
  selectionsOf, lookupsComplete, isSelectionCurrent, initialRunState, beginSuggest, commitSuggest, beginLookup,
  commitLookup, beginSelect, commitSelect, buildRun, beginNameKeys, commitNameKeys, failNameKeys, editSuggestions
} from '../run';
import { applySuggestionEdit, checkHeading, EDIT_ERRORS, MAX_HEADING_CODE_POINTS } from '../suggestionEdits';
import { MAX_SUGGESTIONS } from '../suggest';
import { KEY } from '../../../../test/fixtures';
import { SUGGESTIONS, RESULTS, C } from '../../../../test/pipelineFixtures';

const CFG = { providerId: 'deepseek', model: 'deepseek-flash', apiKey: KEY, entry: { adapter: 'openai-style' } };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const SUGGESTED = answer({
  subjectAnalysis: 'Cats and dogs.',
  suggestions: [
    { heading: 'Cats', kind: 'topical', reason: 'Topic.' },
    { heading: 'Dogs', kind: 'topical', reason: 'Topic.' }
  ]
});
const local = (localId, label, marcKey, authority = 'lcsh') => ({
  cid: `${authority}:${localId}`, authority, localId, uri: `http://id.loc.gov/authorities/subjects/${localId}`,
  label, marcKey, rdfTypes: [], matchClass: 'exact-full', source: 'local-db', via: 'label'
});
const CATS = local('sh85021262', 'Cats', '150  $aCats');
const DOGS = local('sh85038796', 'Dogs', '150  $aDogs');
const PROVENANCE = { backend: 'local-db', profile: 'core', release: '2026.10.01.1', releaseCommit: 'a'.repeat(40), file: '/db.db' };
const isSelectRequest = (req) => JSON.stringify(req?.schema || {}).includes('selections');
const selection = (choices) => answer({
  selections: Object.entries(choices).map(([suggestionId, choice]) => ({ suggestionId, choice, confidence: 90 })),
  additional: []
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => { setTimeout(r, 0); }); };

/**
 * A workflow with a fake local backend. `byHeading` maps a heading to its
 * candidates (or to a function that returns a promise of them).
 */
const make = ({ byHeading = { Cats: [CATS], Dogs: [DOGS] }, selectImpl, loadConfig, resolveNameKeysImpl } = {}) => {
  let n = 0;
  const selectCalls = [];
  const generateImpl = vi.fn(async (cfg, req) => {
    if (!isSelectRequest(req)) return SUGGESTED;
    selectCalls.push(req);
    return selectImpl ? selectImpl(req, selectCalls.length) : selection({ s1: 's1c1', s2: 's2c1' });
  });
  const backend = () => ({
    id: 'local-db',
    cache: createRunCache(),
    lookup: async (s) => {
      const entry = byHeading[s.heading];
      const candidates = typeof entry === 'function' ? await entry(s) : (entry || []);
      return { suggestionId: s.id, candidates, failures: [], incomplete: false, rejectedHits: 0, requests: [], provenance: PROVENANCE, replacementNotes: [] };
    }
  });
  const wf = createWorkflow({
    loadConfig: loadConfig || (async () => ({ cfg: CFG, settings: { lookupBackend: 'local-db' } })),
    generateImpl,
    createBackend: backend,
    uuid: () => `run-${++n}`,
    ...(resolveNameKeysImpl ? { resolveNameKeysImpl } : {})
  });
  return { wf, generateImpl, selectCalls };
};
const lookedUp = async (opts) => {
  const made = make(opts);
  await made.wf.suggest({ bibliographicInfo: { title: 'Pets' }, rules: '' });
  await made.wf.lookupAll();
  return made;
};
const cidsOf = (wf) => (wf.getState().recommendations || []).map((r) => r.cid);

describe('[UI2 §1] Next: recommendations', () => {
  it('with a CURRENT AI selection, Next builds and advances without asking the AI again', async () => {
    const { wf, selectCalls } = await lookedUp();
    await wf.select();
    expect(isSelectionCurrent(wf.getState())).toBe(true);
    const onAdvance = vi.fn();
    expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(wf.getState().run.stage).toBe('built');
    expect(cidsOf(wf)).toEqual([CATS.cid, DOGS.cid]);
  });

  it('without a current selection, Next runs the selection and advances only after THAT selection committed', async () => {
    const { wf, selectCalls } = await lookedUp();
    expect(isSelectionCurrent(wf.getState())).toBe(false);
    const onAdvance = vi.fn();
    expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(selectionsOf(wf.getState()).map((s) => s.method)).toEqual(['ai', 'ai']);
  });

  it('an automatic exact-only fallback (invalid output) is a completed selection: Next advances, with its disclosure', async () => {
    for (const kind of ['invalid_output', 'truncated', 'too_long']) {
      const { wf, selectCalls } = await lookedUp({ selectImpl: async () => { throw new ProviderError(kind, { provider: 'DeepSeek' }); } });
      const onAdvance = vi.fn();
      expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
      expect(wf.getState().select).toMatchObject({ mode: 'exact-fallback', fallbackKind: kind, error: null });
      expect(onAdvance).toHaveBeenCalledTimes(1);
      // Next again reuses the current fallback rather than asking the AI again
      expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
      expect(selectCalls).toHaveLength(1);
    }
  });

  it('a stop error stays on Matches; "Continue without AI" keeps manual overrides, builds and advances; Next then reuses the fallback', async () => {
    const { wf, selectCalls } = await lookedUp({
      selectImpl: async () => { throw new ProviderError('permission', { host: 'api.deepseek.com' }); }
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wf.choose('s2', null); // manual "Use none"
    const onAdvance = vi.fn();
    expect(await wf.next({ onAdvance })).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().select.error.kind).toBe('permission');
    expect(wf.getState().run.stage).not.toBe('built');
    expect(wf.continueWithoutAiAndAdvance({ onAdvance })).toEqual({ advanced: true });
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(wf.getState().select).toMatchObject({ mode: 'exact-fallback', fallbackKind: 'user' });
    expect(selectionsOf(wf.getState()).map((s) => [s.method, s.cid])).toEqual([['exact', CATS.cid], ['manual', null]]);
    // Back on Matches: Next reuses the current fallback (no new AI call)
    expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(1);
  });

  it('manual choices alone are not a completed selection: Next still runs the AI; the manual choice wins', async () => {
    const { wf, selectCalls } = await lookedUp();
    wf.choose('s1', null);
    expect(isSelectionCurrent(wf.getState())).toBe(false);
    expect(await wf.next()).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(1);
    expect(selectionsOf(wf.getState()).map((s) => [s.method, s.cid])).toEqual([['manual', null], ['ai', DOGS.cid]]);
    expect(cidsOf(wf)).toEqual([DOGS.cid]);
  });

  it('completed partial, failed and no-results lookups do not block Next; a missing result does', () => {
    let { state, token } = beginSuggest(initialRunState(), { runId: 'r', snapshot: null, input: {} });
    state = commitSuggest(state, token, { subjectAnalysis: '', suggestions: SUGGESTIONS, suggestMode: 'json', provenance: {} });
    const begun = beginLookup(state, SUGGESTIONS.map((s) => s.id));
    state = begun.state;
    for (const s of SUGGESTIONS.slice(0, 5)) state = commitLookup(state, begun.tokens[s.id], RESULTS[s.id]);
    expect(lookupsComplete(state)).toBe(false); // s6 still pending
    state = commitLookup(state, begun.tokens.s6, RESULTS.s6);
    expect(['partial', 'failed', 'no-results'].every((o) => Object.values(state.lookup.results).some((r) => r.outcome === o))).toBe(true);
    expect(lookupsComplete(state)).toBe(true);
    // The failed and no-results headings keep their own none reasons
    const sel = beginSelect(state, null);
    state = commitSelect(sel.state, sel.token, { mode: 'ai', choices: {}, additional: [] });
    const reasons = Object.fromEntries(selectionsOf(state).map((s) => [s.suggestionId, s.noneReason]));
    expect(reasons.s4).toBe('no-results');
    expect(reasons.s5).toBe('lookup-failed');
  });

  it('missing results after a cancelled lookup keep Next disabled and do nothing', async () => {
    const gate = deferred();
    const { wf, selectCalls } = make({ byHeading: { Cats: [CATS], Dogs: () => gate.promise } });
    await wf.suggest({ bibliographicInfo: { title: 'Pets' }, rules: '' });
    const running = wf.lookupAll();
    await settle();
    wf.leave('lookup');
    gate.resolve([DOGS]);
    await running;
    expect(wf.getState().lookup.results.s2).toBeUndefined();
    expect(lookupsComplete(wf.getState())).toBe(false);
    const onAdvance = vi.fn();
    expect(await wf.next({ onAdvance })).toEqual({ advanced: false });
    expect(selectCalls).toHaveLength(0);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('no presented candidates: Next commits an empty selection without an AI call and advances', async () => {
    const { wf, selectCalls } = await lookedUp({ byHeading: {} });
    expect(lookupsComplete(wf.getState())).toBe(true);
    expect(await wf.next()).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(0);
    expect(wf.getState().recommendations).toEqual([]);
  });

  it('a double click starts ONE selection and advances once', async () => {
    const gate = deferred();
    const { wf, selectCalls } = await lookedUp({ selectImpl: () => gate.promise });
    const onAdvance = vi.fn();
    const first = wf.next({ onAdvance });
    const second = wf.next({ onAdvance });
    await settle();
    gate.resolve(selection({ s1: 's1c1', s2: 's2c1' }));
    expect(await second).toEqual({ advanced: false });
    expect(await first).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('leaving the view while the configuration loads: nothing is built and nothing navigates', async () => {
    const config = deferred();
    let calls = 0;
    const { wf, selectCalls } = await lookedUp({
      loadConfig: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve({ cfg: CFG, settings: { lookupBackend: 'local-db' } }) : config.promise;
      }
    });
    let owned = true;
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance, stillOwned: () => owned });
    await settle();
    owned = false; // Back / Settings / History
    wf.leave('lookup');
    wf.leave('select');
    config.resolve({ cfg: CFG, settings: { lookupBackend: 'local-db' } });
    expect(await running).toEqual({ advanced: false });
    expect(selectCalls).toHaveLength(0);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().recommendations).toBeNull();
  });

  it('leaving the view during generation: the late answer is not committed, built or followed', async () => {
    const gate = deferred();
    const { wf } = await lookedUp({ selectImpl: () => gate.promise });
    let owned = true;
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance, stillOwned: () => owned });
    await settle();
    owned = false;
    wf.leave('select');
    gate.resolve(selection({ s1: 's1c1', s2: 's2c1' }));
    expect(await running).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().recommendations).toBeNull();
    expect(wf.getState().select.mode).toBeNull();
  });

  it('a view change that keeps the workflow (stillOwned false) also stops the continuation', async () => {
    const gate = deferred();
    const { wf } = await lookedUp({ selectImpl: () => gate.promise });
    let owned = true;
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance, stillOwned: () => owned });
    await settle();
    owned = false; // e.g. History opened: the view epoch changed
    gate.resolve(selection({ s1: 's1c1', s2: 's2c1' }));
    expect(await running).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().run.stage).not.toBe('built');
  });

  it('Cancel during "Choosing headings…" never builds or advances', async () => {
    const { wf } = await lookedUp({
      selectImpl: (req) => new Promise((resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new ProviderError('cancelled', {})));
      })
    });
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance });
    await settle();
    wf.cancelSelect();
    expect(await running).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().select.error).toBeNull();
    expect(wf.getState().recommendations).toBeNull();
  });

  it('a lookup retry during Next stops the old continuation', async () => {
    const gate = deferred();
    const { wf } = await lookedUp({ selectImpl: () => gate.promise });
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance });
    await settle();
    await wf.retryLookup('s1');
    gate.resolve(selection({ s1: 's1c1', s2: 's2c1' }));
    expect(await running).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().recommendations).toBeNull();
  });

  it('"Ask the AI again" reruns the selection without advancing and keeps manual overrides', async () => {
    const { wf, selectCalls } = await lookedUp();
    await wf.select();
    wf.choose('s1', null);
    await wf.askAgain();
    expect(selectCalls).toHaveLength(2);
    expect(wf.getState().run.stage).not.toBe('built');
    expect(selectionsOf(wf.getState())[0]).toMatchObject({ method: 'manual', cid: null });
    expect(isSelectionCurrent(wf.getState())).toBe(true);
  });
});

describe('[UI2 §2] editing the suggestions', () => {
  const SUGGEST = { suggestions: [{ id: 's1', heading: 'Cats', kind: 'topical', reason: 'AI.', source: 'ai' }] };

  it('validation: trimmed, 1–200 code points, a letter or number, no normalized duplicate', () => {
    const list = SUGGEST.suggestions;
    expect(checkHeading('   ', list)).toEqual({ ok: false, error: EDIT_ERRORS.empty });
    expect(checkHeading('--!!', list)).toEqual({ ok: false, error: EDIT_ERRORS.noLetter });
    expect(checkHeading('  Dogs  ', list)).toEqual({ ok: true, heading: 'Dogs' });
    expect(checkHeading('cats', list)).toEqual({ ok: false, error: EDIT_ERRORS.duplicate });
    expect(checkHeading('Cats', list, 's1').ok).toBe(true);
    // Code points, not UTF-16 units: 200 astral letters pass, 201 do not
    const astral = '𠀀';
    expect(checkHeading(astral.repeat(MAX_HEADING_CODE_POINTS), list).ok).toBe(true);
    expect(checkHeading(astral.repeat(MAX_HEADING_CODE_POINTS + 1), list)).toEqual({ ok: false, error: EDIT_ERRORS.tooLong });
    expect(checkHeading('貓', list).ok).toBe(true);
  });

  it('add: a kind is required; at most eight; the new heading is the user\'s with an empty reason', () => {
    expect(applySuggestionEdit(SUGGEST, { type: 'add', heading: 'Dogs' })).toEqual({ ok: false, error: EDIT_ERRORS.kind });
    expect(applySuggestionEdit(SUGGEST, { type: 'add', heading: 'Dogs', kind: 'unknown' })).toEqual({ ok: false, error: EDIT_ERRORS.kind });
    const added = applySuggestionEdit(SUGGEST, { type: 'add', heading: 'Dogs', kind: 'genre' });
    expect(added.suggestions[1]).toEqual({ id: 's2', heading: 'Dogs', kind: 'genre', reason: '', source: 'user' });
    const full = { suggestions: Array.from({ length: MAX_SUGGESTIONS }, (_, i) => ({ id: `s${i + 1}`, heading: `H${i}`, kind: 'topical', reason: '', source: 'ai' })) };
    expect(MAX_SUGGESTIONS).toBe(8);
    expect(applySuggestionEdit(full, { type: 'add', heading: 'More', kind: 'topical' })).toEqual({ ok: false, error: EDIT_ERRORS.full });
  });

  it('edit: a real change makes it the user\'s and clears the AI reason; a same-text Apply is a no-op that keeps authorship', () => {
    const same = applySuggestionEdit(SUGGEST, { type: 'edit', id: 's1', heading: '  Cats ', kind: 'topical' });
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(same.suggestions[0].source).toBe('ai');
    const kindOnly = applySuggestionEdit(SUGGEST, { type: 'edit', id: 's1', heading: 'Cats', kind: 'name' });
    expect(kindOnly.suggestions[0]).toEqual({ id: 's1', heading: 'Cats', kind: 'name', reason: '', source: 'user' });
    // A text-fallback heading may keep `unknown`; others may not take it
    const fallback = { suggestions: [{ id: 's1', heading: 'Cats', kind: 'unknown', reason: '', source: 'ai' }] };
    expect(applySuggestionEdit(fallback, { type: 'edit', id: 's1', heading: 'Kittens' }).suggestions[0]).toMatchObject({ kind: 'unknown', source: 'user' });
    expect(applySuggestionEdit(SUGGEST, { type: 'edit', id: 's1', heading: 'Kittens', kind: 'unknown' })).toEqual({ ok: false, error: EDIT_ERRORS.kind });
    expect(applySuggestionEdit(SUGGEST, { type: 'edit', id: 's9', heading: 'X' })).toEqual({ ok: false, error: EDIT_ERRORS.missing });
  });

  it('the workflow: a no-op or invalid edit leaves the run object unchanged (opening/cancelling a draft never reaches it)', async () => {
    const { wf } = await lookedUp();
    await wf.select();
    const before = wf.getState();
    expect(wf.editSuggestions({ type: 'edit', id: 's1', heading: 'Cats', kind: 'topical' })).toMatchObject({ ok: true, changed: false });
    expect(wf.editSuggestions({ type: 'add', heading: 'cats', kind: 'topical' })).toEqual({ ok: false, error: EDIT_ERRORS.duplicate });
    expect(wf.getState()).toBe(before);
  });

  it('an accepted edit is ONE transition: everything downstream is cleared, the run is back at "suggested", input and provenance kept', async () => {
    const { wf } = await lookedUp();
    await wf.next();
    const before = wf.getState();
    expect(before.run.stage).toBe('built');
    expect(wf.editSuggestions({ type: 'remove', id: 's2' })).toEqual({ ok: true, changed: true });
    const after = wf.getState();
    expect(after.run.stage).toBe('suggested');
    expect(after.run.suggestRevision).toBe(before.run.suggestRevision + 1);
    expect(after.lookup.results).toEqual({});
    expect(after.lookup.pending).toEqual({});
    expect(after.select).toMatchObject({ mode: null, choices: {}, manual: {}, additional: [], error: null, pending: false, completedFor: null });
    expect(after.recommendations).toBeNull();
    expect(after.input).toBe(before.input);
    expect(after.run.snapshots.suggest).toEqual(before.run.snapshots.suggest);
    expect(after.suggest.subjectAnalysis).toBe(before.suggest.subjectAnalysis);
    expect(lookupsComplete(after)).toBe(false);
  });

  it('removing every suggestion is allowed; Lookup has nothing to do and Next stays disabled', async () => {
    const { wf, selectCalls } = await lookedUp();
    wf.editSuggestions({ type: 'remove', id: 's1' });
    wf.editSuggestions({ type: 'remove', id: 's2' });
    expect(wf.getState().suggest.suggestions).toEqual([]);
    await wf.lookupAll();
    expect(lookupsComplete(wf.getState())).toBe(false);
    expect(await wf.next()).toEqual({ advanced: false });
    expect(selectCalls).toHaveLength(0);
  });

  it('ids are never reassigned: remove s2, add → s3; an old s2 token cannot attach', async () => {
    const { wf } = await lookedUp();
    const old = beginLookup(wf.getState(), ['s2']);
    wf.editSuggestions({ type: 'remove', id: 's2' });
    wf.editSuggestions({ type: 'add', heading: 'Birds', kind: 'topical' });
    expect(wf.getState().suggest.suggestions.map((s) => s.id)).toEqual(['s1', 's3']);
    wf.editSuggestions({ type: 'remove', id: 's3' });
    wf.editSuggestions({ type: 'add', heading: 'Fish', kind: 'topical' });
    expect(wf.getState().suggest.suggestions.map((s) => s.id)).toEqual(['s1', 's4']);
    const state = wf.getState();
    expect(commitLookup(state, old.tokens.s2, { suggestionId: 's2', outcome: 'found', candidates: [DOGS] })).toBe(state);
  });

  it('a stale lookup success after an edit is dropped', async () => {
    const gate = deferred();
    const { wf } = make({ byHeading: { Cats: [CATS], Dogs: () => gate.promise } });
    await wf.suggest({ bibliographicInfo: { title: 'Pets' }, rules: '' });
    const running = wf.lookupAll();
    await settle();
    wf.editSuggestions({ type: 'edit', id: 's1', heading: 'Kittens', kind: 'topical' });
    gate.resolve([DOGS]);
    await running;
    expect(wf.getState().lookup.results).toEqual({});
    expect(wf.getState().run.stage).toBe('suggested');
  });

  it('a stale selection success after an edit is dropped, and its Next does not build or navigate', async () => {
    const gate = deferred();
    const { wf } = await lookedUp({ selectImpl: () => gate.promise });
    const onAdvance = vi.fn();
    const running = wf.next({ onAdvance });
    await settle();
    wf.editSuggestions({ type: 'add', heading: 'Birds', kind: 'topical' });
    gate.resolve(selection({ s1: 's1c1', s2: 's2c1' }));
    expect(await running).toEqual({ advanced: false });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(wf.getState().select.mode).toBeNull();
    expect(wf.getState().recommendations).toBeNull();
  });

  it('Next after an edit: the new lookups and a new selection are needed, then it advances', async () => {
    const { wf, selectCalls } = await lookedUp({ byHeading: { Cats: [CATS], Dogs: [DOGS], Birds: [] } });
    await wf.next();
    wf.editSuggestions({ type: 'add', heading: 'Birds', kind: 'topical' });
    expect(await wf.next()).toEqual({ advanced: false });
    await wf.lookupAll();
    const onAdvance = vi.fn();
    expect(await wf.next({ onAdvance })).toEqual({ advanced: true });
    expect(selectCalls).toHaveLength(2);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe('[UI2 §2] name keys and edits (pure transitions)', () => {
  // A local-database name has no MARC key; the name-key operation finds it
  const NAME = { ...C.kurosawa, marcKey: null, source: 'local-db', via: 'label' };
  const prepared = () => {
    const suggestions = [{ id: 's1', heading: 'Kurosawa, Akira', kind: 'name', reason: '', source: 'ai' }];
    let { state, token } = beginSuggest(initialRunState(), { runId: 'r', snapshot: null, input: {} });
    state = commitSuggest(state, token, { subjectAnalysis: '', suggestions, suggestMode: 'json', provenance: {} });
    const begun = beginLookup(state, ['s1']);
    state = commitLookup(begun.state, begun.tokens.s1, { suggestionId: 's1', outcome: 'found', candidates: [NAME], errorKind: null });
    const sel = beginSelect(state, null);
    state = buildRun(commitSelect(sel.state, sel.token, { mode: 'ai', choices: { s1: { cid: NAME.cid, confidence: 90 } }, additional: [] }));
    return beginNameKeys(state);
  };
  const RESOLVED = new Map([[NAME.cid, { marcKey: '1001 $aKurosawa, Akira,$d1910-1998' }]]);

  it('a stale name-key SUCCESS after an edit does not recreate recommendations', () => {
    const { state, token } = prepared();
    // Control: without the edit the same commit is accepted
    expect(commitNameKeys(state, token, RESOLVED).recommendations[0].marc.status).toBe('from-authority');
    const edited = editSuggestions(state, [{ id: 's1', heading: 'Kurosawa', kind: 'name', reason: '', source: 'user' }]);
    expect(edited.recommendations).toBeNull();
    expect(commitNameKeys(edited, token, RESOLVED)).toBe(edited);
  });

  it('a stale name-key FAILURE does not invalidate a newer operation', () => {
    const { state, token } = prepared();
    // Control: its own failure invalidates its own operation
    expect(failNameKeys(state, token).nameKeys.pending).toBe(false);
    const edited = editSuggestions(state, state.suggest.suggestions.map((s) => ({ ...s, heading: 'Kurosawa', source: 'user' })));
    // A newer operation of a later build
    const newer = { ...edited, nameKeys: { ...edited.nameKeys, pending: true, revision: edited.nameKeys.revision + 1 } };
    expect(failNameKeys(newer, token)).toBe(newer);
  });
});

describe('[UI2 §3] order follows the built MARC, recomputed on name-key completion', () => {
  it('a name with no key sorts last; once its key resolves it becomes a 600 and moves first', async () => {
    const NAME = { ...local('n79091264', 'Kurosawa, Akira, 1910-1998', null, 'lcnaf'), uri: 'http://id.loc.gov/authorities/names/n79091264' };
    const gate = deferred();
    const { wf } = await lookedUp({
      byHeading: { Cats: [CATS], Dogs: [NAME] },
      resolveNameKeysImpl: () => gate.promise
    });
    await wf.next();
    expect(cidsOf(wf)).toEqual([CATS.cid, NAME.cid]);
    expect(wf.getState().recommendations[1].marc.status).not.toBe('from-authority');
    gate.resolve(new Map([[NAME.cid, { marcKey: '1001 $aKurosawa, Akira,$d1910-1998' }]]));
    await settle();
    expect(wf.getState().recommendations.map((r) => [r.cid, r.marc.tag])).toEqual([[NAME.cid, '600'], [CATS.cid, '650']]);
  });
});
