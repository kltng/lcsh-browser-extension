/**
 * Exports of step 4 (SPEC-P4 §7): Copy all and CSV. Recommendations only;
 * every heading, LC ID and link comes from a Candidate.
 */
import { buildCsv } from '../../utils/csv';
import { subdivisionNote } from './select';
import { formatMarcField, DEFAULT_DELIMITER } from './marcFormat';

export const COPY_ALL_HEADER = 'Headings from id.loc.gov; MARC fields generated from LC authority keys';
/** SPEC-P5 §9 adds `marc_reason` (empty when MARC is available). */
export const CSV_COLUMNS = [
  'label', 'lc_id', 'uri', 'authority', 'marc_field', 'marc_status', 'marc_reason', 'methods', 'confidence', 'subdivision_note', 'source',
  // SPEC-UI2 §2: who wrote each linked suggestion, aligned with `methods` / `confidence`.
  'suggestion_sources'
];

/**
 * The authorship of each selection of a recommendation (SPEC-UI2 §2): 'ai'
 * or 'user' for a linked suggestion, null for an additional pick (it has no
 * source suggestion) — authorship is never invented.
 * @param {object} rec - Recommendation
 * @param {object[]} suggestions - The run's suggestions
 * @returns {Array<'ai'|'user'|null>}
 */
export const suggestionSourcesOf = (rec, suggestions = []) => rec.selections.map((s) => {
  if (!s.suggestionId) return null;
  const suggestion = suggestions.find((x) => x.id === s.suggestionId);
  if (!suggestion) return null;
  // As in history (SPEC-UI2 §2): a suggestion without the field was AI-written;
  // an unsupported value is not exported as known authorship.
  if (suggestion.source === undefined) return 'ai';
  return suggestion.source === 'ai' || suggestion.source === 'user' ? suggestion.source : null;
});

/**
 * The MARC column text of a recommendation.
 * @param {object} rec - Recommendation
 * @returns {string}
 */
export const marcTextOf = (rec, delimiter = DEFAULT_DELIMITER) => (rec.marc.status === 'from-authority'
  // SPEC-UI2 §4: an authority field in the chosen delimiter; an unavailable reason is never transformed.
  ? (formatMarcField(rec.marc, delimiter) ?? rec.marc.text)
  : marcUnavailableText(rec.marc.reason));

const UNAVAILABLE = 'MARC not available';

/**
 * The "MARC not available" line of a reason. Most reasons are explained in
 * brackets ("MARC not available (no key)"); a reason that is already a whole
 * sentence starting with the same words (SPEC-P5 §7 "MARC not available
 * offline") is shown as it is, so the words never appear twice. The stored
 * reason value is not changed.
 * @param {string|null} reason - The MARC reason
 * @returns {string}
 */
export function marcUnavailableText(reason) {
  if (typeof reason === 'string' && reason.startsWith(UNAVAILABLE)) return reason;
  return `${UNAVAILABLE} (${reason})`;
}

/**
 * Copy all: a header line, then `label | LC ID | MARC text` per recommendation,
 * with the subdivision note as a comment line.
 * @param {object[]} recommendations - Recommendations
 * @param {object[]} selections - Selections (for the subdivision notes)
 * @param {{delimiter?:string}} [opts] - The subfield delimiter (SPEC-UI2 §4)
 * @returns {string}
 */
export const copyAllText = (recommendations, selections, { delimiter = DEFAULT_DELIMITER } = {}) => {
  const lines = [COPY_ALL_HEADER];
  for (const rec of recommendations) {
    lines.push(`${rec.label} | ${rec.localId} | ${marcTextOf(rec, delimiter)}`);
    const note = subdivisionNote(rec, selections);
    if (note) lines.push(`# ${note}`);
  }
  return lines.join('\n');
};

/**
 * The CSV rows (header first). `methods` and `confidence` are JSON arrays
 * aligned with the recommendation's `selections`, nulls kept.
 * @param {object[]} recommendations - Recommendations
 * @param {object[]} selections - Selections
 * @param {{suggestions?:object[], delimiter?:string}} [opts] - The run's suggestions (authorship) and the delimiter
 * @returns {Array<Array<string>>}
 */
export const csvRows = (recommendations, selections, { suggestions = [], delimiter = DEFAULT_DELIMITER } = {}) => [
  CSV_COLUMNS,
  ...recommendations.map((rec) => [
    rec.label,
    rec.localId,
    rec.uri,
    rec.authority,
    rec.marc.status === 'from-authority' ? (formatMarcField(rec.marc, delimiter) ?? rec.marc.text) : '',
    rec.marc.status,
    rec.marc.status === 'from-authority' ? '' : (rec.marc.reason || ''),
    JSON.stringify(rec.selections.map((s) => s.method)),
    JSON.stringify(rec.selections.map((s) => s.confidence ?? null)),
    subdivisionNote(rec, selections) || '',
    rec.source,
    JSON.stringify(suggestionSourcesOf(rec, suggestions))
  ])
];

/**
 * The CSV document of the recommendations.
 * @param {object[]} recommendations - Recommendations
 * @param {object[]} selections - Selections
 * @param {{suggestions?:object[], delimiter?:string}} [opts] - See csvRows()
 * @returns {string}
 */
export const recommendationsCsv = (recommendations, selections, opts = {}) => buildCsv(csvRows(recommendations, selections, opts));
