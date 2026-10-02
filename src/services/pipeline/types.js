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
 *   marcKey:string|null, rdfTypes:string[], matchClass:string, source:'loc-api'|'local-db',
 *   via?:'label'|'variant'|'replacement', replacementFrom?:Array<{authority:string, localId:string, label:string}>,
 *   marcKeySource?:'loc-api'}} Candidate
 * Only from a lookup backend. `via` and `replacementFrom` are display only (SPEC-P5 §5).
 */
/**
 * @typedef {{suggestionId:string, outcome:'found'|'no-results'|'failed'|'partial',
 *   candidates:Candidate[], errorKind:string|null, searchedAt:string,
 *   provenance:{backend:string, profile:string|null, release:string|null, releaseCommit:string|null, file:string|null},
 *   replacementNotes:object[]}} LookupResult
 * SPEC-P5 §6.4 adds `provenance` and `replacementNotes`.
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
/** `local_db` is the P5 kind of a failed local part (SPEC-P5 §6.4). */
export const LOOKUP_ERROR_KINDS = ['network', 'timeout', 'rate_limit', 'server', 'invalid_output', 'cancelled', 'local_db', 'key_echo'];
export const SOURCES = ['loc-api', 'local-db'];
export const VIAS = ['label', 'variant', 'replacement'];
/** Backends a lookup result can name (SPEC-P5 §6.4). */
export const BACKENDS = ['loc-api', 'local-db', 'mixed'];
/** A result with no local installation behind it (pre-P5 entries default to this, §9). */
export const ONLINE_PROVENANCE = { backend: 'loc-api', profile: null, release: null, releaseCommit: null, file: null };

/** MARC reasons added by SPEC-P5 §7, next to the P4 reasons built in marc.js. */
export const NAME_KEY_REASONS = {
  offline: 'MARC not available offline',
  failed: 'Name MARC-key lookup failed',
  'no-match': 'No matching name returned by this search'
};

/** The authority badges shown in the UI. */
export const AUTHORITY_LABELS = { lcsh: 'LCSH', lcnaf: 'LC Names', lcgft: 'LCGFT' };

/** Why a replacement could not be shown as a candidate (SPEC-P5 §5). */
export const REPLACEMENT_NOTE_WORDS = {
  'not-in-database': 'replacement not in this database',
  'deprecated-target': 'the replacement is itself an old heading'
};

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
  && Array.isArray(c.rdfTypes) && MATCH_CLASSES.includes(c.matchClass) && SOURCES.includes(c.source)
  && (c.via === undefined || VIAS.includes(c.via));

/**
 * The §6.4 provenance of a lookup, with the online default for anything missing.
 * @param {object|undefined} p - Raw provenance
 * @returns {{backend:string, profile:string|null, release:string|null, releaseCommit:string|null, file:string|null}}
 */
export const makeProvenance = (p) => {
  const strOrNull = (v) => (isStr(v) ? v : null);
  if (!p || typeof p !== 'object') return { ...ONLINE_PROVENANCE };
  return {
    backend: BACKENDS.includes(p.backend) ? p.backend : 'loc-api',
    profile: strOrNull(p.profile),
    release: strOrNull(p.release),
    releaseCommit: strOrNull(p.releaseCommit),
    file: strOrNull(p.file)
  };
};

/**
 * Build a LookupResult. SPEC-P5 §6.4: the factory no longer drops the two
 * additive fields; a result without them describes an online lookup.
 * @param {{suggestionId:string, outcome:string, candidates?:Candidate[], errorKind?:string|null,
 *   searchedAt?:string, provenance?:object, replacementNotes?:object[]}} parts - Fields
 * @returns {LookupResult}
 */
export const makeLookupResult = ({
  suggestionId, outcome, candidates = [], errorKind = null, searchedAt, provenance, replacementNotes
}) => ({
  suggestionId,
  outcome: OUTCOMES.includes(outcome) ? outcome : 'failed',
  candidates,
  errorKind: errorKind ?? null,
  searchedAt: searchedAt || new Date().toISOString(),
  provenance: makeProvenance(provenance),
  replacementNotes: Array.isArray(replacementNotes) ? replacementNotes : []
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
