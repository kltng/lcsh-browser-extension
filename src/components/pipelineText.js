/**
 * Display wording of the pipeline states (SPEC-P4 §7). The honesty rule
 * applies: no text claims more than what happened.
 */
import { NONE_REASON_WORDS, AUTHORITY_LABELS } from '../services/pipeline/types';
import { lookupErrorMessage } from '../services/lookup/scheduler';

export const SUGGESTION_NOTE = 'These are AI suggestions. The next step looks them up at the Library of Congress.';
export const NO_MATCH_TEXT = 'No match returned by this search';

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
  return `Lookup failed: ${lookupErrorMessage(result.errorKind)}`;
};

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
