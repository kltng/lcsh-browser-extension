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
const wellFormed = (marc) => isStr(marc.tag) && isStr(marc.ind1) && isStr(marc.ind2)
  && Array.isArray(marc.subfields) && marc.subfields.length > 0
  && marc.subfields.every((p) => Array.isArray(p) && p.length === 2 && isStr(p[0]) && isStr(p[1]));

/**
 * The text form of a MARC field with the chosen delimiter. Only a
 * `from-authority` field is formatted, from its existing tag, indicators and
 * ordered `[code, value]` subfields; the delimiter replaces `$` only at the
 * structural subfield boundaries (values are never touched). A malformed
 * historical structure is not repaired: its stored text is shown as it is.
 * @param {object} marc - A MARC field (buildMarc() shape)
 * @param {string} [delimiter] - `$` or `‡`
 * @returns {string|null} - null for a field that is not from the authority
 */
export const formatMarcField = (marc, delimiter = DEFAULT_DELIMITER) => {
  if (!marc || marc.status !== 'from-authority') return null;
  if (!wellFormed(marc)) return isStr(marc.text) ? marc.text : null;
  const d = resolveDelimiter(delimiter);
  return `${marc.tag} ${marc.ind1}${marc.ind2} ${marc.subfields.map(([code, value]) => `${d}${code} ${value}`).join(' ')}`;
};

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
