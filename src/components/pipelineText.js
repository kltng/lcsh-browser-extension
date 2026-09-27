/**
 * Display wording of the pipeline states (SPEC-P4 §7). The honesty rule
 * applies: no text claims more than what happened.
 */
import { NONE_REASON_WORDS, AUTHORITY_LABELS, REPLACEMENT_NOTE_WORDS } from '../services/pipeline/types';
import { lookupErrorMessage } from '../services/lookup/scheduler';

export const SUGGESTION_NOTE = 'These are AI suggestions. The next step looks them up at the Library of Congress.';
export const NO_MATCH_TEXT = 'No match returned by this search';
export const LOCAL_DB_ERROR_TEXT = 'The local database could not answer this search';
/** `via` in words (SPEC-P5 §8). A variant match is never an automatic exact acceptance. */
export const VIA_WORDS = { variant: 'matched a variant name', replacement: 'replaces an old heading' };

/**
 * The outcome line of a lookup result.
 * @param {object|undefined} result - LookupResult
 * @param {boolean} pending - A lookup is running
 * @returns {string}
 */
export const outcomeLine = (result, pending) => {
  if (pending) return 'Searching the Library of Congress…';
  if (!result) return 'Not looked up yet';
  const n = result.candidates.length;
  const count = `${n} candidate${n === 1 ? '' : 's'}`;
  if (result.outcome === 'found') return count;
  if (result.outcome === 'partial') return `${count} (some searches failed)`;
  if (result.outcome === 'no-results') return NO_MATCH_TEXT;
  return `Lookup failed: ${localAwareMessage(result.errorKind)}`;
};

/**
 * The message of a lookup error kind, including the P5 `local_db` kind.
 * @param {string|null} kind - Error kind
 * @returns {string}
 */
export function localAwareMessage(kind) {
  return kind === 'local_db' ? LOCAL_DB_ERROR_TEXT : lookupErrorMessage(kind);
}

/**
 * Where a candidate list came from (SPEC-P5 §8): the local database with its
 * release, the Library of Congress online, or both for mixed routing.
 * @param {object|undefined} provenance - LookupResult provenance
 * @returns {string}
 */
export const sourceLine = (provenance) => {
  const backend = provenance?.backend || 'loc-api';
  const local = provenance?.release ? `Local database (release ${provenance.release})` : 'Local database';
  if (backend === 'local-db') return local;
  if (backend === 'mixed') return `${local} and Library of Congress online`;
  return 'Library of Congress online';
};

/**
 * One candidate's retrieval note, or null (display only; it never changes the
 * match class).
 * @param {object} candidate - Candidate
 * @returns {string|null}
 */
export const viaNote = (candidate) => {
  const from = candidate?.replacementFrom || [];
  if (from.length > 0) return `replaces the old heading ${from.map((f) => f.label).join(', ')}`;
  return VIA_WORDS[candidate?.via] || null;
};

/**
 * An unresolved replacement note in words (SPEC-P5 §5, §8).
 * @param {object} note - Replacement note
 * @returns {string}
 */
export const replacementNoteText = (note) =>
  `The old heading ${note.fromLabel} names a replacement (${note.targetLocalId}): ${REPLACEMENT_NOTE_WORDS[note.reason]}.`;

/**
 * The current choice of a suggestion, in words.
 * @param {object|undefined} selection - Selection
 * @param {{mode:string|null, hasManual:boolean}} ctx - Selection mode and whether a manual choice exists
 * @returns {string}
 */
export const choiceText = (selection, { mode, hasManual }) => {
  if (!selection) return 'No choice yet';
  if (selection.method === 'ai') return `AI choice (confidence ${selection.confidence})`;
  if (selection.method === 'exact') return 'Exact match';
  if (selection.method === 'manual') return selection.cid ? 'Your choice' : NONE_REASON_WORDS['manual-none'];
  if (selection.noneReason === 'not-chosen' && !mode && !hasManual) return 'No choice yet';
  return `None — ${NONE_REASON_WORDS[selection.noneReason] || 'no candidate was chosen'}`;
};

/**
 * One selection of a recommendation, in words.
 * @param {{suggestionId:string|null, method:string, confidence:number|null}} entry - Recommendation selection
 * @returns {string}
 */
export const methodText = (entry) => {
  if (entry.method === 'ai') {
    return entry.suggestionId === null
      ? `Additional AI pick (confidence ${entry.confidence})`
      : `AI choice (confidence ${entry.confidence})`;
  }
  if (entry.method === 'exact') return 'Exact match';
  if (entry.method === 'manual') return 'Your choice';
  return 'None';
};

/**
 * The authority badge text.
 * @param {string} authority - lcsh | lcnaf | lcgft
 * @returns {string}
 */
export const authorityLabel = (authority) => AUTHORITY_LABELS[authority] || authority;

/**
 * The web link of an id.loc.gov URI (https form of the same record).
 * @param {string} uri - Candidate URI
 * @returns {string}
 */
export const lcLink = (uri) => String(uri).replace(/^http:\/\//, 'https://');
