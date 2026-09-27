/**
 * Exports of step 4 (SPEC-P4 §7): Copy all and CSV. Recommendations only;
 * every heading, LC ID and link comes from a Candidate.
 */
import { buildCsv } from '../../utils/csv';
import { subdivisionNote } from './select';

export const COPY_ALL_HEADER = 'Headings from id.loc.gov; MARC fields generated from LC authority keys';
export const CSV_COLUMNS = ['label', 'lc_id', 'uri', 'authority', 'marc_field', 'marc_status', 'methods', 'confidence', 'subdivision_note', 'source'];

/**
 * The MARC column text of a recommendation.
 * @param {object} rec - Recommendation
 * @returns {string}
 */
export const marcTextOf = (rec) => (rec.marc.status === 'from-authority' ? rec.marc.text : `MARC not available (${rec.marc.reason})`);

/**
 * Copy all: a header line, then `label | LC ID | MARC text` per recommendation,
 * with the subdivision note as a comment line.
 * @param {object[]} recommendations - Recommendations
 * @param {object[]} selections - Selections (for the subdivision notes)
 * @returns {string}
 */
export const copyAllText = (recommendations, selections) => {
  const lines = [COPY_ALL_HEADER];
  for (const rec of recommendations) {
    lines.push(`${rec.label} | ${rec.localId} | ${marcTextOf(rec)}`);
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
 * @returns {Array<Array<string>>}
 */
export const csvRows = (recommendations, selections) => [
  CSV_COLUMNS,
  ...recommendations.map((rec) => [
    rec.label,
    rec.localId,
    rec.uri,
    rec.authority,
    rec.marc.status === 'from-authority' ? rec.marc.text : '',
    rec.marc.status,
    JSON.stringify(rec.selections.map((s) => s.method)),
    JSON.stringify(rec.selections.map((s) => s.confidence ?? null)),
    subdivisionNote(rec, selections) || '',
    rec.source
  ])
];

/**
 * The CSV document of the recommendations.
 * @param {object[]} recommendations - Recommendations
 * @param {object[]} selections - Selections
 * @returns {string}
 */
export const recommendationsCsv = (recommendations, selections) => buildCsv(csvRows(recommendations, selections));
