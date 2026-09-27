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
import { runSuggest } from './suggest';
import { runLookupStep, LOOKUP_BUDGET_MS } from './lookupStep';
import { runAiSelect, presentCandidates } from './select';
import { candidateLimit } from './budget';
import { imageMetadata } from './images';
import { logWorkflowError } from './logging';
import {
  initialRunState, beginSuggest, setSuggestSnapshot, commitSuggest, failSuggest, invalidateSuggest,
  beginLookup, commitLookup, invalidateLookups, beginSelect, setSelectSnapshot, commitSelect, failSelect,
  invalidateSelect, continueWithoutAi, setManualChoice, buildRun
} from './run';

const provenanceOf = (cfg) => (cfg ? { providerId: cfg.providerId, model: cfg.model } : null);
const isCancel = (err) => err?.kind === 'cancelled';
const toError = (err) => ({
  kind: err?.kind || 'unknown',
  message: err instanceof ProviderError || err instanceof LookupError ? err.message : 'Something went wrong. Try again.'
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
  createBackend = (settings) => getLookupBackend(settings, scheduler ? { scheduler } : {}),
  uuid = () => crypto.randomUUID(),
  lookupBudgetMs = LOOKUP_BUDGET_MS
}) => {
  let state = initialRunState();
  // The lookup backend (and its per-run cache) belongs to one run.
  let runBackend = { runId: null, backend: null, cfg: null };
  const listeners = new Set();
  const controllers = { suggest: null, lookup: new Set(), select: null };

  const set = (next) => {
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener(state));
  };
  const update = (fn) => set(fn(state));

  const abortSuggest = () => controllers.suggest?.abort();
  const abortLookups = () => controllers.lookup.forEach((c) => c.abort());
  const abortSelect = () => controllers.select?.abort();

  /** Step 1: a NEW run. Its identity and input copy are taken before any await. */
  const suggest = async ({ bibliographicInfo, rules }) => {
    abortSuggest();
    abortLookups();
    abortSelect();
    const begun = beginSuggest(state, { runId: uuid(), snapshot: null, input: inputSnapshot(bibliographicInfo) });
    set(begun.state);
    const controller = new AbortController();
    controllers.suggest = controller;
    const owns = () => !controller.signal.aborted && state.run.runId === begun.token.runId && state.run.stage === 'suggesting';
    try {
      const { cfg, settings } = await loadConfig();
      if (!owns()) return;
      update((s) => setSuggestSnapshot(s, begun.token, provenanceOf(cfg)));
      runBackend = { runId: begun.token.runId, backend: createBackend(settings), cfg };
      const result = await runSuggest({ cfg, bibliographicInfo, rules, signal: controller.signal, generateImpl });
      if (!owns()) return;
      update((s) => commitSuggest(s, begun.token, result));
    } catch (err) {
      logWorkflowError('Error generating suggestions:', err);
      if (owns()) update((s) => failSuggest(s, begun.token, isCancel(err) ? null : toError(err)));
    } finally {
      if (controllers.suggest === controller) controllers.suggest = null;
    }
  };

  const lookup = async (ids, { bypassCache }) => {
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
      update((s) => setSelectSnapshot(s, begun.token, provenanceOf(cfg)));
      const result = await runAiSelect({ cfg, bibliographicInfo: input, suggestions, results, signal: controller.signal, generateImpl });
      if (!owns()) return;
      update((s) => commitSelect(s, begun.token, result));
    } catch (err) {
      logWorkflowError('Error choosing headings:', err);
      if (owns()) update((s) => failSelect(s, begun.token, isCancel(err) ? null : toError(err)));
    } finally {
      if (controllers.select === controller) controllers.select = null;
    }
  };

  /**
   * Leave a step: its pending operation (running or still preparing) is aborted and invalidated.
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    suggest,
    lookupAll,
    retryLookup,
    select,
    continueWithoutAi: () => update(continueWithoutAi),
    choose: (suggestionId, cid) => update((s) => setManualChoice(s, suggestionId, cid)),
    build: () => update(buildRun),
    leave,
    /** Unmount: abort and invalidate every step. */
    dispose: () => {
      abortSuggest();
      abortLookups();
      abortSelect();
      update((s) => invalidateSelect(invalidateLookups(invalidateSuggest(s))));
    },
    /** Load a state (tests). */
    replaceState: (next) => set(next)
  };
};

export default createWorkflow;
