/**
 * Data model of the P4 pipeline (SPEC-P4 §2): JSDoc typedefs, enums,
 * validators and factories. Candidates are built only by lookup/hit.js.
 */

/**
 * @typedef {{id:string, heading:string, kind:'topical'|'geographic'|'name'|'genre'|'unknown', reason:string}} Suggestion
 * Model output; never shown as verified.
 */
/**
 * @typedef {{cid:string, authority:'lcsh'|'lcnaf'|'lcgft', localId:string, uri:string, label:string,
 *   marcKey:string|null, rdfTypes:string[], matchClass:string, source:'loc-api'}} Candidate
 * Only from a lookup backend.
 */
/**
 * @typedef {{suggestionId:string, outcome:'found'|'no-results'|'failed'|'partial',
 *   candidates:Candidate[], errorKind:string|null, searchedAt:string}} LookupResult
 */
/**
 * @typedef {{suggestionId:string, cid:string|null, method:'ai'|'exact'|'manual'|'none',
 *   noneReason:string|null, confidence:number|null, lexicalSimilarity:number|null,
 *   mainHeadingOnly:boolean, droppedSubdivisions:string[]}} Selection
 */
/**
 * @typedef {{cid:string, label:string, authority:string, localId:string, uri:string, source:string,
 *   selections:Array<{suggestionId:string|null, method:string, confidence:number|null, lexicalSimilarity:number|null}>,
 *   marc:{status:'from-authority'|'unavailable', tag:string|null, ind1:string|null, ind2:string|null,
 *   subfields:Array<[string,string]>, text:string|null, reason:string|null}}} Recommendation
 */

export const KINDS = ['topical', 'geographic', 'name', 'genre', 'unknown'];
export const AUTHORITIES = ['lcsh', 'lcnaf', 'lcgft'];
export const OUTCOMES = ['found', 'no-results', 'failed', 'partial'];
export const METHODS = ['ai', 'exact', 'manual', 'none'];
export const MATCH_CLASSES = ['exact-full', 'exact-main', 'prefix-full', 'prefix-main', 'keyword'];
/** §2 lists five reasons; §5.4/§5.5 add 'manual-none' for "Use none". */
export const NONE_REASONS = ['lookup-failed', 'no-results', 'ai-chose-none', 'ai-unavailable', 'not-chosen', 'manual-none'];
export const LOOKUP_ERROR_KINDS = ['network', 'timeout', 'rate_limit', 'server', 'invalid_output', 'cancelled'];

/** The authority badges shown in the UI. */
export const AUTHORITY_LABELS = { lcsh: 'LCSH', lcnaf: 'LC Names', lcgft: 'LCGFT' };

/** noneReason in words (§7). */
export const NONE_REASON_WORDS = {
  'lookup-failed': 'the lookup failed',
  'no-results': 'no match returned by this search',
  'ai-chose-none': 'the AI chose none of the candidates',
  'ai-unavailable': 'no unique exact match (the AI did not choose)',
  'not-chosen': 'no candidate was chosen',
  'manual-none': 'You chose none'
};

const isStr = (v) => typeof v === 'string';
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Build a Suggestion.
 * @param {{id:string, heading:string, kind?:string, reason?:string}} parts - Fields
 * @returns {Suggestion}
 */
export const makeSuggestion = ({ id, heading, kind = 'unknown', reason = '' }) => ({
  id: String(id),
  heading: String(heading),
  kind: KINDS.includes(kind) ? kind : 'unknown',
  reason: isStr(reason) ? reason : ''
});

/**
 * Whether a value has the Candidate shape.
 * @param {any} c - Value
 * @returns {boolean}
 */
export const isCandidate = (c) => Boolean(c)
  && isStr(c.cid) && AUTHORITIES.includes(c.authority) && isStr(c.localId) && c.cid === `${c.authority}:${c.localId}`
  && isStr(c.uri) && isStr(c.label) && (c.marcKey === null || isStr(c.marcKey))
  && Array.isArray(c.rdfTypes) && MATCH_CLASSES.includes(c.matchClass) && c.source === 'loc-api';

/**
 * Build a LookupResult.
 * @param {{suggestionId:string, outcome:string, candidates?:Candidate[], errorKind?:string|null, searchedAt?:string}} parts - Fields
 * @returns {LookupResult}
 */
export const makeLookupResult = ({ suggestionId, outcome, candidates = [], errorKind = null, searchedAt }) => ({
  suggestionId,
  outcome: OUTCOMES.includes(outcome) ? outcome : 'failed',
  candidates,
  errorKind: errorKind ?? null,
  searchedAt: searchedAt || new Date().toISOString()
});

/**
 * Build a Selection (defaults: no choice).
 * @param {Partial<Selection> & {suggestionId:string}} parts - Fields
 * @returns {Selection}
 */
export const makeSelection = ({
  suggestionId, cid = null, method = 'none', noneReason = null, confidence = null,
  lexicalSimilarity = null, mainHeadingOnly = false, droppedSubdivisions = []
}) => ({
  suggestionId,
  cid,
  method,
  noneReason: cid === null ? noneReason : null,
  confidence: method === 'ai' && isIntIn(confidence, 0, 100) ? confidence : null,
  lexicalSimilarity: isIntIn(lexicalSimilarity, 0, 100) ? lexicalSimilarity : null,
  mainHeadingOnly: Boolean(mainHeadingOnly),
  droppedSubdivisions: [...droppedSubdivisions]
});

/**
 * Whether a value is a valid Selection.
 * @param {any} s - Value
 * @returns {boolean}
 */
export const isSelection = (s) => Boolean(s) && isStr(s.suggestionId)
  && (s.cid === null || isStr(s.cid)) && METHODS.includes(s.method)
  && (s.cid === null ? NONE_REASONS.includes(s.noneReason) : s.noneReason === null)
  && (s.confidence === null || (s.method === 'ai' && isIntIn(s.confidence, 0, 100)))
  && (s.lexicalSimilarity === null || isIntIn(s.lexicalSimilarity, 0, 100))
  && typeof s.mainHeadingOnly === 'boolean' && Array.isArray(s.droppedSubdivisions);
