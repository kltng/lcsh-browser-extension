/**
 * SPEC-UI2 §3 and §4: the display order of recommendations and the subfield
 * delimiter of authority MARC fields. Presentation only: the run state and
 * history keep the canonical `$` text and the unchanged structured fields,
 * and nothing here adds a MARC mapping or invents authority data.
 */

/** The output preference: `$` (default) or `‡`. */
export const SUBFIELD_DELIMITERS = ['$', '‡'];
export const DEFAULT_DELIMITER = '$';

/**
 * A stored delimiter preference, resolved: anything missing or invalid is `$`.
 * @param {any} value - Stored preference
 * @returns {'$'|'‡'}
 */
export const resolveDelimiter = (value) => (SUBFIELD_DELIMITERS.includes(value) ? value : DEFAULT_DELIMITER);

const isStr = (v) => typeof v === 'string';
// The shapes buildMarc() emits (ui-2b item 5): a 3-digit tag, one indicator
// character each, a one-character lowercase-letter-or-digit code and a
// non-empty value per subfield.
const TAG_RE = /^\d{3}$/;
const INDICATOR_RE = /^[0-9 _#\\]$/;
const CODE_RE = /^[a-z0-9]$/;

/**
 * Whether a stored field's structure may be used to rebuild its text: every
 * part has the builder's shape, and nothing was malformed or filtered out
 * when the entry was reloaded (`structureMalformed`, set by history).
 * @param {object} marc - A from-authority MARC field
 * @returns {boolean}
 */
export const isWellFormedMarc = (marc) => marc.structureMalformed !== true
  && isStr(marc.tag) && TAG_RE.test(marc.tag)
  && isStr(marc.ind1) && INDICATOR_RE.test(marc.ind1)
  && isStr(marc.ind2) && INDICATOR_RE.test(marc.ind2)
  && Array.isArray(marc.subfields) && marc.subfields.length > 0
  && marc.subfields.every((p) => Array.isArray(p) && p.length === 2
    && isStr(p[0]) && CODE_RE.test(p[0]) && isStr(p[1]) && p[1] !== '');

/**
 * The text form of a MARC field with the chosen delimiter, and whether it was
 * reformatted. Only a well-formed `from-authority` field is rebuilt, from its
 * tag, indicators and ordered `[code, value]` subfields; the delimiter
 * replaces `$` only at the structural subfield boundaries (values are never
 * touched). A malformed or filtered structure is never used: the stored
 * canonical text is returned unchanged (with `$`) and `reformatted` is false.
 * @param {object} marc - A MARC field (buildMarc() shape)
 * @param {string} [delimiter] - `$` or `‡`
 * @returns {{text:string|null, reformatted:boolean}|null} - null for a field that is not from the authority
 */
export const formatMarc = (marc, delimiter = DEFAULT_DELIMITER) => {
  if (!marc || marc.status !== 'from-authority') return null;
  if (!isWellFormedMarc(marc)) return { text: isStr(marc.text) ? marc.text : null, reformatted: false };
  const d = resolveDelimiter(delimiter);
  const text = `${marc.tag} ${marc.ind1}${marc.ind2} ${marc.subfields.map(([code, value]) => `${d}${code} ${value}`).join(' ')}`;
  return { text, reformatted: true };
};

/**
 * The text of formatMarc() alone.
 * @param {object} marc - A MARC field
 * @param {string} [delimiter] - `$` or `‡`
 * @returns {string|null} - null for a field that is not from the authority
 */
export const formatMarcField = (marc, delimiter = DEFAULT_DELIMITER) => formatMarc(marc, delimiter)?.text ?? null;

/** Shown next to a stored field whose structure could not be used (ui-2b item 5). */
export const NOT_REFORMATTED_NOTE = 'Shown as saved: this field was not reformatted because its saved structure is incomplete.';

/** §3: the subject tags first, in this order; other three-digit tags follow ascending. */
export const TAG_ORDER = ['600', '610', '611', '630', '647', '648', '650', '651', '655'];

/**
 * The sort rank of one recommendation, ONLY from its successfully built MARC
 * field (never from kind, wording or authority). A field that is not
 * `from-authority` goes last.
 * @param {object} rec - Recommendation
 * @returns {number}
 */
const rankOf = (rec) => {
  const marc = rec?.marc;
  if (!marc || marc.status !== 'from-authority' || !/^\d{3}$/.test(String(marc.tag))) return Number.POSITIVE_INFINITY;
  const at = TAG_ORDER.indexOf(marc.tag);
  return at >= 0 ? at : TAG_ORDER.length + Number(marc.tag);
};

/**
 * Stably sort recommendations by MARC tag (SPEC-UI2 §3). Ties — equal tags
 * and unavailable fields — keep the canonical order they come in
 * (suggestion order, then additional order). Selections inside a
 * recommendation are not reordered.
 * @param {object[]} recommendations - In canonical order
 * @returns {object[]}
 */
export const sortRecommendations = (recommendations) => recommendations
  .map((rec, index) => ({ rec, index, rank: rankOf(rec) }))
  .sort((a, b) => (a.rank === b.rank ? a.index - b.index : (a.rank < b.rank ? -1 : 1)))
  .map((x) => x.rec);
