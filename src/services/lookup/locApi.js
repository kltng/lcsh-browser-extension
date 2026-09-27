/**
 * The LOC API lookup backend: staged suggest2 search (SPEC-P4 §4.2), match
 * classes and ranking (§4.4), and the lookup outcome.
 */
import { toSearch, keywordText } from './searchText';
import { normalizeLabel } from './normalize';
import { parseSuggestBody } from './hit';
import { LookupError, getPageScheduler, createRunCache } from './scheduler';

export const BACKEND_ID = 'loc-api';

/** Authorities searched per kind, in order (§4.2). */
export const ROUTING = {
  topical: ['lcsh'],
  geographic: ['lcsh', 'lcnaf'],
  name: ['lcnaf', 'lcsh'],
  genre: ['lcgft', 'lcsh'],
  unknown: ['lcsh', 'lcnaf', 'lcgft']
};

export const ENDPOINTS = {
  lcsh: 'https://id.loc.gov/authorities/subjects/suggest2',
  lcnaf: 'https://id.loc.gov/authorities/names/suggest2',
  lcgft: 'https://id.loc.gov/authorities/genreForms/suggest2'
};

export const MATCH_CLASSES = ['exact-full', 'exact-main', 'prefix-full', 'prefix-main', 'keyword'];
const CLASS_RANK = Object.fromEntries(MATCH_CLASSES.map((c, i) => [c, i]));
export const SEARCH_COUNT = 10;

/**
 * The suggest2 URL of one search.
 * @param {'lcsh'|'lcnaf'|'lcgft'} authority - Authority
 * @param {string} q - Query
 * @param {'leftanchored'|'keyword'} searchtype - Search type
 * @returns {string}
 */
export const buildSearchUrl = (authority, q, searchtype) => {
  const params = new URLSearchParams({ q, count: String(SEARCH_COUNT), searchtype });
  return `${ENDPOINTS[authority]}?${params}`;
};

/**
 * The match class of a label for a search (§4.4; first matching rule wins).
 * @param {string} label - Candidate label
 * @param {{full:string, main:string}} search - Result of toSearch()
 * @returns {string}
 */
export const matchClassOf = (label, search) => {
  const l = normalizeLabel(label);
  const full = normalizeLabel(search.full);
  const main = normalizeLabel(search.main);
  if (l === full) return 'exact-full';
  if (search.main !== search.full && l === main) return 'exact-main';
  if (l.startsWith(full)) return 'prefix-full';
  if (l.startsWith(main)) return 'prefix-main';
  return 'keyword';
};

/**
 * Pool, dedupe (best class kept), sort and cut the candidates of all stages.
 * @param {Array<{candidate:object, authIndex:number, stage:number, hitIndex:number}>} pool - Accepted hits
 * @param {{full:string, main:string}} search - Search strings
 * @param {number} limit - Maximum number of candidates
 * @returns {object[]} - Candidates with `matchClass`
 */
export const rankCandidates = (pool, search, limit) => {
  const best = new Map();
  for (const item of pool) {
    const matchClass = matchClassOf(item.candidate.label, search);
    const entry = { ...item, matchClass, rank: CLASS_RANK[matchClass] };
    const seen = best.get(item.candidate.cid);
    if (!seen || entry.rank < seen.rank) best.set(item.candidate.cid, entry);
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || a.authIndex - b.authIndex || a.stage - b.stage || a.hitIndex - b.hitIndex)
    .slice(0, limit)
    .map((e) => ({ ...e.candidate, rdfTypes: [...e.candidate.rdfTypes], matchClass: e.matchClass }));
};

/**
 * The lookup outcome (§4.4).
 * @param {{candidates:object[], failures:string[], incomplete?:boolean, incompleteKind?:string}} parts - Result parts
 * @returns {{outcome:string, errorKind:string|null}}
 */
export const outcomeOf = ({ candidates, failures, incomplete = false, incompleteKind = 'timeout' }) => {
  if (incomplete) {
    return { outcome: candidates.length > 0 ? 'partial' : 'failed', errorKind: incompleteKind };
  }
  if (failures.length === 0) {
    return candidates.length > 0 ? { outcome: 'found', errorKind: null } : { outcome: 'no-results', errorKind: null };
  }
  return { outcome: candidates.length > 0 ? 'partial' : 'failed', errorKind: failures[0] };
};

/**
 * Create the LOC API backend. `cache` is the per-run cache (a new run makes a new backend).
 * @param {{scheduler?:object, cache?:object}} [deps] - Scheduler (default: the page queue) and run cache
 * @returns {{id:string, lookup:Function, cache:object}}
 */
export const createLocApiBackend = ({ scheduler = getPageScheduler(), cache = createRunCache() } = {}) => {
  const fetchAccepted = (url, authority, { signal, bypass }) => cache.get(url, async (sharedSignal) => {
    const { text } = await scheduler.request(url, { signal: sharedSignal });
    const parsed = parseSuggestBody(text, authority);
    if (!parsed.ok) throw new LookupError('invalid_output');
    return { candidates: parsed.candidates, rejectedHits: parsed.rejectedHits };
  }, { signal, bypass });

  /**
   * Look up one suggestion. On an abort of `signal` the stages stop and the
   * result is marked incomplete (the caller decides timeout vs cancel).
   * @param {{id:string, heading:string, kind:string}} suggestion - The suggestion
   * @param {{limit?:number, signal?:AbortSignal, bypassCache?:boolean}} [opts] - Candidate limit, signal, Retry bypass
   * @returns {Promise<{suggestionId:string, candidates:object[], failures:string[], incomplete:boolean,
   *   rejectedHits:number, requests:string[]}>}
   */
  const lookup = async (suggestion, { limit = 10, signal, bypassCache = false } = {}) => {
    const base = { suggestionId: suggestion.id, candidates: [], failures: [], incomplete: false, rejectedHits: 0, requests: [] };
    const search = toSearch(suggestion.heading);
    if (!search) return base;
    const route = ROUTING[suggestion.kind] || ROUTING.unknown;
    const pool = [];
    const hasClass = (classes) => pool.some((p) => classes.includes(matchClassOf(p.candidate.label, search)));

    const runStage = async (stage, searches) => {
      const outcomes = await Promise.all(searches.map(async ({ authority, q, searchtype }) => {
        const url = buildSearchUrl(authority, q, searchtype);
        base.requests.push(url);
        try {
          const value = await fetchAccepted(url, authority, { signal, bypass: bypassCache });
          base.rejectedHits += value.rejectedHits;
          const authIndex = route.indexOf(authority);
          value.candidates.forEach((candidate, hitIndex) => pool.push({
            candidate, authIndex: authIndex < 0 ? route.length : authIndex, stage, hitIndex
          }));
          return { ok: true, accepted: value.candidates.length };
        } catch (err) {
          base.failures.push(err instanceof LookupError ? err.kind : 'network');
          return { ok: false, accepted: 0 };
        }
      }));
      if (signal?.aborted) base.incomplete = true;
      return outcomes;
    };

    const finish = () => ({ ...base, candidates: rankCandidates(pool, search, limit) });

    await runStage(1, route.map((authority) => ({ authority, q: search.full, searchtype: 'leftanchored' })));
    if (base.incomplete || hasClass(['exact-full'])) return finish();
    if (search.main !== search.full) {
      await runStage(2, route.map((authority) => ({ authority, q: search.main, searchtype: 'leftanchored' })));
      if (base.incomplete || hasClass(['exact-full'])) return finish();
    }
    if (hasClass(['exact-full', 'exact-main'])) return finish();
    const [s3] = await runStage(3, [{ authority: route[0], q: keywordText(search.full), searchtype: 'keyword' }]);
    if (base.incomplete) return finish();
    if (s3.ok && s3.accepted === 0 && (suggestion.kind === 'name' || suggestion.kind === 'unknown')) {
      await runStage(4, [{ authority: 'lcnaf', q: keywordText(search.main), searchtype: 'keyword' }]);
    }
    return finish();
  };

  return { id: BACKEND_ID, lookup, cache };
};

export default createLocApiBackend;
