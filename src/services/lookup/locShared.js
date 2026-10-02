/**
 * The pieces the ONE stage coordinator and the `loc-api` entry point share
 * (SPEC-P4 §4.2–§4.4, SPEC-P5 §6.1): routing, the suggest2 URL, match classes,
 * ranking, the outcome, and the authority-scoped request helper.
 *
 * This module exists so `locApi.js` can delegate to `coordinator.js` without a
 * circular import (review finding 11): both import from here, and nothing here
 * imports either of them.
 */
import { normalizeLabel } from './normalize';
import { parseSuggestBody } from './hit';
import { LookupError, getPageScheduler, createRunCache } from './scheduler';
import { guardExit, documentKeys, KeyEchoError } from '../keyGuard';

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
 * @returns {string} - Throws KeyEchoError when the query repeats an API key
 */
export const buildSearchUrl = (authority, q, searchtype) => {
  // Exit (a), P6 fix 13: the FINAL query, after every normalization, is
  // checked against every key of this document (the runs' keys and every
  // stored key). This is the only function that builds an id.loc.gov URL.
  guardExit('lookup', q, documentKeys());
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
 * SPEC-P5 §6.4: the dedupe keeps P4's choice of the surviving candidate and
 * MERGES the unique `replacementFrom` entries of all duplicates into it, so
 * the record's history is not lost when it was reached twice.
 * @param {Array<{candidate:object, authIndex:number, stage:number, hitIndex:number}>} pool - Accepted hits
 * @param {{full:string, main:string}} search - Search strings
 * @param {number} limit - Maximum number of candidates
 * @returns {object[]} - Candidates with `matchClass`
 */
export const rankCandidates = (pool, search, limit) => {
  const best = new Map();
  const replacedBy = new Map();
  for (const item of pool) {
    const matchClass = matchClassOf(item.candidate.label, search);
    const entry = { ...item, matchClass, rank: CLASS_RANK[matchClass] };
    const seen = best.get(item.candidate.cid);
    if (!seen || entry.rank < seen.rank) best.set(item.candidate.cid, entry);
    for (const from of item.candidate.replacementFrom || []) {
      const merged = replacedBy.get(item.candidate.cid) || [];
      if (!merged.some((x) => x.authority === from.authority && x.localId === from.localId)) merged.push({ ...from });
      replacedBy.set(item.candidate.cid, merged);
    }
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || a.authIndex - b.authIndex || a.stage - b.stage || a.hitIndex - b.hitIndex)
    .slice(0, limit)
    .map((e) => {
      const candidate = { ...e.candidate, rdfTypes: [...e.candidate.rdfTypes], matchClass: e.matchClass };
      const from = replacedBy.get(e.candidate.cid);
      if (from) candidate.replacementFrom = from;
      return candidate;
    });
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
 * The authority-scoped request helper (SPEC-P5 §6.1): one suggest2 search on
 * one authority, through the PAGE scheduler and the run's validated-response
 * cache. The online behavior has exactly one implementation.
 * @param {{scheduler?:object, cache?:object}} [deps] - Scheduler (default: the page queue) and run cache
 * @returns {{cache:object, url:Function, search:Function}}
 */
export const createLocRequester = ({ scheduler = getPageScheduler(), cache = createRunCache() } = {}) => {
  const fetchAccepted = (url, authority, { signal, bypass }) => cache.get(url, async (sharedSignal) => {
    const { text } = await scheduler.request(url, { signal: sharedSignal });
    const parsed = parseSuggestBody(text, authority);
    if (!parsed.ok) throw new LookupError('invalid_output');
    return { candidates: parsed.candidates, rejectedHits: parsed.rejectedHits };
  }, { signal, bypass });

  return {
    cache,
    url: buildSearchUrl,
    /**
     * One search. It never throws: a failure is reported as `{ok:false, kind}`.
     * @param {{authority:string, q:string, searchtype:string}} search - The search
     * @param {{signal?:AbortSignal, bypass?:boolean}} [opts] - Signal and Retry bypass
     * @returns {Promise<{ok:boolean, url:string, candidates:object[], rejectedHits:number, kind?:string}>}
     */
    async search({ authority, q, searchtype }, { signal, bypass = false } = {}) {
      let url;
      try {
        url = buildSearchUrl(authority, q, searchtype);
      } catch (err) {
        if (err instanceof KeyEchoError) return { ok: false, url: null, candidates: [], rejectedHits: 0, kind: 'key_echo' };
        throw err;
      }
      try {
        const value = await fetchAccepted(url, authority, { signal, bypass });
        return { ok: true, url, candidates: value.candidates, rejectedHits: value.rejectedHits };
      } catch (err) {
        return { ok: false, url, candidates: [], rejectedHits: 0, kind: err instanceof LookupError ? err.kind : 'network' };
      }
    }
  };
};
