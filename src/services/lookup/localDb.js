/**
 * The local-database query layer and the ONE row → Candidate mapper
 * (SPEC-P5 §5, §6.2). Authority retrieval uses exactly SCHEMA_QUERIES Q1–Q5;
 * this module never builds SQL from text (see localdb/sql.js).
 *
 * Pure apart from the injected `query` function, which is the worker RPC in
 * the app and a fake or an in-memory database in the tests.
 */
import { normalizeLabel } from './normalize';
import { buildMatch } from '../localdb/sql';

export const BACKEND_ID = 'local-db';

/** The id.loc.gov path segment of each authority (§5). */
export const SEGMENT = { lcsh: 'subjects', lcgft: 'genreForms', lcnaf: 'names' };

/** `via` values: how the record was reached (display only). */
export const VIA = ['label', 'variant', 'replacement'];

/** Reasons an unresolved replacement note carries (§5). */
export const NOTE_REASONS = ['not-in-database', 'deprecated-target'];

/**
 * The full LC URI of a row.
 * @param {string} authority - lcsh | lcgft | lcnaf
 * @param {string} localId - The row's `uri` column (a local id, e.g. sh85021262)
 * @returns {string}
 */
export const uriOf = (authority, localId) => `http://id.loc.gov/authorities/${SEGMENT[authority]}/${localId}`;

/**
 * Whether an `auth` row may become a candidate: it must be a usable row of a
 * known authority, not deprecated, and not a subdivision record (a `marc_key`
 * with an 18X tag).
 * @param {object} row - An `auth` row
 * @returns {boolean}
 */
export const isMappable = (row) => Boolean(row) && typeof row.uri === 'string' && row.uri !== ''
  && Object.hasOwn(SEGMENT, row.authority) && typeof row.label === 'string' && row.label !== ''
  && row.deprecated !== 1 && !(typeof row.marc_key === 'string' && row.marc_key.startsWith('18'));

/**
 * The ONE mapper (§5). A deprecated row, an 18X row or a malformed row is
 * REJECTED (the caller counts it in `rejectedHits`); only a mapped row is an
 * accepted candidate anywhere in §6.
 * @param {object} row - An `auth` row from Q1–Q4
 * @param {{via:'label'|'variant'|'replacement', replacementFrom?:object[]}} ctx - How the row was reached
 * @returns {object|null} - A Candidate without `matchClass` (ranking adds it), or null
 */
export const mapRow = (row, { via, replacementFrom } = {}) => {
  if (!isMappable(row) || !VIA.includes(via)) return null;
  const candidate = {
    cid: `${row.authority}:${row.uri}`,
    authority: row.authority,
    localId: row.uri,
    uri: uriOf(row.authority, row.uri),
    label: row.label,
    marcKey: typeof row.marc_key === 'string' && row.marc_key !== '' ? row.marc_key : null,
    rdfTypes: [],
    matchClass: 'keyword',
    source: BACKEND_ID,
    via
  };
  if (via === 'replacement') {
    candidate.replacementFrom = (replacementFrom || []).map((f) => ({ ...f }));
  }
  return candidate;
};

/**
 * An unresolved replacement note (not a candidate, §5).
 * @param {object} from - The deprecated row
 * @param {{target_authority:string, target_uri:string}} hop - The Q4 row
 * @param {'not-in-database'|'deprecated-target'} reason - Why nothing was mapped
 * @returns {object}
 */
export const replacementNote = (from, hop, reason) => ({
  fromAuthority: from.authority,
  fromLocalId: from.uri,
  fromLabel: from.label,
  targetAuthority: hop.target_authority,
  targetLocalId: hop.target_uri,
  reason
});

/**
 * Split the rows of a Q4 answer into candidates and notes (§6.2). One hop
 * only; the replacement's match class is computed later on ITS OWN label.
 * @param {object} deprecatedRow - The deprecated `auth` row that was hit
 * @param {object[]} rows - Q4 rows (`target_*` plus the joined target columns)
 * @returns {{candidates:object[], notes:object[], rejected:number}}
 */
export const replacementsOf = (deprecatedRow, rows) => {
  const from = [{ authority: deprecatedRow.authority, localId: deprecatedRow.uri, label: deprecatedRow.label }];
  const candidates = [];
  const notes = [];
  let rejected = 0;
  for (const row of rows || []) {
    const target = {
      uri: row.uri, authority: row.authority, label: row.label,
      deprecated: row.deprecated, marc_key: row.marc_key
    };
    if (target.uri === null || target.uri === undefined) {
      notes.push(replacementNote(deprecatedRow, row, 'not-in-database'));
      continue;
    }
    if (target.deprecated === 1) {
      notes.push(replacementNote(deprecatedRow, row, 'deprecated-target'));
      continue;
    }
    const candidate = mapRow(target, { via: 'replacement', replacementFrom: from });
    if (candidate) candidates.push(candidate);
    else rejected += 1;
  }
  return { candidates, notes, rejected };
};

/**
 * The local query part of one (text, authorities) search. `query(name, args)`
 * runs a NAMED query (never raw SQL) and resolves with its rows.
 * @param {(name:string, args:object)=>Promise<object[]>} query - The named-query runner
 * @returns {{exact:Function, variant:Function, fts:Function, replacements:Function}}
 */
export const createLocalQueries = (query) => ({
  /** Q1 — exact preferred label. */
  exact: (text, authorities) => query('Q1', { text: normalizeLabel(text), authorities }),
  /** Q2 — exact variant label. */
  variant: (text, authorities) => query('Q2', { text: normalizeLabel(text), authorities }),
  /**
   * Q3a then Q3b, with the Q3b rows whose id is not already listed (§6.1).
   * The two sub-queries are accumulated SEPARATELY (§6.4): a failing Q3b never
   * discards the Q3a rows. No MATCH token → neither query runs.
   * @param {string} text - The heading to search
   * @param {string[]} authorities - Routed authorities
   * @returns {Promise<{rows:object[], ran:boolean, errors:Error[]}>}
   */
  async fts(text, authorities) {
    const match = buildMatch(text);
    if (match === null) return { rows: [], ran: false, errors: [] };
    const errors = [];
    const run = async (name) => {
      try {
        return await query(name, { text: match, authorities });
      } catch (err) {
        errors.push(err);
        return [];
      }
    };
    const preferred = await run('Q3a');
    const seen = new Set(preferred.map((r) => r.id));
    const variants = (await run('Q3b')).filter((r) => !seen.has(r.id));
    // P6 review (correctness) finding 1: a row found ONLY by Q3b matched a
    // variant label; a row found by both keeps its preferred-label match.
    return {
      rows: [...preferred, ...variants],
      variantOnlyIds: new Set(variants.map((r) => r.id)),
      ran: errors.length === 0,
      errors
    };
  },
  /**
   * Q4 — the one-hop replacements of a deprecated row. `authority` is not part
   * of the query; it only labels the request in the debug list.
   * @param {number} authId - `auth.id` of the deprecated row
   * @param {string} authority - Its authority
   * @returns {Promise<object[]>}
   */
  replacements: (authId, authority) => query('Q4', { authId, authority })
});

export default createLocalQueries;
