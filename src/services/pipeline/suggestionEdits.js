/**
 * SPEC-UI2 §2: the user's edits of the suggestions before lookup — remove,
 * edit a heading's text (or kind), add a heading of their own. Pure functions;
 * the workflow applies an accepted edit in ONE atomic transition
 * (run.js editSuggestions). Nothing here creates a candidate or touches
 * authority data: user text is only ever a search heading.
 */
import { normalizeLabel } from '../lookup/normalize';
import { hasLetterOrNumber } from '../lookup/searchText';
import { makeSuggestion } from './types';
import { MAX_SUGGESTIONS } from './suggest';

/** The kinds a NEW heading may have (`unknown` stays only on existing text-fallback headings). */
export const EDITABLE_KINDS = ['topical', 'name', 'geographic', 'genre'];
/** How each kind is named in the editor. */
export const KIND_LABELS = { topical: 'Topical', name: 'Name', geographic: 'Geographic', genre: 'Genre/form', unknown: 'Unknown' };
export const MAX_HEADING_CODE_POINTS = 200;

export const EDIT_ERRORS = {
  empty: 'Enter a heading.',
  tooLong: `A heading can have at most ${MAX_HEADING_CODE_POINTS} characters.`,
  noLetter: 'A heading needs at least one letter or number.',
  duplicate: 'This heading is already in the list.',
  kind: 'Choose a kind.',
  full: `At most ${MAX_SUGGESTIONS} suggestions.`,
  missing: 'This suggestion is no longer in the list.'
};

/**
 * Check one heading's text against the list (trimmed; 1–200 code points; a
 * letter or number; no duplicate under normalizeLabel).
 * @param {string} text - The typed heading
 * @param {object[]} suggestions - The current suggestions
 * @param {string|null} [exceptId] - The suggestion being edited (not a duplicate of itself)
 * @returns {{ok:true, heading:string}|{ok:false, error:string}}
 */
export const checkHeading = (text, suggestions, exceptId = null) => {
  const heading = String(text ?? '').trim();
  const length = [...heading].length;
  if (length === 0) return { ok: false, error: EDIT_ERRORS.empty };
  if (length > MAX_HEADING_CODE_POINTS) return { ok: false, error: EDIT_ERRORS.tooLong };
  if (!hasLetterOrNumber(heading)) return { ok: false, error: EDIT_ERRORS.noLetter };
  const key = normalizeLabel(heading);
  if (suggestions.some((s) => s.id !== exceptId && normalizeLabel(s.heading) === key)) {
    return { ok: false, error: EDIT_ERRORS.duplicate };
  }
  return { ok: true, heading };
};

const idNumber = (id) => {
  const m = /^s(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
};

/**
 * The run's id counter: never lower than any id ever issued in the run, so
 * an id is never given to a second heading (no reassignment). Ids stay within
 * the selection schema's limits (`s<n>`, at most 8 characters).
 * @param {{suggestions:object[], lastIdNumber?:number}} suggest - The suggest result
 * @returns {number}
 */
export const lastIdNumberOf = (suggest) => Math.max(
  Number.isInteger(suggest?.lastIdNumber) ? suggest.lastIdNumber : 0,
  ...(suggest?.suggestions || []).map((s) => idNumber(s.id))
);

/**
 * Apply one edit to the list.
 * @param {{suggestions:object[], lastIdNumber?:number}} suggest - The current suggest result
 * @param {{type:'add', heading:string, kind:string}|{type:'edit', id:string, heading:string, kind?:string}|{type:'remove', id:string}} edit - The edit
 * @returns {{ok:true, changed:boolean, suggestions:object[], lastIdNumber:number}|{ok:false, error:string}}
 */
export const applySuggestionEdit = (suggest, edit) => {
  const suggestions = suggest?.suggestions || [];
  const last = lastIdNumberOf(suggest);
  if (edit.type === 'remove') {
    if (!suggestions.some((s) => s.id === edit.id)) return { ok: false, error: EDIT_ERRORS.missing };
    return { ok: true, changed: true, suggestions: suggestions.filter((s) => s.id !== edit.id), lastIdNumber: last };
  }
  if (edit.type === 'add') {
    if (suggestions.length >= MAX_SUGGESTIONS) return { ok: false, error: EDIT_ERRORS.full };
    if (!EDITABLE_KINDS.includes(edit.kind)) return { ok: false, error: EDIT_ERRORS.kind };
    const checked = checkHeading(edit.heading, suggestions);
    if (!checked.ok) return checked;
    const id = `s${last + 1}`;
    if (id.length > 8) return { ok: false, error: EDIT_ERRORS.full };
    // An added heading is the user's, with an empty reason.
    const added = makeSuggestion({ id, heading: checked.heading, kind: edit.kind, reason: '', source: 'user' });
    return { ok: true, changed: true, suggestions: [...suggestions, added], lastIdNumber: last + 1 };
  }
  if (edit.type === 'edit') {
    const current = suggestions.find((s) => s.id === edit.id);
    if (!current) return { ok: false, error: EDIT_ERRORS.missing };
    const kind = edit.kind ?? current.kind;
    // An existing text-fallback heading may keep `unknown`; any other kind must be one of the four.
    if (!(EDITABLE_KINDS.includes(kind) || (kind === 'unknown' && current.kind === 'unknown'))) {
      return { ok: false, error: EDIT_ERRORS.kind };
    }
    const checked = checkHeading(edit.heading, suggestions, current.id);
    if (!checked.ok) return checked;
    // A no-op Apply changes nothing, not even the authorship.
    if (checked.heading === current.heading && kind === current.kind) {
      return { ok: true, changed: false, suggestions, lastIdNumber: last };
    }
    // An applied change makes the text the user's; the old AI reason no longer applies.
    const edited = makeSuggestion({ id: current.id, heading: checked.heading, kind, reason: '', source: 'user' });
    return { ok: true, changed: true, suggestions: suggestions.map((s) => (s.id === current.id ? edited : s)), lastIdNumber: last };
  }
  return { ok: false, error: EDIT_ERRORS.missing };
};
