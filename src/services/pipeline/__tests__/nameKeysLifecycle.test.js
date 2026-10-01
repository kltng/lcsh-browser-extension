import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createWorkflow } from '../workflow';
import { resolveNameKeys } from '../nameKeys';
import { createScheduler, createRunCache } from '../../lookup/scheduler';
import AppContext, { AppProvider, useAppContext, STEP_OPERATIONS } from '../../../context/AppContext';
import { buildAndShowRecommendations } from '../../../components/ScrapedResults';
import FinalRecommendations, { hasUnresolvedNameKeys } from '../../../components/FinalRecommendations';
import { KEY } from '../../../../test/fixtures';
import { response } from '../../../../test/setup';
import { hit, mockLoc } from '../../../../test/locFixtures';

/**
 * SPEC-P5 §7 — the name-key operation is aborted and invalidated ONLY by a new
 * run, a relevant lookup retry, a changed choice, or disposal. Never by a step
 * change.
 *
 * Live finding (§13 row 3, full database, release 2026.10.01.1): "Build
 * recommendations" started the operation and then left the Matches step,
 * whose `leave('select')` aborted it before its first request. Every local
 * LCNAF recommendation stayed "MARC not available (no key)" until the user
 * clicked "Retry name MARC keys".
 */

const CFG = { providerId: 'deepseek', model: 'deepseek-flash', apiKey: KEY, entry: { adapter: 'openai-style' } };
const PROVENANCE = { backend: 'local-db', profile: 'full', release: '2026.10.01.1', releaseCommit: 'a'.repeat(40), file: '/db.db' };

const localName = (localId, label) => ({
  cid: `lcnaf:${localId}`, authority: 'lcnaf', localId, uri: `http://id.loc.gov/authorities/names/${localId}`,
  label, marcKey: null, rdfTypes: [], matchClass: 'exact-full', source: 'local-db', via: 'label'
});
const KURO = localName('n79091264', 'Kurosawa, Akira, 1910-1998');
const MIFUNE = localName('n85128374', 'Mifune, Toshirō, 1920-1997');

const KURO_HIT = hit('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', { marcKey: '1001 $aKurosawa, Akira,$d1910-1998' });
const MIFUNE_HIT = hit('lcnaf', 'n85128374', 'Mifune, Toshirō, 1920-1997', { marcKey: '1001 $aMifune, Toshirō,$d1920-1997' });
const KURO_KEY = 'lcnaf leftanchored "Kurosawa, Akira, 1910-1998"';
const MIFUNE_KEY = 'lcnaf leftanchored "Mifune, Toshirō, 1920-1997"';
const KURO_MARC = '600 10 $a Kurosawa, Akira, $d 1910-1998';
const MIFUNE_MARC = '600 10 $a Mifune, Toshirō, $d 1920-1997';

const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const SUGGESTED = answer({
  subjectAnalysis: 'Interviews with a film director.',
  suggestions: [
    { heading: 'Kurosawa, Akira', kind: 'name', reason: 'Director.' },
    { heading: 'Mifune, Toshirō', kind: 'name', reason: 'Actor.' }
  ]
});

/** The default candidate lists per suggestion. */
const DEFAULT_CANDIDATES = { s1: [KURO, MIFUNE], s2: [MIFUNE] };

/** The local backend of an installed FULL database: names come back with no MARC key. */
const localBackend = (candidates = DEFAULT_CANDIDATES) => ({
  id: 'local-db',
  cache: createRunCache(),
  lookup: async (s) => ({
    suggestionId: s.id,
    candidates: candidates[s.id] || [],
    failures: [], incomplete: false, rejectedHits: 0, requests: [],
    provenance: PROVENANCE, replacementNotes: []
  })
});

/** An AI selection answer: `choices` maps suggestion id → presented id or 'none'. */
const selection = (choices) => answer({
  selections: Object.entries(choices).map(([suggestionId, choice]) => ({ suggestionId, choice, confidence: 90 })),
  additional: []
});
const isSelectRequest = (req) => JSON.stringify(req?.schema || {}).includes('selections');

const waitFor = async (predicate, ms = 2500) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  return predicate();
};

/**
 * A real workflow up to the moment before "Build recommendations": suggest,
 * a local lookup, and manual choices. `calls` records every name-key
 * operation's signal; the REAL resolver does the work.
 */
const readyToBuild = async ({
  choose = [['s1', KURO.cid], ['s2', MIFUNE.cid]], candidates = DEFAULT_CANDIDATES, selectAnswers = []
} = {}) => {
  const calls = [];
  let n = 0;
  const queue = [...selectAnswers];
  const wf = createWorkflow({
    loadConfig: async () => ({ cfg: CFG, settings: { lookupBackend: 'local-db' } }),
    // The suggest call gets SUGGESTED; each AI selection call takes the next answer.
    generateImpl: vi.fn(async (cfg, req) => (isSelectRequest(req) ? queue.shift() : SUGGESTED)),
    createBackend: () => localBackend(candidates),
    scheduler: createScheduler({ spacingMs: 0, maxInFlight: 8 }),
    uuid: () => `run-${++n}`,
    resolveNameKeysImpl: (args) => {
      calls.push(args);
      return resolveNameKeys(args);
    }
  });
  await wf.suggest({ bibliographicInfo: { title: 'Akira Kurosawa : interviews' }, rules: '' });
  await wf.lookupAll();
  for (const [suggestionId, cid] of choose) wf.choose(suggestionId, cid);
  expect(wf.getState().recommendations).toBeNull();
  return { wf, calls };
};

const marcTexts = (wf) => (wf.getState().recommendations || []).map((r) => r.marc.text);

describe('[P5 fix4] leaving the Matches step does not stop the name-key operation', () => {
  // (a) workflow level, in the order handleBuild produces: build, then
  // STEP_OPERATIONS[2] = ['lookup', 'select'] are left.
  it('leave(lookup) and leave(select) right after build() keep the requests alive; the keys are committed and the MARC fields built', async () => {
    const loc = mockLoc({ [KURO_KEY]: [KURO_HIT], [MIFUNE_KEY]: [MIFUNE_HIT] });
    const { wf, calls } = await readyToBuild();

    wf.build();
    wf.leave('lookup');
    wf.leave('select');

    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted, 'leaving a step must not abort the name-key requester').toBe(false);
    expect(wf.getState().nameKeys.pending).toBe(true);

    expect(await waitFor(() => !wf.getState().nameKeys.pending)).toBe(true);
    expect(calls[0].signal.aborted).toBe(false);
    expect(loc.keys().sort()).toEqual([KURO_KEY, MIFUNE_KEY].sort());
    expect(wf.getState().nameKeys.keys).toEqual({
      [KURO.cid]: '1001 $aKurosawa, Akira,$d1910-1998',
      [MIFUNE.cid]: '1001 $aMifune, Toshirō,$d1920-1997'
    });
    expect(marcTexts(wf)).toEqual([KURO_MARC, MIFUNE_MARC]);
    expect(wf.getState().recommendations.every((r) => r.marcKeySource === 'loc-api')).toBe(true);
  });

  // (b) the real user path: the provider's own setActiveStep, the real
  // STEP_OPERATIONS mapping and the real "Build recommendations" handler.
  it('the AppContext path — Build recommendations leaves step 2 — keeps the operation running and commits its result', async () => {
    const loc = mockLoc({ [KURO_KEY]: [KURO_HIT], [MIFUNE_KEY]: [MIFUNE_HIT] });
    // The run state just before the build, produced by the real pipeline.
    const { wf: source } = await readyToBuild();

    let ctx = null;
    const Capture = () => {
      ctx = useAppContext();
      return null;
    };
    renderToString(React.createElement(AppProvider, null, React.createElement(Capture)));
    const { workflow, setActiveStep } = ctx;
    workflow.replaceState(source.getState());
    const leave = vi.spyOn(workflow, 'leave');

    // The user is on Matches (step 2) and clicks "Build recommendations".
    setActiveStep(2);
    leave.mockClear();
    buildAndShowRecommendations(workflow, setActiveStep);

    // That click really left step 2 through the real mapping.
    expect(STEP_OPERATIONS[2]).toEqual(['lookup', 'select']);
    expect(leave.mock.calls.map((c) => c[0])).toEqual(STEP_OPERATIONS[2]);
    expect(workflow.getState().nameKeys.pending).toBe(true);

    // The page scheduler spaces its requests, so allow it time.
    expect(await waitFor(() => marcTexts(workflow).every((t) => t !== null), 4000)).toBe(true);
    expect(loc.keys().sort()).toEqual([KURO_KEY, MIFUNE_KEY].sort());
    expect(marcTexts(workflow)).toEqual([KURO_MARC, MIFUNE_MARC]);
    expect(workflow.getState().nameKeys.pending).toBe(false);
    leave.mockRestore();
  }, 10000);
});

describe('[P5 fix4] the §7 abort cases still abort and invalidate', () => {
  /** id.loc.gov answers only when released, so the operation is in flight. */
  const heldLoc = () => {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const loc = mockLoc({
      [KURO_KEY]: async () => { await released; return response({ hits: [KURO_HIT] }); },
      [MIFUNE_KEY]: async () => { await released; return response({ hits: [MIFUNE_HIT] }); }
    });
    return { loc, release };
  };

  const startedOperation = async () => {
    const held = heldLoc();
    const env = await readyToBuild({ choose: [['s1', KURO.cid]] });
    env.wf.build();
    await waitFor(() => held.loc.fetch.mock.calls.length > 0);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].signal.aborted).toBe(false);
    return { ...env, ...held };
  };

  it('a NEW run aborts it, and nothing of it is committed', async () => {
    const { wf, calls, release } = await startedOperation();
    const next = wf.suggest({ bibliographicInfo: { title: 'Another record' }, rules: '' });
    expect(calls[0].signal.aborted).toBe(true);
    release();
    await next;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.keys).toEqual({});
    expect(wf.getState().recommendations).toBeNull();
  });

  it('a lookup RETRY aborts it, and its key is not committed', async () => {
    const { wf, calls, release } = await startedOperation();
    const retry = wf.retryLookup('s1');
    expect(calls[0].signal.aborted).toBe(true);
    release();
    await retry;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.keys[KURO.cid]).toBeUndefined();
  });

  it('a CHANGED choice aborts it; only the new choice is resolved', async () => {
    const { wf, calls, release } = await startedOperation();
    wf.choose('s1', MIFUNE.cid);
    expect(calls[0].signal.aborted).toBe(true);
    // A newly chosen unresolved name starts a NEW operation.
    expect(calls).toHaveLength(2);
    expect(calls[1].targets.map((t) => t.cid)).toEqual([MIFUNE.cid]);
    expect(calls[1].signal.aborted).toBe(false);
    release();
    expect(await waitFor(() => !wf.getState().nameKeys.pending)).toBe(true);
    expect(wf.getState().nameKeys.keys[KURO.cid]).toBeUndefined();
    expect(wf.getState().nameKeys.keys[MIFUNE.cid]).toBe('1001 $aMifune, Toshirō,$d1920-1997');
    expect(marcTexts(wf)).toEqual([MIFUNE_MARC]);
  });

  it('DISPOSAL aborts it, and nothing is committed', async () => {
    const { wf, calls, release } = await startedOperation();
    wf.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    expect(wf.getState().nameKeys.pending).toBe(false);
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.keys).toEqual({});
  });

  it('leaving the select step STILL aborts and invalidates a running AI selection (unchanged)', async () => {
    mockLoc({});
    let selectSignal = null;
    // A pending AI selection: its provider call answers only by being aborted.
    const wf = createWorkflow({
      loadConfig: async () => ({ cfg: CFG, settings: { lookupBackend: 'local-db' } }),
      generateImpl: vi.fn(async (cfg, req) => {
        if (!JSON.stringify(req.schema || {}).includes('selections')) return SUGGESTED;
        selectSignal = req.signal;
        return new Promise((resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'cancelled' })));
        });
      }),
      createBackend: () => localBackend(),
      scheduler: createScheduler({ spacingMs: 0, maxInFlight: 8 })
    });
    await wf.suggest({ bibliographicInfo: { title: 'x' }, rules: '' });
    await wf.lookupAll();
    const selecting = wf.select();
    expect(await waitFor(() => selectSignal !== null)).toBe(true);
    expect(wf.getState().select.pending).toBe(true);
    wf.leave('select');
    expect(selectSignal.aborted).toBe(true);
    expect(wf.getState().select.pending).toBe(false);
    await selecting;
  });
});

/**
 * Review-4 finding 1: a changed EFFECTIVE choice must abort AND invalidate the
 * name-key operation whether or not a replacement operation starts. Before,
 * the old operation was invalidated only as a side effect of starting a new
 * one; with no new target it stayed `pending` for ever, and "Retry name MARC
 * keys" stayed disabled.
 */
describe('[P5 fix5] a changed choice always settles the old name-key operation', () => {
  /** The Recommendations step as the user sees it. */
  const retryButton = (wf) => {
    const html = renderToString(React.createElement(
      AppContext.Provider,
      { value: { run: wf.getState(), workflow: wf, setActiveStep: vi.fn(), saveRunToHistory: vi.fn() } },
      React.createElement(FinalRecommendations)
    ));
    const label = html.indexOf('Retry name MARC keys');
    if (label < 0) return null;
    // Exactly this button: from its own opening tag up to its label.
    return html.slice(html.lastIndexOf('<button', label), label);
  };

  // (a)
  it('A changed to "Use none" while B has a recorded failure: not pending, B offered, Retry enabled and working', async () => {
    let mifuneFails = true;
    let releaseKuro;
    const kuroHeld = new Promise((resolve) => { releaseKuro = resolve; });
    const loc = mockLoc({
      [KURO_KEY]: async () => { await kuroHeld; return response({ hits: [KURO_HIT] }); },
      [MIFUNE_KEY]: async () => (mifuneFails ? response('', { status: 500 }) : response({ hits: [MIFUNE_HIT] }))
    });
    // B is chosen and built first; its key lookup FAILS and the reason is recorded.
    const { wf, calls } = await readyToBuild({ choose: [['s2', MIFUNE.cid]] });
    wf.build();
    expect(await waitFor(() => !wf.getState().nameKeys.pending)).toBe(true);
    expect(wf.getState().nameKeys.reasons[MIFUNE.cid]).toBe('Name MARC-key lookup failed');

    // Back on Matches, A is chosen: an operation for A alone starts (B's
    // recorded reason keeps it out of ordinary regeneration).
    wf.choose('s1', KURO.cid);
    expect(await waitFor(() => loc.keys().includes(KURO_KEY))).toBe(true);
    const forA = calls.at(-1);
    expect(forA.targets.map((t) => t.cid)).toEqual([KURO.cid]);
    expect(wf.getState().nameKeys.pending).toBe(true);

    // The user changes A to "Use none": NO replacement operation can start.
    wf.choose('s1', null);
    expect(forA.signal.aborted).toBe(true);
    expect(wf.getState().nameKeys.pending).toBe(false);
    // The cancelled answer arriving later changes nothing.
    releaseKuro();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.pending).toBe(false);
    expect(wf.getState().nameKeys.keys[KURO.cid]).toBeUndefined();

    // B is still offered, and the Retry button is ENABLED.
    expect(wf.getState().recommendations.map((r) => r.cid)).toEqual([MIFUNE.cid]);
    expect(hasUnresolvedNameKeys(wf.getState().recommendations)).toBe(true);
    const button = retryButton(wf);
    expect(button).not.toBeNull();
    expect(button).not.toContain('disabled');

    // ...and Retry works.
    mifuneFails = false;
    wf.retryNameKeys();
    expect(await waitFor(() => wf.getState().recommendations[0].marc.status === 'from-authority')).toBe(true);
    expect(marcTexts(wf)).toEqual([MIFUNE_MARC]);
    expect(wf.getState().nameKeys.pending).toBe(false);
  });

  // (b) — an AI selection
  it('an AI selection that leaves NO new targets aborts the old operation and leaves it not pending', async () => {
    const { loc, release } = (() => {
      let open;
      const held = new Promise((resolve) => { open = resolve; });
      return {
        loc: mockLoc({ [KURO_KEY]: async () => { await held; return response({ hits: [KURO_HIT] }); } }),
        release: open
      };
    })();
    // The AI first chooses Kurosawa (s1c1), then — re-run — none at all.
    const { wf, calls } = await readyToBuild({
      choose: [], candidates: { s1: [KURO] }, selectAnswers: [selection({ s1: 's1c1' }), selection({ s1: 'none' })]
    });
    await wf.select();
    wf.build();
    expect(await waitFor(() => loc.keys().includes(KURO_KEY))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(wf.getState().nameKeys.pending).toBe(true);

    await wf.select();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(wf.getState().nameKeys.pending).toBe(false);
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.pending).toBe(false);
    expect(wf.getState().recommendations).toEqual([]);
  });

  // (b) — the exact-only fallback
  it('continue-without-AI that leaves NO new targets aborts the old operation and leaves it not pending', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const loc = mockLoc({ [KURO_KEY]: async () => { await held; return response({ hits: [KURO_HIT] }); } });
    // Two exact-full names for s1: the exact-only fallback chooses neither.
    const { wf, calls } = await readyToBuild({
      choose: [], candidates: { s1: [KURO, MIFUNE] }, selectAnswers: [selection({ s1: 's1c1' })]
    });
    await wf.select();
    wf.build();
    expect(await waitFor(() => loc.keys().includes(KURO_KEY))).toBe(true);
    expect(wf.getState().nameKeys.pending).toBe(true);

    wf.continueWithoutAi();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(wf.getState().nameKeys.pending).toBe(false);
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(wf.getState().nameKeys.pending).toBe(false);
  });

  it('a choice that does NOT change the effective choices leaves the running operation alone', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    mockLoc({ [KURO_KEY]: async () => { await held; return response({ hits: [KURO_HIT] }); } });
    const { wf, calls } = await readyToBuild({ choose: [['s1', KURO.cid]] });
    wf.build();
    expect(await waitFor(() => calls.length === 1)).toBe(true);
    // A cid that is not a candidate of s1 is ignored: nothing changed.
    wf.choose('s1', 'lcsh:sh0000');
    expect(calls[0].signal.aborted).toBe(false);
    expect(wf.getState().nameKeys.pending).toBe(true);
    release();
    expect(await waitFor(() => !wf.getState().nameKeys.pending)).toBe(true);
    expect(marcTexts(wf)).toEqual([KURO_MARC]);
  });

  it('already resolved keys stay reused after a choice change', async () => {
    const loc = mockLoc({ [KURO_KEY]: [KURO_HIT], [MIFUNE_KEY]: [MIFUNE_HIT] });
    const { wf } = await readyToBuild({ choose: [['s1', KURO.cid]] });
    wf.build();
    expect(await waitFor(() => !wf.getState().nameKeys.pending)).toBe(true);
    expect(wf.getState().nameKeys.keys[KURO.cid]).toBeTruthy();
    // Kurosawa is dropped and chosen again: no second request for it.
    wf.choose('s1', null);
    wf.choose('s1', KURO.cid);
    expect(wf.getState().nameKeys.pending).toBe(false);
    expect(marcTexts(wf)).toEqual([KURO_MARC]);
    expect(loc.keys().filter((k) => k === KURO_KEY)).toHaveLength(1);
  });
});
