/**
 * Run state and stale-result rejection (SPEC-P4 §9). Pure transitions: every
 * function returns a new state. A result is committed ONLY when its runId
 * AND its operation revision are still current.
 * Stages: idle → suggesting → suggested → looking-up → looked-up → selecting → selected → built.
 */
import { mergeSelections, buildRecommendations, exactOnlyChoices } from './select';
import { applyNameKeys, nameKeyTargets, mergeNameKeys } from './nameKeys';
import { sortRecommendations } from './marcFormat';

export const STAGES = ['idle', 'suggesting', 'suggested', 'looking-up', 'looked-up', 'selecting', 'selected', 'built'];

// The name-key operation (SPEC-P5 §7) belongs to ONE recommendations build.
// `keys` and `reasons` are kept per run by cid: a resolved key is reused, and
// a recorded reason stops ordinary regeneration from looping on a failure.
const emptyNameKeys = () => ({ revision: 0, pending: false, keys: {}, reasons: {}, deps: {}, choicesKey: null });

// `deps`: the lookup revision of every candidate list the pending selection
// presented; a choice from a list that was replaced since then is rejected.
// `completedFor` (SPEC-UI2 §1): the exact snapshot a COMPLETED selection was
// made for — the suggestion revision and the lookup revision of every list it
// saw. A mode, a stage or a non-empty choices object alone never proves that
// a selection is current; only this snapshot, compared with the state, does.
const emptySelect = () => ({
  revision: 0, pending: false, mode: null, choices: {}, additional: [], manual: {}, error: null, fallbackKind: null, deps: {},
  completedFor: null
});

/**
 * The state before any run.
 * @returns {object}
 */
export const initialRunState = () => ({
  // `suggestRevision` (SPEC-UI2 §2): monotonic; every accepted edit of the
  // suggestions raises it, and every operation token carries it.
  run: { runId: null, stage: 'idle', snapshots: { suggest: null, select: null }, suggestRevision: 0 },
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

/**
 * The recommendations of a state, with the name keys resolved so far applied,
 * then sorted by MARC tag (SPEC-UI2 §3). They are rebuilt from the canonical
 * suggestion-then-additional order every time, so a name key that completes
 * later moves its recommendation to the right place.
 */
const recommendationsOf = (state) => sortRecommendations(applyNameKeys(buildRecommendations({
  selections: selectionsOf(state), additional: state.select.additional, results: state.lookup.results
}), nameKeyMaps(state)));

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
 * SPEC-P5 §7 + HOUSE_RULES 14: a change of the EFFECTIVE choices invalidates
 * the name-key operation of the old choices IN THE SAME TRANSITION, whether or
 * not a replacement operation starts afterwards. (Review-4 finding 1: before,
 * the old operation was invalidated only as a side effect of starting a new
 * one, so with no new target it stayed `pending` for ever and "Retry name MARC
 * keys" stayed disabled.) Resolved keys and recorded reasons are per run, by
 * cid, and are kept.
 * @param {object} before - The state before the transition
 * @param {object} after - The state after it
 * @returns {object}
 */
const settleNameKeysOnChoiceChange = (before, after) => (
  effectiveChoicesKey(before) === effectiveChoicesKey(after) ? after : invalidateNameKeys(after)
);

/**
 * Start a NEW run with Suggest: clears lookup, selection and recommendations.
 * @param {object} state - Run state (only its revisions are carried on)
 * @param {{runId:string, snapshot:{providerId:string, model:string}, input:object}} args - New run id, provenance snapshot, input copy
 * @returns {{state:object, token:{runId:string}}}
 */
export const beginSuggest = (state, { runId, snapshot, input }) => {
  const next = initialRunState();
  next.run = {
    runId, stage: 'suggesting', snapshots: { suggest: snapshot, select: null }, suggestRevision: (state.run.suggestRevision || 0) + 1
  };
  next.input = input;
  // Revisions keep increasing across runs, so no old token can ever match.
  next.lookup.revisions = { ...state.lookup.revisions };
  next.select.revision = state.select.revision;
  // A new run invalidates the name-key operation and drops its per-run keys.
  next.nameKeys = { ...emptyNameKeys(), revision: state.nameKeys.revision + 1 };
  return { state: next, token: { runId } };
};

const isCurrentRun = (state, token) => Boolean(token) && token.runId === state.run.runId;

// SPEC-UI2 §2: a lookup, selection or name-key token is current only for the
// suggestion revision it was issued under. The check is strict: a token
// without the field is never current.
const isCurrentSuggestRevision = (state, token) => token.suggestRevision === state.run.suggestRevision;

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
    tokens[id] = { runId: state.run.runId, suggestRevision: state.run.suggestRevision, suggestionId: id, revision: revisions[id] };
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

const isCurrentLookup = (state, token) => isCurrentRun(state, token) && isCurrentSuggestRevision(state, token)
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
  // Clearing the AI choices changes the effective choices.
  return {
    state: settleNameKeysOnChoiceChange(state, refresh(next)),
    token: { runId: state.run.runId, suggestRevision: state.run.suggestRevision, revision }
  };
};

const isCurrentSelect = (state, token) => isCurrentRun(state, token) && isCurrentSuggestRevision(state, token)
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
  return settleNameKeysOnChoiceChange(state, refresh(withStage({
    ...state,
    select: {
      ...state.select, pending: false, mode: result.mode, choices, additional, error: null, fallbackKind: result.fallbackKind || null,
      // The snapshot this selection was made for: the lists it saw (UI2 §1).
      completedFor: { suggestRevision: token.suggestRevision, lookupRevisions: { ...state.select.deps } }
    }
  }, 'selected')));
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
export const continueWithoutAi = (state) => settleNameKeysOnChoiceChange(state, refresh(withStage({
  ...state,
  select: {
    ...state.select, pending: false, mode: 'exact-fallback', error: null, additional: [], fallbackKind: 'user',
    choices: exactOnlyChoices(state.suggest?.suggestions || [], state.lookup.results),
    // The user's fallback is a completed selection for the lists as they are now (UI2 §1).
    completedFor: { suggestRevision: state.run.suggestRevision, lookupRevisions: completedLookupRevisions(state) }
  }
}, 'selected')));

/**
 * The lookup revision of every list that has a completed (not pending) result.
 * @param {object} state - Run state
 * @returns {Object<string, number>}
 */
const completedLookupRevisions = (state) => Object.fromEntries(Object.keys(state.lookup.results)
  .filter((id) => !state.lookup.pending[id])
  .map((id) => [id, state.lookup.revisions[id]]));

/**
 * SPEC-UI2 §1: every current suggestion has a completed lookup result, no
 * lookup and no selection is pending, and at least one suggestion exists.
 * `partial`, `failed` and `no-results` are completed; a missing result (for
 * example after a cancel) is not.
 * @param {object} state - Run state
 * @returns {boolean}
 */
export const lookupsComplete = (state) => {
  const suggestions = state.suggest?.suggestions || [];
  return suggestions.length > 0
    && Object.keys(state.lookup.pending).length === 0
    && !state.select.pending
    && suggestions.every((s) => Boolean(state.lookup.results[s.id]));
};

/**
 * SPEC-UI2 §1: a CURRENT selection is a completed AI selection or exact-only
 * fallback made for the current suggestion revision and the complete current
 * lookup-revision snapshot (every current suggestion's list, unchanged).
 * @param {object} state - Run state
 * @returns {boolean}
 */
export const isSelectionCurrent = (state) => {
  const done = state.select.completedFor;
  if (!done || state.select.pending || !state.select.mode) return false;
  if (done.suggestRevision !== state.run.suggestRevision) return false;
  return lookupsComplete(state) && (state.suggest?.suggestions || []).every((s) => (
    Object.hasOwn(done.lookupRevisions, s.id) && done.lookupRevisions[s.id] === state.lookup.revisions[s.id]
  ));
};

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
  return settleNameKeysOnChoiceChange(
    state,
    refresh({ ...state, select: { ...state.select, manual: { ...state.select.manual, [suggestionId]: { cid } } } })
  );
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
    token: { runId: state.run.runId, suggestRevision: state.run.suggestRevision, revision, deps, choicesKey },
    targets,
    bypassCids: new Set(retry ? unresolved.map((t) => t.cid) : [])
  };
};

const isCurrentNameKeys = (state, token) => isCurrentRun(state, token) && isCurrentSuggestRevision(state, token)
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
 * A FAILED name-key round (SPEC-UI2 §2): it invalidates only its OWN
 * operation. A stale failure — an older run, suggestion revision or name-key
 * revision — never invalidates a newer operation.
 * @param {object} state - Run state
 * @param {object} token - Token of beginNameKeys
 * @returns {object}
 */
export const failNameKeys = (state, token) => {
  if (!isCurrentRun(state, token) || !isCurrentSuggestRevision(state, token)) return state;
  if (state.nameKeys.revision !== token.revision) return state;
  return invalidateNameKeys(state);
};

/**
 * SPEC-UI2 §2: ONE atomic transition for every accepted edit of the
 * suggestions (add, edit, remove). It raises the suggestion revision (so every
 * older lookup, selection and name-key token is stale), clears all lookup
 * results and pending flags, the AI and manual selections, the additional
 * picks, the selection error and completion data, and the recommendations,
 * invalidates the name-key operation, and returns the run to `suggested`.
 * The bibliographic input and the original generation provenance are kept;
 * resolved name keys and recorded reasons stay cached by cid (P5 §7), but
 * nothing is rebuilt until the next build.
 * @param {object} state - Run state
 * @param {object[]} suggestions - The new, already validated suggestions
 * @param {{lastIdNumber?:number}} [meta] - The run's suggestion-id counter
 * @returns {object}
 */
export const editSuggestions = (state, suggestions, { lastIdNumber } = {}) => {
  if (!state.suggest || state.run.stage === 'idle' || state.run.stage === 'suggesting') return state;
  const revisions = { ...state.lookup.revisions };
  for (const id of new Set([...Object.keys(revisions), ...suggestions.map((s) => s.id)])) {
    revisions[id] = (revisions[id] || 0) + 1;
  }
  return {
    ...state,
    run: {
      ...state.run,
      stage: 'suggested',
      suggestRevision: state.run.suggestRevision + 1,
      snapshots: { ...state.run.snapshots, select: null }
    },
    suggest: {
      ...state.suggest,
      suggestions,
      ...(Number.isInteger(lastIdNumber) ? { lastIdNumber } : {})
    },
    lookup: { results: {}, revisions, pending: {} },
    select: { ...emptySelect(), revision: state.select.revision + 1 },
    nameKeys: { ...state.nameKeys, pending: false, revision: state.nameKeys.revision + 1 },
    recommendations: null
  };
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
