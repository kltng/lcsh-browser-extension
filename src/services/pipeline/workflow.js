/**
 * The workflow controller: runs the pipeline steps over the pure run state
 * of run.js (SPEC-P4 §9). Every operation reserves its identity (runId +
 * revision) and its AbortController SYNCHRONOUSLY, before any await, and
 * captures its inputs at that moment. After every await it checks that it
 * still owns the operation before committing anything (including a
 * preparation error). A new run, leaving the step and unmount (dispose)
 * abort and invalidate operations, also those still preparing. Cleanup is in
 * `finally`. Config snapshots (which hold API keys) stay in this closure and
 * never enter the state.
 */
import { ProviderError } from '../providers/errors';
import { LookupError } from '../lookup/scheduler';
import { getLookupBackend } from '../lookup/index';
import { createLocRequester } from '../lookup/locApi';
import { runSuggest } from './suggest';
import { runLookupStep, LOOKUP_BUDGET_MS } from './lookupStep';
import { runAiSelect, presentCandidates, headingComponents } from './select';
import {
  guardExit, rememberRunKey, setStoredKeys, keysOfSettings, documentKeys, KeyEchoError
} from '../keyGuard';
import { candidateLimit } from './budget';
import { imageMetadata } from './images';
import { logWorkflowError } from './logging';
import { resolveNameKeys, nameKeyTargets } from './nameKeys';
import {
  initialRunState, beginSuggest, setSuggestSnapshot, commitSuggest, failSuggest, invalidateSuggest,
  beginLookup, commitLookup, invalidateLookups, beginSelect, setSelectSnapshot, commitSelect, failSelect,
  invalidateSelect, continueWithoutAi, setManualChoice, buildRun,
  beginNameKeys, commitNameKeys, invalidateNameKeys
} from './run';

const provenanceOf = (cfg) => (cfg ? { providerId: cfg.providerId, model: cfg.model } : null);
const isCancel = (err) => err?.kind === 'cancelled';
const toError = (err) => ({
  kind: err?.kind || 'unknown',
  message: err instanceof ProviderError || err instanceof LookupError || err instanceof KeyEchoError
    ? err.message : 'Something went wrong. Try again.'
});

/**
 * Exit (d), P6 fix 13: every value of a suggest result that the UI can show,
 * AFTER all derivation — the analysis, each heading, kind and reason, and
 * every subdivision headingComponents() can later report as "dropped" (the
 * ORIGINAL component text; that is what subdivisionInfo() reports).
 * @param {{subjectAnalysis:string, suggestions:object[]}} result - runSuggest() result
 * @returns {object}
 */
export const displayedSuggestValues = (result) => ({
  subjectAnalysis: result.subjectAnalysis,
  suggestions: result.suggestions.map((s) => ({
    heading: s.heading, kind: s.kind, reason: s.reason, components: headingComponents(s.heading).original
  }))
});

/**
 * The run's copy of the bibliographic input: the text fields and image
 * METADATA only. History is built from this copy, never from the live form.
 * @param {object} info - Form data
 * @returns {object}
 */
export const inputSnapshot = (info = {}) => ({
  title: info.title || '',
  author: info.author || '',
  abstract: info.abstract || '',
  tableOfContents: info.tableOfContents || '',
  notes: info.notes || '',
  images: imageMetadata(info.images)
});

/**
 * Create a workflow controller.
 * @param {{loadConfig:()=>Promise<{cfg:object, settings:object}>, generateImpl?:Function, scheduler?:object,
 *   createBackend?:Function, uuid?:()=>string, lookupBudgetMs?:number}} deps - Dependencies
 * @returns {object} - getState, subscribe and the step actions
 */
export const createWorkflow = ({
  loadConfig,
  generateImpl,
  scheduler,
  localClient = null,
  createBackend = (settings) => getLookupBackend(settings, { ...(scheduler ? { scheduler } : {}), client: localClient }),
  uuid = () => crypto.randomUUID(),
  lookupBudgetMs = LOOKUP_BUDGET_MS,
  resolveNameKeysImpl = resolveNameKeys
}) => {
  let state = initialRunState();
  // The lookup backend (and its per-run cache) belongs to one run.
  let runBackend = { runId: null, backend: null, cfg: null };
  // The keys of the providers THIS run used (its suggest and select
  // snapshots), in memory only — never in the run state, so never in history.
  let runKeys = { runId: null, keys: [] };
  const useKey = (runId, cfg) => {
    const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey : '';
    if (!key) return;
    rememberRunKey(key);
    runKeys = runKeys.runId === runId
      ? { runId, keys: [...new Set([...runKeys.keys, key])] }
      : { runId, keys: [key] };
  };
  const currentRunKeys = () => (runKeys.runId === state.run.runId ? runKeys.keys : []);
  const listeners = new Set();
  const controllers = { suggest: null, lookup: new Set(), select: null, nameKeys: null };

  const set = (next) => {
    if (next === state) return;
    state = next;
    // The name-key controller FOLLOWS the state: once the operation it belongs
    // to is no longer the current revision — invalidated by a new run, a
    // lookup retry, a changed choice or disposal — its requests are aborted,
    // whether or not a replacement operation starts (SPEC-P5 §7).
    const running = controllers.nameKeys;
    if (running && running.revision !== state.nameKeys.revision) running.controller.abort();
    listeners.forEach((listener) => listener(state));
  };
  const update = (fn) => set(fn(state));

  const abortSuggest = () => controllers.suggest?.abort();
  const abortLookups = () => controllers.lookup.forEach((c) => c.abort());
  const abortSelect = () => controllers.select?.abort();
  const abortNameKeys = () => controllers.nameKeys?.controller.abort();

  /**
   * The name-key operation of ONE recommendations build (SPEC-P5 §7). Its
   * identity (revision, dependencies, effective choices) and its
   * AbortController are reserved before the first await; the result is
   * committed only if all of them are still current.
   */
  const resolveNames = async ({ retry = false } = {}) => {
    if (state.recommendations === null) return;
    abortNameKeys();
    const begun = beginNameKeys(state, { retry });
    set(begun.state);
    if (begun.targets.length === 0) return;
    const controller = new AbortController();
    controllers.nameKeys = { controller, revision: begun.token.revision };
    try {
      // The run's validated-response cache, so a key already fetched in this
      // run is not fetched again (§7).
      const requester = createLocRequester({
        ...(scheduler ? { scheduler } : {}),
        ...(runBackend.backend?.cache ? { cache: runBackend.backend.cache } : {})
      });
      const resolved = await resolveNameKeysImpl({
        targets: begun.targets, requester, signal: controller.signal, bypassCids: begun.bypassCids
      });
      update((s) => commitNameKeys(s, begun.token, resolved));
    } catch (err) {
      logWorkflowError('Error resolving name MARC keys:', err);
      update(invalidateNameKeys);
    } finally {
      if (controllers.nameKeys?.controller === controller) controllers.nameKeys = null;
    }
  };

  // A newly chosen name with no key and no recorded reason starts an operation.
  const maybeResolveNames = () => {
    if (state.recommendations === null) return;
    // A PENDING operation is always the current one (any change of its inputs
    // invalidates it and clears `pending`), so it already covers these choices.
    if (state.nameKeys.pending) return;
    const open = nameKeyTargets(state.recommendations)
      .filter((t) => !Object.hasOwn(state.nameKeys.reasons, t.cid) && !Object.hasOwn(state.nameKeys.keys, t.cid));
    if (open.length > 0) resolveNames();
  };

  /** Step 1: a NEW run. Its identity and input copy are taken before any await. */
  const suggest = async ({ bibliographicInfo, rules }) => {
    abortSuggest();
    abortLookups();
    abortSelect();
    abortNameKeys();
    const begun = beginSuggest(state, { runId: uuid(), snapshot: null, input: inputSnapshot(bibliographicInfo) });
    set(begun.state);
    const controller = new AbortController();
    controllers.suggest = controller;
    const owns = () => !controller.signal.aborted && state.run.runId === begun.token.runId && state.run.stage === 'suggesting';
    try {
      const { cfg, settings } = await loadConfig();
      if (!owns()) return;
      useKey(begun.token.runId, cfg);
      setStoredKeys(keysOfSettings(settings));
      update((s) => setSuggestSnapshot(s, begun.token, provenanceOf(cfg)));
      runBackend = { runId: begun.token.runId, backend: createBackend(settings), cfg };
      const result = await runSuggest({ cfg, bibliographicInfo, rules, signal: controller.signal, generateImpl });
      if (!owns()) return;
      // Exit (d): nothing that repeats the run's key is stored for display.
      guardExit('display', displayedSuggestValues(result), currentRunKeys());
      update((s) => commitSuggest(s, begun.token, result));
    } catch (err) {
      logWorkflowError('Error generating suggestions:', err);
      if (owns()) update((s) => failSuggest(s, begun.token, isCancel(err) ? null : toError(err)));
    } finally {
      if (controllers.suggest === controller) controllers.suggest = null;
    }
  };

  const lookup = async (ids, { bypassCache }) => {
    abortNameKeys();
    const suggestions = (state.suggest?.suggestions || []).filter((s) => ids.includes(s.id));
    const { backend, cfg } = runBackend.runId === state.run.runId ? runBackend : {};
    if (!backend || suggestions.length === 0) return;
    const begun = beginLookup(state, suggestions.map((s) => s.id));
    set(begun.state);
    const controller = new AbortController();
    controllers.lookup.add(controller);
    try {
      await runLookupStep({
        backend, suggestions, limit: candidateLimit(cfg), signal: controller.signal,
        budgetMs: lookupBudgetMs, bypassCache,
        onResult: (result) => update((s) => commitLookup(s, begun.tokens[result.suggestionId], result))
      });
    } catch (err) {
      // A cancel commits nothing; the invalidation already happened.
    } finally {
      controllers.lookup.delete(controller);
    }
  };

  /** Step 2 → 3: look up every suggestion. */
  const lookupAll = () => lookup((state.suggest?.suggestions || []).map((s) => s.id), { bypassCache: false });

  /** "Retry lookup" for one suggestion: a fresh attempt that bypasses the cache. */
  const retryLookup = (suggestionId) => lookup([suggestionId], { bypassCache: true });

  /** Step 3: "Choose headings" (the AI step; retry = run it again). */
  const select = async () => {
    abortSelect();
    // Inputs and identity are captured now, before any await.
    const suggestions = state.suggest?.suggestions || [];
    const results = state.lookup.results;
    const input = state.input;
    const begun = beginSelect(state, null);
    set(begun.state);
    if (presentCandidates(suggestions, results, 1).presented.length === 0) {
      update((s) => commitSelect(s, begun.token, { mode: 'ai', choices: {}, additional: [] }));
      return;
    }
    const controller = new AbortController();
    controllers.select = controller;
    const owns = () => !controller.signal.aborted && state.run.runId === begun.token.runId
      && state.select.pending && state.select.revision === begun.token.revision;
    try {
      const { cfg } = await loadConfig();
      if (!owns()) return;
      useKey(begun.token.runId, cfg);
      update((s) => setSelectSnapshot(s, begun.token, provenanceOf(cfg)));
      const result = await runAiSelect({ cfg, bibliographicInfo: input, suggestions, results, signal: controller.signal, generateImpl });
      if (!owns()) return;
      update((s) => commitSelect(s, begun.token, result));
      maybeResolveNames();
    } catch (err) {
      logWorkflowError('Error choosing headings:', err);
      if (owns()) update((s) => failSelect(s, begun.token, isCancel(err) ? null : toError(err)));
    } finally {
      if (controllers.select === controller) controllers.select = null;
    }
  };

  /**
   * Leave a step: its pending operation (running or still preparing) is aborted and invalidated.
   *
   * The name-key operation is NOT a step operation. SPEC-P5 §7 lists exactly
   * what aborts and invalidates it — a new run, a relevant lookup retry, a
   * changed choice, or disposal — and a step change is none of these. It is
   * started by "Build recommendations", which then leaves the Matches step
   * at once; aborting it here killed every name-key lookup before its first
   * request (live finding, §13 row 3).
   * @param {'suggest'|'lookup'|'select'} step - The step left
   */
  const leave = (step) => {
    if (step === 'suggest') {
      abortSuggest();
      update(invalidateSuggest);
    }
    if (step === 'lookup') {
      abortLookups();
      update(invalidateLookups);
    }
    if (step === 'select') {
      abortSelect();
      update(invalidateSelect);
    }
  };

  return {
    getState: () => state,
    /**
     * The shared exit guard with this run's keys (P6 fix 13): `export` and
     * `display` check the keys of the providers this run used; `lookup` and
     * `history` also check every stored key and every earlier run's key.
     * Throws KeyEchoError (local text) when `value` repeats a key.
     * @param {'lookup'|'history'|'export'|'display'} exit - The exit
     * @param {any} value - Exactly what leaves
     * @returns {any} - `value`
     */
    guard: (exit, value) => guardExit(
      exit, value, exit === 'lookup' || exit === 'history' ? [...currentRunKeys(), ...documentKeys()] : currentRunKeys()
    ),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    suggest,
    lookupAll,
    retryLookup,
    select,
    continueWithoutAi: () => {
      update(continueWithoutAi);
      maybeResolveNames();
    },
    choose: (suggestionId, cid) => {
      // A CHANGED effective choice invalidates the running name-key operation
      // inside setManualChoice(), and set() then aborts its requests. A choice
      // that changes nothing (e.g. not a candidate of this suggestion) leaves
      // the operation alone.
      update((s) => setManualChoice(s, suggestionId, cid));
      maybeResolveNames();
    },
    build: () => {
      update(buildRun);
      maybeResolveNames();
    },
    /** "Retry name MARC keys": fresh requests for the UNRESOLVED selected cids only. */
    retryNameKeys: () => resolveNames({ retry: true }),
    leave,
    /** Unmount: abort and invalidate every step. */
    dispose: () => {
      abortSuggest();
      abortLookups();
      abortSelect();
      abortNameKeys();
      update((s) => invalidateNameKeys(invalidateSelect(invalidateLookups(invalidateSuggest(s)))));
    },
    /** Load a state (tests). */
    replaceState: (next) => set(next)
  };
};

export default createWorkflow;
