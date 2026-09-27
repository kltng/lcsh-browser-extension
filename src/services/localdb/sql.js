/**
 * The normative lookup queries of the builder contract (SCHEMA_QUERIES v2,
 * SPEC-P5 §5) and the Q3 MATCH builder. HOUSE_RULES 16: the query texts are
 * COPIED byte for byte from the lead-owned source and pinned by a test
 * (`__fixtures__/schema_queries.json`, sha256 per query). Never paraphrase a
 * query here, and never build SQL from user text: parameters are always bound.
 *
 * Pure module: no SQLite, no DOM. Node-testable.
 */
import { normalizeLabel } from '../lookup/normalize';

/** Authorities that may appear in a bound `:authorities` list, in no order. */
export const AUTHORITY_ALLOWLIST = ['lcsh', 'lcgft', 'lcnaf'];

/** The named queries. `?1` is the query parameter; `:authorities` and `<authority order>` are expanded by buildQuery(). */
export const QUERY_TEXT = {
  Q1: 'SELECT id, uri, authority, label, label_normalized, deprecated, marc_key, scope_note\nFROM auth\nWHERE label_normalized = ?1\n  AND authority IN (:authorities)\nORDER BY deprecated ASC, <authority order>, uri ASC\nLIMIT 20;',
  Q2: 'SELECT a.id, a.uri, a.authority, a.label, a.label_normalized, a.deprecated, a.marc_key, a.scope_note\nFROM auth a\nWHERE a.id IN (SELECT l.auth_id FROM alt_label l WHERE l.label_normalized = ?1)\n  AND a.authority IN (:authorities)\nORDER BY a.deprecated ASC, <authority order>, a.uri ASC\nLIMIT 20;',
  Q3a: '-- Q3a preferred\nSELECT a.id, a.uri, a.authority, a.label, a.label_normalized, a.deprecated, a.marc_key, a.scope_note,\n       bm25(auth_fts) AS score\nFROM auth_fts JOIN auth a ON a.id = auth_fts.rowid\nWHERE auth_fts MATCH ?1\n  AND a.authority IN (:authorities)\nORDER BY score ASC, a.deprecated ASC, a.uri ASC\nLIMIT 30;',
  Q3b: '-- Q3b variants (bm25 cannot be used inside an aggregate: score in a subquery first; this form tested on 468k LCSH records 2026-09-27: no table scans, <= 5.5 ms)\nSELECT a.id, a.uri, a.authority, a.label, a.label_normalized, a.deprecated, a.marc_key, a.scope_note,\n       min(s.score) AS score\nFROM (SELECT l2.id AS lid, bm25(alt_label_fts) AS score\n      FROM alt_label_fts\n      JOIN alt_label l2 ON l2.id = alt_label_fts.rowid\n      JOIN auth a2 ON a2.id = l2.auth_id\n      WHERE alt_label_fts MATCH ?1\n      ORDER BY score, a2.authority, a2.uri, l2.label, l2.lang, l2.kind\n      LIMIT 500) s\nJOIN alt_label l ON l.id = s.lid\nJOIN auth a ON a.id = l.auth_id\nWHERE a.authority IN (:authorities)\nGROUP BY a.id\nORDER BY score ASC, a.deprecated ASC, a.uri ASC\nLIMIT 30;',
  Q4: "SELECT h.target_authority, h.target_uri,\n       t.id, t.uri, t.authority, t.label, t.label_normalized, t.deprecated, t.marc_key, t.scope_note\nFROM hierarchy h\nLEFT JOIN auth t ON t.uri = h.target_uri AND t.authority = h.target_authority\nWHERE h.auth_id = ?1 AND h.rel = 'use'\nORDER BY h.target_authority, h.target_uri;",
  Q5: "SELECT h.rel, h.target_authority, h.target_uri, t.label\nFROM hierarchy h\nLEFT JOIN auth t ON t.uri = h.target_uri AND t.authority = h.target_authority\nWHERE h.auth_id = ?1 AND h.rel IN ('broader','narrower','related','see_also')\nORDER BY h.rel, t.label, h.target_uri\nLIMIT 200;"
};

/** The named queries that take an authority list. */
export const AUTHORITY_QUERIES = ['Q1', 'Q2', 'Q3a', 'Q3b'];
/** Of those, the ones that also order by the caller's routing order (Q3 orders by bm25). */
export const AUTHORITY_ORDER_QUERIES = ['Q1', 'Q2'];
/** The named queries that take an `auth.id`. */
export const RECORD_QUERIES = ['Q4', 'Q5'];
/** Every query name the `query` RPC accepts (SPEC-P5 §5 query contract). */
export const QUERY_NAMES = [...AUTHORITY_QUERIES, ...RECORD_QUERIES];

const MAX_MATCH_TOKENS = 12;
const TOKEN_RUN = /[\p{L}\p{N}]+/gu;

/**
 * The FTS5 MATCH string of a heading (SCHEMA_QUERIES Q3): normalize, drop
 * `--`, take the first 12 distinct letter/number runs, quote each one and join
 * them with single spaces (an implicit AND of phrase tokens). No prefix `*`,
 * no operator ever comes from the user.
 * @param {string} text - The suggested heading
 * @returns {string|null} - The MATCH string, or null when there is no token (Q3 must not run)
 */
export const buildMatch = (text) => {
  const t = normalizeLabel(text).replace(/--/g, ' ');
  const tokens = [];
  for (const [token] of t.matchAll(TOKEN_RUN)) {
    if (tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length === MAX_MATCH_TOKENS) break;
  }
  if (tokens.length === 0) return null;
  // Rule 2 leaves no `"` in a token; the doubling keeps the contract explicit.
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
};

const assertAuthorities = (authorities) => {
  if (!Array.isArray(authorities) || authorities.length === 0) throw new Error('No authority given');
  for (const a of authorities) {
    if (!AUTHORITY_ALLOWLIST.includes(a)) throw new Error('Unknown authority');
  }
  if (new Set(authorities).size !== authorities.length) throw new Error('Duplicate authority');
};

/**
 * Expand a named query for one call: `:authorities` becomes `?2,?3,…` and
 * `<authority order>` the CASE over the caller's routing order. Parameters are
 * bound, never interpolated.
 * @param {string} name - Q1 | Q2 | Q3a | Q3b | Q4 | Q5
 * @param {{authorities?:string[], text?:string, authId?:number}} args - Bound values
 * @returns {{sql:string, params:Array<string|number>}}
 */
export const buildQuery = (name, { authorities, text, authId } = {}) => {
  const raw = QUERY_TEXT[name];
  if (!raw) throw new Error('Unknown query');
  if (RECORD_QUERIES.includes(name)) {
    if (!Number.isInteger(authId)) throw new Error('auth id must be an integer');
    return { sql: raw, params: [authId] };
  }
  assertAuthorities(authorities);
  if (typeof text !== 'string') throw new Error('Query text must be a string');
  const marks = authorities.map((_, i) => `?${i + 2}`);
  const cases = authorities.map((_, i) => `WHEN ${marks[i]} THEN ${i}`).join(' ');
  const sql = raw
    .replace(':authorities', marks.join(','))
    .replace('<authority order>', `CASE authority ${cases} ELSE ${authorities.length} END`);
  return { sql, params: [text, ...authorities] };
};

export default QUERY_TEXT;
