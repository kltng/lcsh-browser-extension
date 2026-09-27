/**
 * Run state and stale-result rejection (SPEC-P4 §9). Pure transitions: every
 * function returns a new state. A result is committed ONLY when its runId
 * AND its operation revision are still current.
 * Stages: idle → suggesting → suggested → looking-up → looked-up → selecting → selected → built.
 */
import { mergeSelections, buildRecommendations, exactOnlyChoices } from './select';
import { applyNameKeys, nameKeyTargets, mergeNameKeys } from './nameKeys';

export const STAGES = ['idle', 'suggesting', 'suggested', 'looking-up', 'looked-up', 'selecting', 'selected', 'built'];

// The name-key operation (SPEC-P5 §7) belongs to ONE recommendations build.
// `keys` and `reasons` are kept per run by cid: a resolved key is reused, and
// a recorded reason stops ordinary regeneration from looping on a failure.
const emptyNameKeys = () => ({ revision: 0, pending: false, keys: {}, reasons: {}, deps: {}, choicesKey: null });

// `deps`: the lookup revision of every candidate list the pending selection
// presented; a choice from a list that was replaced since then is rejected.
const emptySelect = () => ({
  revision: 0, pending: false, mode: null, choices: {}, additional: [], manual: {}, error: null, fallbackKind: null, deps: {}
});

/**
 * The state before any run.
 * @returns {object}
 */
export const initialRunState = () => ({
  run: { runId: null, stage: 'idle', snapshots: { suggest: null, select: null } },
  input: null,
  suggest: null,
  suggestError: null,
  lookup: { results: {}, revisions: {}, pending: {} },
  select: emptySelect(),
  nameKeys: emptyNameKeys(),
  recommendations: null
});

const withStage = (state, stage) => ({ ...state, run: { ...state.run, stage } });

const nameKeyMaps = (state) => ({
  keys: new Map(Object.entries(state.nameKeys.keys)),
  reasons: new Map(Object.entries(state.nameKeys.reasons))
});

/**
 * The effective selections of the current state.
 * @param {object} state - Run state
 * @returns {object[]}
 */
export const selectionsOf = (state) => mergeSelections({
  suggestions: state.suggest?.suggestions || [],
  results: state.lookup.results,
  mode: state.select.mode,
  choices: state.select.choices,
  manual: state.select.manual
});

/** The recommendations of a state, with the name keys resolved so far applied. */
const recommendationsOf = (state) => applyNameKeys(buildRecommendations({
  selections: selectionsOf(state), additional: state.select.additional, results: state.lookup.results
}), nameKeyMaps(state));

// Any change of a choice or a candidate list regenerates built recommendations.
const refresh = (state) => {
  if (state.recommendations === null) return state;
  return { ...state, recommendations: recommendationsOf(state) };
};

/**
 * A stable key of the EFFECTIVE choices, so a name-key result can be rejected
 * when a choice changed while it was running (SPEC-P5 §7).
 * @param {object} state - Run state
 * @returns {string}
 */
export const effectiveChoicesKey = (state) => [
  ...selectionsOf(state).map((s) => `${s.suggestionId}:${s.cid ?? ''}`),
  ...state.select.additional.map((a) => `+:${a.cid}`)
].join('|');

/**
 * Start a NEW run with Suggest: clears lookup, selection and recommendations.
 * @param {object} state - Run state (only its revisions are carried on)
 * @param {{runId:string, snapshot:{providerId:string, model:string}, input:object}} args - New run id, provenance snapshot, input copy
 * @returns {{state:object, token:{runId:string}}}
 */
export const beginSuggest = (state, { runId, snapshot, input }) => {
  const next = initialRunState();
  next.run = { runId, stage: 'suggesting', snapshots: { suggest: snapshot, select: null } };
  next.input = input;
  // Revisions keep increasing across runs, so no old token can ever match.
  next.lookup.revisions = { ...state.lookup.revisions };
  next.select.revision = state.select.revision;
  // A new run invalidates the name-key operation and drops its per-run keys.
  next.nameKeys = { ...emptyNameKeys(), revision: state.nameKeys.revision + 1 };
  return { state: next, token: { runId } };
};

const isCurrentRun = (state, token) => Boolean(token) && token.runId === state.run.runId;

/**
 * Record the provenance of the suggest config once it is loaded (current run only).
 * @param {object} state - Run state
 * @param {{runId:string}} token - Token of beginSuggest
 * @param {{providerId:string, model:string}} snapshot - Provenance
 * @returns {object}
 */
export const setSuggestSnapshot = (state, token, snapshot) => {
  if (!isCurrentRun(state, token) || state.run.stage !== 'suggesting') return state;
  return { ...state, run: { ...state.run, snapshots: { ...state.run.snapshots, suggest: snapshot } } };
};

/**
 * Leaving step 1 (or a cancel) while Suggest is running or preparing: its
 * pending operation is invalidated.
 * @param {object} state - Run state
 * @returns {object}
 */
export const invalidateSuggest = (state) => (state.run.stage === 'suggesting' ? withStage(state, 'idle') : state);

/**
 * Commit the suggestions of a run (dropped when the run is not current).
 * @param {object} state - Run state
 * @param {{runId:string}} token - Token of beginSuggest
 * @param {object} result - runSuggest() result
 * @returns {object}
 */
export const commitSuggest = (state, token, result) => {
  if (!isCurrentRun(state, token) || state.run.stage !== 'suggesting') return state;
  return { ...withStage(state, 'suggested'), suggest: result, suggestError: null };
};

/**
 * Record a failed Suggest of the current run.
 * @param {object} state - Run state
 * @param {{runId:string}} token - Token of beginSuggest
 * @param {{kind:string, message:string}|null} error - The error (null for a cancel)
 * @returns {object}
 */
export const failSuggest = (state, token, error) => {
  if (!isCurrentRun(state, token) || state.run.stage !== 'suggesting') return state;
  return { ...withStage(state, 'idle'), suggestError: error };
};

/**
 * Start lookups. All suggestions: the stage becomes `looking-up`. One
 * suggestion (Retry lookup): only its result, its choice (INCLUDING a
 * manual choice) and the additional picks that came from its candidate list
 * (by their `suggestionId`) are cleared.
 * @param {object} state - Run state
 * @param {string[]} suggestionIds - Suggestions to look up
 * @returns {{state:object, tokens:Object<string,{runId:string, suggestionId:string, revision:number}>}}
 */
export const beginLookup = (state, suggestionIds) => {
  const revisions = { ...state.lookup.revisions };
  const pending = { ...state.lookup.pending };
  const results = { ...state.lookup.results };
  const choices = { ...state.select.choices };
  const manual = { ...state.select.manual };
  const tokens = {};
  for (const id of suggestionIds) {
    revisions[id] = (revisions[id] || 0) + 1;
    pending[id] = true;
    delete results[id];
    delete choices[id];
    delete manual[id];
    tokens[id] = { runId: state.run.runId, suggestionId: id, revision: revisions[id] };
  }
  // Additional picks record the suggestion whose presented list they came
  // from (validateSelectAnswer); a retried list drops its picks.
  const additional = state.select.additional.filter((pick) => !suggestionIds.includes(pick.suggestionId));
  const all = (state.suggest?.suggestions || []).every((s) => suggestionIds.includes(s.id));
  // A lookup retry changes an input of the name-key operation (§7, HOUSE_RULES 14).
  let next = invalidateNameKeys({
    ...state,
    lookup: { results, revisions, pending },
    select: { ...state.select, choices, manual, additional }
  });
  if (all) {
    next = { ...withStage(next, 'looking-up'), select: { ...emptySelect(), revision: state.select.revision + 1 }, recommendations: null };
  }
  return { state: refresh(next), tokens };
};

const isCurrentLookup = (state, token) => isCurrentRun(state, token)
  && state.lookup.revisions[token.suggestionId] === token.revision && state.lookup.pending[token.suggestionId];

/**
 * Commit one LookupResult (dropped when the run or the revision is not current).
 * @param {object} state - Run state
 * @param {{runId:string, suggestionId:string, revision:number}} token - Token of beginLookup
 * @param {object} result - LookupResult
 * @returns {object}
 */
export const commitLookup = (state, token, result) => {
  if (!isCurrentLookup(state, token)) return state;
  const pending = { ...state.lookup.pending };
  delete pending[token.suggestionId];
  let next = {
    ...state,
    lookup: { ...state.lookup, pending, results: { ...state.lookup.results, [token.suggestionId]: result } }
  };
  if (next.run.stage === 'looking-up' && Object.keys(pending).length === 0) next = withStage(next, 'looked-up');
  return refresh(next);
};

/**
 * Leaving the lookup step (or a cancel): pending lookups are invalidated.
 * @param {object} state - Run state
 * @returns {object}
 */
export const invalidateLookups = (state) => {
  const ids = Object.keys(state.lookup.pending);
  if (ids.length === 0) return state;
  const revisions = { ...state.lookup.revisions };
  ids.forEach((id) => { revisions[id] += 1; });
  let next = { ...state, lookup: { ...state.lookup, revisions, pending: {} } };
  if (next.run.stage === 'looking-up') next = withStage(next, Object.keys(next.lookup.results).length > 0 ? 'looked-up' : 'suggested');
  return next;
};

/**
 * Start the AI step: clears the AI selections, keeps manual choices.
 * @param {object} state - Run state
 * @param {{providerId:string, model:string}} snapshot - Provenance of the select config (taken at start)
 * @returns {{state:object, token:{runId:string, revision:number}}}
 */
export const beginSelect = (state, snapshot) => {
  const revision = state.select.revision + 1;
  // The candidate lists this operation uses: their lookup revisions now.
  const deps = {};
  for (const id of Object.keys(state.lookup.results)) {
    if (!state.lookup.pending[id]) deps[id] = state.lookup.revisions[id];
  }
  const next = {
    ...state,
    run: { ...state.run, stage: 'selecting', snapshots: { ...state.run.snapshots, select: snapshot } },
    select: { ...emptySelect(), manual: state.select.manual, revision, pending: true, deps }
  };
  return { state: refresh(next), token: { runId: state.run.runId, revision } };
};

const isCurrentSelect = (state, token) => isCurrentRun(state, token)
  && state.select.revision === token.revision && state.select.pending;

/**
 * Record the provenance of the select config once it is loaded (current operation only).
 * @param {object} state - Run state
 * @param {{runId:string, revision:number}} token - Token of beginSelect
 * @param {{providerId:string, model:string}} snapshot - Provenance
 * @returns {object}
 */
export const setSelectSnapshot = (state, token, snapshot) => {
  if (!isCurrentSelect(state, token)) return state;
  return { ...state, run: { ...state.run, snapshots: { ...state.run.snapshots, select: snapshot } } };
};

// A candidate list is still the one the selection saw: same lookup revision, not pending, present.
const listUnchanged = (state, suggestionId) => Object.hasOwn(state.select.deps, suggestionId)
  && state.select.deps[suggestionId] === state.lookup.revisions[suggestionId]
  && !state.lookup.pending[suggestionId] && Boolean(state.lookup.results[suggestionId]);

/**
 * Commit the AI step. Choices and additional picks derived from a candidate
 * list that was replaced meanwhile (a per-suggestion Retry lookup) are
 * rejected; unaffected choices are kept. Manual choices (including a manual
 * "none") are kept and win. Built recommendations are regenerated.
 * @param {object} state - Run state
 * @param {{runId:string, revision:number}} token - Token of beginSelect
 * @param {{mode:'ai'|'exact-fallback', choices:object, additional:object[], fallbackKind?:string}} result - runAiSelect() result
 * @returns {object}
 */
export const commitSelect = (state, token, result) => {
  if (!isCurrentSelect(state, token)) return state;
  const choices = Object.fromEntries(Object.entries(result.choices || {}).filter(([id]) => listUnchanged(state, id)));
  const additional = (result.additional || []).filter((a) => !a.suggestionId || listUnchanged(state, a.suggestionId));
  return refresh(withStage({
    ...state,
    select: {
      ...state.select, pending: false, mode: result.mode, choices, additional, error: null, fallbackKind: result.fallbackKind || null
    }
  }, 'selected'));
};

/**
 * Record a stopped AI step (§5.2 "stop" kinds; null for a cancel).
 * @param {object} state - Run state
 * @param {{runId:string, revision:number}} token - Token of beginSelect
 * @param {{kind:string, message:string}|null} error - The error
 * @returns {object}
 */
export const failSelect = (state, token, error) => {
  if (!isCurrentSelect(state, token)) return state;
  return withStage({ ...state, select: { ...state.select, pending: false, error } }, 'looked-up');
};

/**
 * Leaving the selection step invalidates its pending operation.
 * @param {object} state - Run state
 * @returns {object}
 */
export const invalidateSelect = (state) => {
  if (!state.select.pending) return state;
  return withStage({ ...state, select: { ...state.select, pending: false, revision: state.select.revision + 1 } }, 'looked-up');
};

/**
 * "Continue without AI (exact matches only)": the exact-only fallback.
 * @param {object} state - Run state
 * @returns {object}
 */
export const continueWithoutAi = (state) => refresh(withStage({
  ...state,
  select: {
    ...state.select, pending: false, mode: 'exact-fallback', error: null, additional: [], fallbackKind: 'user',
    choices: exactOnlyChoices(state.suggest?.suggestions || [], state.lookup.results)
  }
}, 'selected'));

/**
 * A manual choice ("Use this heading" = cid, "Use none" = null). Only a
 * candidate of that suggestion can be chosen.
 * @param {object} state - Run state
 * @param {string} suggestionId - Suggestion
 * @param {string|null} cid - Chosen candidate, or null for "Use none"
 * @returns {object}
 */
export const setManualChoice = (state, suggestionId, cid) => {
  const candidates = state.lookup.results[suggestionId]?.candidates || [];
  if (candidates.length === 0) return state;
  if (cid !== null && !candidates.some((c) => c.cid === cid)) return state;
  return refresh({ ...state, select: { ...state.select, manual: { ...state.select.manual, [suggestionId]: { cid } } } });
};

/**
 * "Build recommendations" from the current selections.
 * @param {object} state - Run state
 * @returns {object}
 */
export const buildRun = (state) => withStage({ ...state, recommendations: recommendationsOf(state) }, 'built');

/**
 * Start the name-key operation of the CURRENT recommendations build (§7).
 * @param {object} state - Run state
 * @param {{retry?:boolean}} [opts] - Retry bypasses the run cache for unresolved cids
 * @returns {{state:object, token:object, targets:object[], bypassCids:Set<string>}}
 */
export const beginNameKeys = (state, { retry = false } = {}) => {
  const revision = state.nameKeys.revision + 1;
  const deps = {};
  for (const id of Object.keys(state.lookup.results)) {
    if (!state.lookup.pending[id]) deps[id] = state.lookup.revisions[id];
  }
  const choicesKey = effectiveChoicesKey(state);
  // Review finding 7: a cid whose key is already resolved in this run is never
  // asked for again, not even by Retry — neither as a target nor in the
  // cache-bypass set (§7: "resolved keys stay reused").
  const unresolved = nameKeyTargets(state.recommendations || [])
    .filter((t) => !Object.hasOwn(state.nameKeys.keys, t.cid));
  // Ordinary regeneration never loops on a failed resolution; Retry asks again
  // for the UNRESOLVED selected cids only.
  const targets = retry ? unresolved : unresolved.filter((t) => !Object.hasOwn(state.nameKeys.reasons, t.cid));
  const next = {
    ...state,
    nameKeys: { ...state.nameKeys, revision, pending: targets.length > 0, deps, choicesKey }
  };
  return {
    state: next,
    token: { runId: state.run.runId, revision, deps, choicesKey },
    targets,
    bypassCids: new Set(retry ? unresolved.map((t) => t.cid) : [])
  };
};

const isCurrentNameKeys = (state, token) => isCurrentRun(state, token)
  && state.nameKeys.revision === token.revision && state.nameKeys.pending
  && effectiveChoicesKey(state) === token.choicesKey
  && Object.entries(token.deps).every(([id, revision]) => state.lookup.revisions[id] === revision
    && !state.lookup.pending[id]);

/**
 * Commit one name-key round: resolved keys are kept per run by cid, and the
 * recommendations are regenerated (every key re-checked by buildMarc()).
 * @param {object} state - Run state
 * @param {object} token - Token of beginNameKeys
 * @param {Map<string, object>} resolved - Result of resolveNameKeys
 * @returns {object}
 */
export const commitNameKeys = (state, token, resolved) => {
  if (!isCurrentNameKeys(state, token)) return state;
  const merged = mergeNameKeys(nameKeyMaps(state), resolved);
  const next = {
    ...state,
    nameKeys: {
      ...state.nameKeys,
      pending: false,
      keys: Object.fromEntries(merged.keys),
      reasons: Object.fromEntries(merged.reasons)
    }
  };
  return refresh(next);
};

/**
 * Invalidate a pending name-key operation (a new run, a relevant lookup retry,
 * a changed choice or disposal).
 * @param {object} state - Run state
 * @returns {object}
 */
export const invalidateNameKeys = (state) => {
  if (!state.nameKeys.pending) return state;
  return { ...state, nameKeys: { ...state.nameKeys, pending: false, revision: state.nameKeys.revision + 1 } };
};
