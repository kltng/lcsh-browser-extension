/**
 * Step 3 — select (SPEC-P4 §5): AI selection limited to looked-up records,
 * code validation of the answer, the §5.2 failure table, the exact-only
 * fallback, manual choices, outcome bookkeeping and recommendations.
 */
import { generate as defaultGenerate, ProviderError } from '../providers/index';
import { normalizeLabel, DASH_CLASS, WHITESPACE_RUN } from '../lookup/normalize';
import { buildSelectPrompt } from './prompts';
import { SELECT_SCHEMA } from './schemas';
import { budgetBibliographic, candidateLimit, isNano, NANO_RETRY_CANDIDATES } from './budget';
import { levenshteinDistance } from '../../utils/similarityUtils';
import { makeSelection } from './types';
import { buildMarc } from './marc';
import { guardExit, documentKeys, textFields } from '../keyGuard';

/** ProviderError kinds that lead to the AUTOMATIC exact-only fallback (§5.2). */
export const AUTO_FALLBACK_KINDS = new Set(['invalid_output', 'truncated', 'too_long']);
export const FALLBACK_BANNER = 'The AI could not choose; only exact matches were kept.';

const PRESENTED_OUTCOMES = new Set(['found', 'partial']);
/** Candidate-number offset of the Nano retry presentation (s1c101, s1c102, …). */
export const RETRY_ID_OFFSET = 100;
const COMPONENT_SPLIT = new RegExp(`\\s*(?:--|[${DASH_CLASS}])\\s*`);
/**
 * The ordered components of a heading: split on the separators (`--`, an en
 * or em dash, with any spaces), then normalizeLabel applied to EACH component.
 * `original` keeps the trimmed original text of each component for display.
 * @param {string} heading - Heading or label
 * @returns {{normalized:string[], original:string[]}}
 */
export const headingComponents = (heading) => {
  const original = String(heading ?? '').normalize('NFC').replace(WHITESPACE_RUN, ' ').split(COMPONENT_SPLIT).map((s) => s.trim());
  return { normalized: original.map((part) => normalizeLabel(part)), original };
};

/**
 * Spelling similarity for display only: round(100 * (1 - lev / max(len))) on normalized strings.
 * @param {string} label - Candidate label
 * @param {string} heading - Suggested heading
 * @returns {number}
 */
export const lexicalSimilarity = (label, heading) => {
  const a = normalizeLabel(label);
  const b = normalizeLabel(heading);
  const max = Math.max([...a].length, [...b].length);
  if (max === 0) return 100;
  return Math.round(100 * (1 - levenshteinDistance(a, b) / max));
};

/**
 * Subdivision bookkeeping (§5.5), on ordered normalized components.
 * @param {string} label - Chosen label
 * @param {string} heading - Suggested heading
 * @returns {{mainHeadingOnly:boolean, droppedSubdivisions:string[]}}
 */
export const subdivisionInfo = (label, heading) => {
  const chosen = headingComponents(label).normalized;
  const { normalized: suggested, original } = headingComponents(heading);
  const droppedSubdivisions = [];
  let at = 0;
  suggested.slice(1).forEach((part, i) => {
    const found = chosen.indexOf(part, at);
    if (found === -1) droppedSubdivisions.push(original[i + 1] ?? part);
    else at = found + 1;
  });
  const mainHeadingOnly = suggested.length > 1 && chosen.length === 1 && chosen[0] === suggested[0];
  return { mainHeadingOnly, droppedSubdivisions };
};

/**
 * Present the ranked candidates of the looked-up suggestions with `s{n}c{m}` ids.
 * @param {object[]} suggestions - Suggestions
 * @param {Object<string, object>} results - LookupResult by suggestionId
 * @param {number} perSuggestion - Candidates per suggestion
 * @param {{offset?:number}} [opts] - Candidate-number offset (the Nano retry uses a disjoint range)
 * @returns {{presented:object[], snapshot:Map<string,{suggestionId:string, cid:string}>}}
 */
export const presentCandidates = (suggestions, results, perSuggestion, { offset = 0 } = {}) => {
  const presented = [];
  const snapshot = new Map();
  for (const s of suggestions) {
    const result = results[s.id];
    if (!result || !PRESENTED_OUTCOMES.has(result.outcome) || result.candidates.length === 0) continue;
    const candidates = result.candidates.slice(0, perSuggestion).map((c, i) => {
      const pid = `${s.id}c${offset + i + 1}`;
      snapshot.set(pid, { suggestionId: s.id, cid: c.cid });
      return { pid, cid: c.cid, label: c.label, authority: c.authority, matchClass: c.matchClass };
    });
    presented.push({ suggestionId: s.id, heading: s.heading, kind: s.kind, candidates });
  }
  return { presented, snapshot };
};

/**
 * Validate the AI answer against the presentation snapshot (§5.1).
 * @param {{selections:object[], additional:object[]}} json - Schema-valid answer
 * @param {{presented:object[], snapshot:Map}} presentation - The snapshot of THIS call
 * @returns {{choices:Object<string,{cid:string|null, confidence:number}>, additional:Array<{cid:string, confidence:number}>, invalidCount:number}}
 */
export const validateSelectAnswer = (json, { presented, snapshot }) => {
  const presentedIds = new Set(presented.map((p) => p.suggestionId));
  const seen = new Set();
  const choices = {};
  let invalidCount = 0;
  for (const item of json.selections) {
    const first = !seen.has(item.suggestionId);
    seen.add(item.suggestionId);
    const target = snapshot.get(item.choice);
    const validChoice = item.choice === 'none' || (target && target.suggestionId === item.suggestionId);
    if (!first || !presentedIds.has(item.suggestionId) || !validChoice) {
      invalidCount += 1;
      continue;
    }
    choices[item.suggestionId] = { cid: item.choice === 'none' ? null : target.cid, confidence: item.confidence };
  }
  const chosen = new Set(Object.values(choices).map((c) => c.cid).filter(Boolean));
  const additional = [];
  for (const item of json.additional) {
    const target = snapshot.get(item.choice);
    if (!target || chosen.has(target.cid) || additional.some((a) => a.cid === target.cid) || additional.length >= 3) {
      invalidCount += 1;
      continue;
    }
    // `suggestionId` records which candidate list the pick came from (§9 dependency check).
    additional.push({ cid: target.cid, confidence: item.confidence, suggestionId: target.suggestionId });
  }
  return { choices, additional, invalidCount };
};

/**
 * Exact-only fallback (§5.3): the unique `exact-full` candidate, else none.
 * @param {object[]} suggestions - Suggestions
 * @param {Object<string, object>} results - LookupResult by suggestionId
 * @returns {Object<string,{cid:string|null}>}
 */
export const exactOnlyChoices = (suggestions, results) => {
  const choices = {};
  for (const s of suggestions) {
    const result = results[s.id];
    if (!result || !PRESENTED_OUTCOMES.has(result.outcome)) continue;
    const exact = result.candidates.filter((c) => c.matchClass === 'exact-full');
    choices[s.id] = { cid: exact.length === 1 ? exact[0].cid : null };
  }
  return choices;
};

/**
 * The model-written text of the selection request: the suggested headings and
 * kinds placed in the prompt. Candidate labels and ids come from LC records,
 * and the bibliographic fields are the user's own input.
 * @param {{presented:object[]}} presentation - The presentation of THIS call
 * @returns {object[]}
 */
export const modelTextOfSelectRequest = (presentation) => presentation.presented.map(({ heading, kind }) => ({ heading, kind }));

const callSelect = async (generateImpl, cfg, info, presentation, signal) => {
  // P6 fix 14 (finding 4): the selection request is a network exit. Nothing is
  // sent when its model-written text repeats the selection provider's key or
  // any other known key (every stored key, every key a run used).
  const keys = [cfg?.apiKey, ...documentKeys()];
  guardExit('display', modelTextOfSelectRequest(presentation), keys);
  // P6 fix 15 (item 2): the FINISHED prompt too — exactly the text sent —
  // because formatting can assemble a key from parts that pass on their own
  // (heading `Cats` + kind `topical` → `"Cats" (kind: topical)`).
  const prompt = buildSelectPrompt(info, presentation.presented);
  // Its own message (P6 fix 16): the hit may come from the user's text or the
  // fixed instructions, not from a model answer.
  guardExit('prompt', [prompt.system, prompt.userText, ...textFields(prompt.userText)], keys);
  const result = await generateImpl(cfg, {
    ...prompt,
    schema: SELECT_SCHEMA, temperature: 0.1, maxOutputTokens: 2048, signal
  });
  const validated = validateSelectAnswer(result.json, presentation);
  if (validated.invalidCount > 0) console.warn('[select]', { invalid_selection: validated.invalidCount });
  return validated;
};

/**
 * Run the AI selection with ONE config snapshot (§5.1, §5.2, §10).
 * `cancelled` and the "stop" kinds are thrown; the automatic kinds return
 * the exact-only fallback.
 * @param {{cfg:object, bibliographicInfo:object, suggestions:object[], results:Object<string,object>,
 *   signal?:AbortSignal, generateImpl?:Function}} args - Snapshot, inputs, signal
 * @returns {Promise<{mode:'ai'|'exact-fallback', choices:object, additional:object[], called:boolean, fallbackKind?:string}>}
 */
export async function runAiSelect({ cfg, bibliographicInfo, suggestions, results, signal, generateImpl = defaultGenerate }) {
  const info = budgetBibliographic(bibliographicInfo, cfg);
  let presentation = presentCandidates(suggestions, results, candidateLimit(cfg));
  if (presentation.presented.length === 0) return { mode: 'ai', choices: {}, additional: [], called: false };
  const fallback = (kind) => ({
    mode: 'exact-fallback', choices: exactOnlyChoices(suggestions, results), additional: [], called: true, fallbackKind: kind
  });
  try {
    return { mode: 'ai', ...(await callSelect(generateImpl, cfg, info, presentation, signal)), called: true };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (!(err.kind === 'too_long' && isNano(cfg))) {
      if (AUTO_FALLBACK_KINDS.has(err.kind)) return fallback(err.kind);
      throw err;
    }
  }
  // Nano too_long: ONE retry with 2 candidates per suggestion, NEW ids disjoint
  // from the first attempt (candidate numbers offset by 100) and a NEW snapshot.
  presentation = presentCandidates(suggestions, results, NANO_RETRY_CANDIDATES, { offset: RETRY_ID_OFFSET });
  try {
    return { mode: 'ai', ...(await callSelect(generateImpl, cfg, info, presentation, signal)), called: true };
  } catch (err) {
    if (err instanceof ProviderError && AUTO_FALLBACK_KINDS.has(err.kind)) return fallback(err.kind);
    throw err;
  }
}

const findCandidate = (results, suggestionId, cid) => (results[suggestionId]?.candidates || []).find((c) => c.cid === cid) || null;

/**
 * The effective Selection of every suggestion: manual choices win over AI or exact choices.
 * @param {{suggestions:object[], results:Object<string,object>, mode:'ai'|'exact-fallback'|null,
 *   choices?:object, manual?:Object<string,{cid:string|null}>}} args - Inputs
 * @returns {object[]} - Selections in suggestion order
 */
export const mergeSelections = ({ suggestions, results, mode, choices = {}, manual = {} }) => suggestions.map((s) => {
  const result = results[s.id];
  const pick = (cid, method, confidence = null) => {
    const candidate = findCandidate(results, s.id, cid);
    if (!candidate) return makeSelection({ suggestionId: s.id, method: 'none', noneReason: 'not-chosen' });
    return makeSelection({
      suggestionId: s.id, cid, method, confidence,
      lexicalSimilarity: lexicalSimilarity(candidate.label, s.heading),
      ...subdivisionInfo(candidate.label, s.heading)
    });
  };
  if (!result || result.outcome === 'failed') return makeSelection({ suggestionId: s.id, noneReason: 'lookup-failed' });
  if (result.outcome === 'no-results') return makeSelection({ suggestionId: s.id, noneReason: 'no-results' });
  const own = Object.hasOwn(manual, s.id) ? manual[s.id] : undefined;
  if (own) {
    if (own.cid === null) return makeSelection({ suggestionId: s.id, method: 'manual', noneReason: 'manual-none' });
    return pick(own.cid, 'manual');
  }
  const choice = choices[s.id];
  if (mode === 'exact-fallback' && choice) {
    return choice.cid ? pick(choice.cid, 'exact') : makeSelection({ suggestionId: s.id, noneReason: 'ai-unavailable' });
  }
  if (mode === 'ai' && choice) {
    return choice.cid ? pick(choice.cid, 'ai', choice.confidence) : makeSelection({ suggestionId: s.id, noneReason: 'ai-chose-none' });
  }
  return makeSelection({ suggestionId: s.id, noneReason: 'not-chosen' });
});

/**
 * One Recommendation per distinct cid (§5.6): suggestion order, then additional order.
 * @param {{selections:object[], additional?:Array<{cid:string, confidence:number}>, results:Object<string,object>}} args - Inputs
 * @returns {object[]}
 */
export const buildRecommendations = ({ selections, additional = [], results }) => {
  const byCid = new Map();
  const allCandidates = Object.values(results).flatMap((r) => r?.candidates || []);
  const add = (cid, entry, suggestionId) => {
    if (!byCid.has(cid)) {
      const c = (suggestionId && findCandidate(results, suggestionId, cid)) || allCandidates.find((x) => x.cid === cid);
      if (!c) return;
      byCid.set(cid, {
        cid, label: c.label, authority: c.authority, localId: c.localId, uri: c.uri, source: c.source,
        selections: [], marc: buildMarc(c)
      });
    }
    byCid.get(cid).selections.push(entry);
  };
  for (const s of selections) {
    if (!s.cid) continue;
    add(s.cid, { suggestionId: s.suggestionId, method: s.method, confidence: s.confidence, lexicalSimilarity: s.lexicalSimilarity }, s.suggestionId);
  }
  const chosen = new Set(byCid.keys());
  for (const a of additional) {
    if (chosen.has(a.cid)) continue;
    chosen.add(a.cid);
    add(a.cid, { suggestionId: null, method: 'ai', confidence: a.confidence, lexicalSimilarity: null }, null);
  }
  return [...byCid.values()];
};

/**
 * The subdivision note of a recommendation (§7), or null.
 * @param {object} rec - Recommendation
 * @param {object[]} selections - Selections
 * @returns {string|null}
 */
export const subdivisionNote = (rec, selections) => {
  const dropped = selections
    .filter((s) => s.cid === rec.cid && s.droppedSubdivisions.length > 0)
    .flatMap((s) => s.droppedSubdivisions);
  if (dropped.length === 0) return null;
  return `The selected heading does not include these suggested subdivisions: ${[...new Set(dropped)].join(', ')}`;
};
