import { describe, it, expect } from 'vitest';
import {
  initialRunState, beginSuggest, commitSuggest, failSuggest, beginLookup, commitLookup, invalidateLookups,
  beginSelect, commitSelect, failSelect, invalidateSelect, continueWithoutAi, setManualChoice, buildRun, selectionsOf, STAGES
} from '../run';
import { C, SUGGESTIONS, RESULTS } from '../../../../test/pipelineFixtures';

const PROV = { providerId: 'gemini', model: 'gemini-2.5-flash' };
const SUGGEST = { subjectAnalysis: 'x', suggestions: SUGGESTIONS.slice(0, 3), suggestMode: 'json', provenance: PROV };

/** A run that has looked up s1..s3. */
const lookedUp = (runId = 'run-1') => {
  let { state, token } = beginSuggest(initialRunState(), { runId, snapshot: PROV, input: { title: 'T' } });
  state = commitSuggest(state, token, SUGGEST);
  const begun = beginLookup(state, ['s1', 's2', 's3']);
  state = begun.state;
  for (const id of ['s1', 's2', 's3']) state = commitLookup(state, begun.tokens[id], RESULTS[id]);
  return state;
};

const selected = () => {
  const { state, token } = beginSelect(lookedUp(), PROV);
  return commitSelect(state, token, { mode: 'ai', choices: { s1: { cid: C.mpjh.cid, confidence: 85 } }, additional: [] });
};

describe('[P4 row12] run.js: stages and stale runs', () => {
  it('idle → suggesting → suggested → looking-up → looked-up → selecting → selected → built', () => {
    expect(STAGES).toEqual(['idle', 'suggesting', 'suggested', 'looking-up', 'looked-up', 'selecting', 'selected', 'built']);
    let { state, token } = beginSuggest(initialRunState(), { runId: 'r1', snapshot: PROV, input: {} });
    expect(state.run.stage).toBe('suggesting');
    state = commitSuggest(state, token, SUGGEST);
    expect(state.run.stage).toBe('suggested');
    const begun = beginLookup(state, ['s1', 's2', 's3']);
    expect(begun.state.run.stage).toBe('looking-up');
    state = lookedUp();
    expect(state.run.stage).toBe('looked-up');
    const sel = beginSelect(state, PROV);
    expect(sel.state.run.stage).toBe('selecting');
    expect(sel.state.run.snapshots.select).toEqual(PROV);
    state = commitSelect(sel.state, sel.token, { mode: 'ai', choices: {}, additional: [] });
    expect(state.run.stage).toBe('selected');
    expect(buildRun(state).run.stage).toBe('built');
  });

  it('a stale runId is dropped (suggest, lookup and select results)', () => {
    const old = beginSuggest(initialRunState(), { runId: 'old', snapshot: PROV, input: {} });
    const fresh = beginSuggest(old.state, { runId: 'new', snapshot: PROV, input: {} });
    expect(commitSuggest(fresh.state, old.token, SUGGEST)).toBe(fresh.state);
    expect(failSuggest(fresh.state, old.token, { kind: 'auth', message: 'x' })).toBe(fresh.state);
    const state = lookedUp('A');
    const staleLookup = { runId: 'B', suggestionId: 's1', revision: state.lookup.revisions.s1 + 1 };
    const retry = beginLookup(state, ['s1']);
    expect(commitLookup(retry.state, { ...staleLookup, revision: retry.tokens.s1.revision }, RESULTS.s1)).toBe(retry.state);
    const sel = beginSelect(state, PROV);
    expect(commitSelect(sel.state, { ...sel.token, runId: 'B' }, { mode: 'ai', choices: {}, additional: [] })).toBe(sel.state);
  });

  it('same run: a late lookup result of an older revision is dropped', () => {
    const state = lookedUp();
    const first = beginLookup(state, ['s1']);
    const second = beginLookup(first.state, ['s1']);
    expect(commitLookup(second.state, first.tokens.s1, RESULTS.s1)).toBe(second.state);
    const committed = commitLookup(second.state, second.tokens.s1, RESULTS.s1);
    expect(committed.lookup.results.s1).toBe(RESULTS.s1);
  });

  it('same run: a late AI result of an older revision is dropped; leaving the step invalidates it', () => {
    const first = beginSelect(lookedUp(), PROV);
    const second = beginSelect(first.state, PROV);
    const late = { mode: 'ai', choices: { s1: { cid: C.mp.cid, confidence: 1 } }, additional: [] };
    expect(commitSelect(second.state, first.token, late)).toBe(second.state);
    const left = invalidateSelect(second.state);
    expect(left.run.stage).toBe('looked-up');
    expect(commitSelect(left, second.token, late)).toBe(left);
    expect(failSelect(left, second.token, { kind: 'auth', message: 'x' })).toBe(left);
  });

  it('leaving the lookup step invalidates pending lookups (the run stays current)', () => {
    let { state, token } = beginSuggest(initialRunState(), { runId: 'r', snapshot: PROV, input: {} });
    state = commitSuggest(state, token, SUGGEST);
    const begun = beginLookup(state, ['s1', 's2', 's3']);
    state = commitLookup(begun.state, begun.tokens.s1, RESULTS.s1);
    state = invalidateLookups(state);
    expect(state.run.runId).toBe('r');
    expect(state.run.stage).toBe('looked-up');
    expect(commitLookup(state, begun.tokens.s2, RESULTS.s2)).toBe(state);
  });

  it('a manual choice made during AI selection survives the AI result', () => {
    const sel = beginSelect(lookedUp(), PROV);
    const withManual = setManualChoice(sel.state, 's1', C.mp.cid);
    const done = commitSelect(withManual, sel.token, { mode: 'ai', choices: { s1: { cid: C.mpjh.cid, confidence: 90 } }, additional: [] });
    expect(selectionsOf(done)[0]).toMatchObject({ method: 'manual', cid: C.mp.cid });
    const noneDuring = commitSelect(setManualChoice(sel.state, 's1', null), sel.token, { mode: 'ai', choices: { s1: { cid: C.mpjh.cid, confidence: 90 } }, additional: [] });
    expect(selectionsOf(noneDuring)[0]).toMatchObject({ method: 'manual', cid: null, noneReason: 'manual-none' });
  });

  it('retrying the AI step clears the AI selections but keeps manual choices', () => {
    const state = setManualChoice(selected(), 's3', C.japanN.cid);
    const again = beginSelect(state, PROV);
    expect(again.state.select.choices).toEqual({});
    expect(again.state.select.manual).toEqual({ s3: { cid: C.japanN.cid } });
  });

  it('a per-suggestion retry clears ONLY that suggestion\'s selection, including a manual choice', () => {
    let state = setManualChoice(selected(), 's1', C.mp.cid);
    state = setManualChoice(state, 's3', C.japanN.cid);
    const retry = beginLookup(state, ['s1']);
    expect(retry.state.select.manual).toEqual({ s3: { cid: C.japanN.cid } });
    expect(retry.state.select.choices).toEqual({});
    expect(retry.state.lookup.results.s1).toBeUndefined();
    expect(retry.state.lookup.results.s2).toBe(RESULTS.s2);
    expect(retry.state.run.stage).toBe('selected');
  });

  it('a choice change regenerates built recommendations', () => {
    const built = buildRun(selected());
    expect(built.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid]);
    const changed = setManualChoice(built, 's3', C.japanN.cid);
    expect(changed.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid, C.japanN.cid]);
    const none = setManualChoice(changed, 's1', null);
    expect(none.recommendations.map((r) => r.cid)).toEqual([C.japanN.cid]);
    const retried = beginLookup(none, ['s3']);
    expect(retried.state.recommendations).toEqual([]);
  });

  it('only a candidate of that suggestion can be chosen manually', () => {
    const state = selected();
    expect(setManualChoice(state, 's1', C.japanN.cid)).toBe(state);
    expect(setManualChoice(state, 's9', null)).toBe(state);
  });

  it('a new suggest clears lookup, selection and recommendations', () => {
    const built = buildRun(setManualChoice(selected(), 's3', C.japanN.cid));
    const next = beginSuggest(built, { runId: 'run-2', snapshot: PROV, input: {} }).state;
    // UI2 §2: the suggestion revision is monotonic across runs (the old run's + 1).
    expect(next.run).toEqual({
      runId: 'run-2', stage: 'suggesting', snapshots: { suggest: PROV, select: null }, suggestRevision: built.run.suggestRevision + 1
    });
    expect(next.suggest).toBeNull();
    expect(next.lookup.results).toEqual({});
    expect(next.select.manual).toEqual({});
    expect(next.recommendations).toBeNull();
    expect(next.lookup.revisions.s1).toBe(built.lookup.revisions.s1);
  });

  it('Continue without AI applies the exact-only fallback', () => {
    const sel = beginSelect(lookedUp(), PROV);
    const stopped = failSelect(sel.state, sel.token, { kind: 'auth', message: 'Rejected.' });
    expect(stopped.select.error).toEqual({ kind: 'auth', message: 'Rejected.' });
    const cont = continueWithoutAi(stopped);
    expect(cont.run.stage).toBe('selected');
    expect(cont.select.mode).toBe('exact-fallback');
    expect(selectionsOf(cont).map((s) => [s.method, s.noneReason])).toEqual([['exact', null], ['none', 'ai-unavailable'], ['none', 'ai-unavailable']]);
  });
});

describe('[P4 row12] run.js: a lookup retry during a pending selection (fix-1 #2)', () => {
  const AI = {
    mode: 'ai',
    choices: { s1: { cid: C.mpjh.cid, confidence: 85 }, s3: { cid: C.japanN.cid, confidence: 60 } },
    additional: [{ cid: C.japanHistory.cid, confidence: 40, suggestionId: 's3' }, { cid: C.mp.cid, confidence: 30, suggestionId: 's1' }]
  };

  it('retry s3 while the AI runs → the late result does not restore s3 (even with the same cid); s1 is kept', () => {
    const sel = beginSelect(lookedUp(), PROV);
    const retry = beginLookup(sel.state, ['s3']);
    // The retried list holds the SAME candidates (same cids) as before.
    const relooked = commitLookup(retry.state, retry.tokens.s3, RESULTS.s3);
    const done = commitSelect(relooked, sel.token, AI);
    expect(done.select.choices).toEqual({ s1: { cid: C.mpjh.cid, confidence: 85 } });
    expect(done.select.additional).toEqual([{ cid: C.mp.cid, confidence: 30, suggestionId: 's1' }]);
    const selections = selectionsOf(done);
    expect(selections[0]).toMatchObject({ method: 'ai', cid: C.mpjh.cid });
    expect(selections[2]).toMatchObject({ method: 'none', cid: null, noneReason: 'not-chosen' });
  });

  it('a retry still pending at commit time also rejects that suggestion\'s choice', () => {
    const sel = beginSelect(lookedUp(), PROV);
    const retry = beginLookup(sel.state, ['s3']);
    const done = commitSelect(retry.state, sel.token, AI);
    expect(Object.keys(done.select.choices)).toEqual(['s1']);
  });

  it('the exact-only fallback of the AI step is filtered the same way', () => {
    const sel = beginSelect(lookedUp(), PROV);
    const retry = beginLookup(sel.state, ['s1']);
    const relooked = commitLookup(retry.state, retry.tokens.s1, RESULTS.s1);
    const done = commitSelect(relooked, sel.token, { mode: 'exact-fallback', choices: { s1: { cid: C.mpjh.cid }, s3: { cid: null } }, additional: [] });
    expect(done.select.choices).toEqual({ s3: { cid: null } });
  });

  it('recommendations regenerate after commitSelect', () => {
    const built = buildRun(selected());
    expect(built.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid]);
    const again = beginSelect(built, PROV);
    // The AI choices are cleared at start; the built recommendations follow.
    expect(again.state.recommendations).toEqual([]);
    const done = commitSelect(again.state, again.token, AI);
    // SPEC-UI2 §3: MARC-tag order (650s first, then 651s), canonical order within a tag.
    expect(done.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid, C.mp.cid, C.japanN.cid, C.japanHistory.cid]);
  });

  it('recommendations regenerate after continueWithoutAi', () => {
    const built = buildRun(selected());
    const again = beginSelect(built, PROV);
    const stopped = failSelect(again.state, again.token, { kind: 'auth', message: 'x' });
    const cont = continueWithoutAi(stopped);
    expect(cont.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid]);
    expect(cont.recommendations[0].selections).toEqual([{ suggestionId: 's1', method: 'exact', confidence: null, lexicalSimilarity: 100 }]);
  });

  it('recommendations stay unbuilt (null) when they were never built', () => {
    const sel = beginSelect(lookedUp(), PROV);
    expect(commitSelect(sel.state, sel.token, AI).recommendations).toBeNull();
    expect(continueWithoutAi(lookedUp()).recommendations).toBeNull();
  });
});

describe('[P4 row12] run.js: a lookup retry drops the additional picks of that suggestion (fix-2)', () => {
  /** Committed + built: AI choice s1, additional picks from s3 (Japan--History) and s1 (Motion pictures). */
  const builtWithAdditional = (results = RESULTS) => {
    let { state, token } = beginSuggest(initialRunState(), { runId: 'r', snapshot: PROV, input: {} });
    state = commitSuggest(state, token, SUGGEST);
    const begun = beginLookup(state, ['s1', 's2', 's3']);
    state = begun.state;
    for (const id of ['s1', 's2', 's3']) state = commitLookup(state, begun.tokens[id], results[id]);
    const sel = beginSelect(state, PROV);
    state = commitSelect(sel.state, sel.token, {
      mode: 'ai',
      choices: { s1: { cid: C.mpjh.cid, confidence: 85 } },
      additional: [{ cid: C.japanHistory.cid, confidence: 40, suggestionId: 's3' }, { cid: C.mp.cid, confidence: 30, suggestionId: 's1' }]
    });
    return buildRun(state);
  };
  const recCids = (state) => state.recommendations.map((r) => r.cid);

  it('(1) retry s3 → its pick disappears and stays gone when the retried list returns the SAME cid; the s1 pick remains', () => {
    const built = builtWithAdditional();
    // SPEC-UI2 §3: MARC-tag order (650 mpjh, 650 mp, then 651 Japan--History).
    expect(recCids(built)).toEqual([C.mpjh.cid, C.mp.cid, C.japanHistory.cid]);
    const retry = beginLookup(built, ['s3']);
    expect(retry.state.select.additional).toEqual([{ cid: C.mp.cid, confidence: 30, suggestionId: 's1' }]);
    expect(recCids(retry.state)).toEqual([C.mpjh.cid, C.mp.cid]);
    const relooked = commitLookup(retry.state, retry.tokens.s3, RESULTS.s3);
    expect(relooked.lookup.results.s3.candidates.map((c) => c.cid)).toContain(C.japanHistory.cid);
    expect(relooked.select.additional).toEqual([{ cid: C.mp.cid, confidence: 30, suggestionId: 's1' }]);
    expect(recCids(relooked)).toEqual([C.mpjh.cid, C.mp.cid]);
  });

  it('(2) the pick stays gone when ANOTHER suggestion\'s list contains that cid', () => {
    const results = { ...RESULTS, s2: { ...RESULTS.s2, candidates: [...RESULTS.s2.candidates, C.japanHistory] } };
    const built = builtWithAdditional(results);
    const retry = beginLookup(built, ['s3']);
    const relooked = commitLookup(retry.state, retry.tokens.s3, results.s3);
    expect(relooked.lookup.results.s2.candidates.map((c) => c.cid)).toContain(C.japanHistory.cid);
    expect(relooked.select.additional.map((a) => a.cid)).toEqual([C.mp.cid]);
    expect(recCids(relooked)).toEqual([C.mpjh.cid, C.mp.cid]);
  });

  it('retrying s1 drops its own choice and pick; the unaffected s3 pick remains and recommendations regenerate', () => {
    const retry = beginLookup(builtWithAdditional(), ['s1']);
    expect(retry.state.select.additional).toEqual([{ cid: C.japanHistory.cid, confidence: 40, suggestionId: 's3' }]);
    expect(recCids(retry.state)).toEqual([C.japanHistory.cid]);
    const relooked = commitLookup(retry.state, retry.tokens.s1, RESULTS.s1);
    expect(recCids(relooked)).toEqual([C.japanHistory.cid]);
  });
});
