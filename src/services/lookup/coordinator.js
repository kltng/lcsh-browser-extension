/**
 * The ONE stage coordinator (SPEC-P5 §6.1). It runs P4's staged search
 * (SPEC-P4 §4.2) and sends each (authority, query) to the backend that holds
 * that authority:
 *   - `loc-api`            → every authority at LOC (P4 behavior, unchanged);
 *   - `local-db` + `full`  → every authority local;
 *   - `local-db` + `core`  → lcsh/lcgft local, lcnaf at LOC (mixed routing).
 * The ORIGINAL P4 routing order, the pooled stage decisions, the ranking and
 * the outcome rules are kept; only the place a part is answered changes.
 *
 * All branches share the lookup step's ONE signal and its Retry `bypassCache`.
 * There is no second budget.
 */
import { toSearch, keywordText } from './searchText';
import { normalizeLabel } from './normalize';
import { ROUTING, matchClassOf, rankCandidates, createLocRequester } from './locShared';
import { getPageScheduler, createRunCache } from './scheduler';
import { createLocalQueries, mapRow, replacementsOf, BACKEND_ID as LOCAL_DB } from './localDb';

export { LOCAL_DB };
export const MIXED = 'mixed';
/** The kind of a failed local part (§6.4); `types.js` and `pipelineText.js` know it. */
export const LOCAL_DB_ERROR = 'local_db';

const EMPTY_INSTALLATION = { profile: null, release: null, releaseCommit: null, file: null };

/**
 * Whether an authority is answered locally: `full` holds every authority,
 * `core` holds everything but names.
 * @param {string|null} profile - The installed profile, or null
 * @param {string} authority - lcsh | lcgft | lcnaf
 * @returns {boolean}
 */
export const isLocalAuthority = (profile, authority) => profile === 'full' || (profile === 'core' && authority !== 'lcnaf');

/**
 * The effective backend of a lookup whose route is `route` (§6.4).
 * @param {string|null} profile - The installed profile, or null when local is not used
 * @param {string[]} route - The routed authorities
 * @returns {'loc-api'|'local-db'|'mixed'}
 */
export const effectiveBackend = (profile, route) => {
  if (!profile) return 'loc-api';
  const local = route.filter((a) => isLocalAuthority(profile, a)).length;
  if (local === route.length) return LOCAL_DB;
  if (local === 0) return 'loc-api';
  return MIXED;
};

/**
 * Create the stage coordinator.
 * @param {{scheduler?:object, cache?:object,
 *   local?:{installation:()=>object|null, query:Function}|null}} [deps] -
 *   The page scheduler, the run cache, and the local backend (null = online only)
 * @returns {{id:string, lookup:Function, cache:object}}
 */
export const createCoordinator = ({ scheduler = getPageScheduler(), cache = createRunCache(), local = null } = {}) => {
  const requester = createLocRequester({ scheduler, cache });

  const lookup = async (suggestion, { limit = 10, signal, bypassCache = false } = {}) => {
    const route = ROUTING[suggestion.kind] || ROUTING.unknown;
    // Review finding 8: the installation identity is read FRESH at every
    // lookup ATTEMPT — a Retry started after a repair or an update uses the
    // new file — and then stays immutable for all of this lookup's queries.
    // A `null` snapshot means the local database cannot serve this attempt, so
    // the attempt routes online (the §3 fallback, shown by its notice).
    const identity = local ? local.installation() : null;
    const profile = identity?.profile ?? null;
    const backend = effectiveBackend(profile, route);
    const base = {
      suggestionId: suggestion.id,
      candidates: [],
      failures: [],
      incomplete: false,
      rejectedHits: 0,
      requests: [],
      provenance: { backend, ...(identity && backend !== 'loc-api' ? identity : EMPTY_INSTALLATION) },
      replacementNotes: []
    };
    const search = toSearch(suggestion.heading);
    if (!search) return base;

    const pool = [];
    const hasClass = (classes) => pool.some((p) => classes.includes(matchClassOf(p.candidate.label, search)));
    const authIndexOf = (authority) => {
      const i = route.indexOf(authority);
      return i < 0 ? route.length : i;
    };

    const queries = createLocalQueries((name, args) => {
      base.requests.push(`local:${name}:${args.authorities ? args.authorities.join('+') : args.authority}`);
      return local.query(name, { ...args, identity, signal });
    });

    // One accepted row becomes one pooled entry; a rejected row is counted.
    // `part` carries the hit counter of this (stage, authority) part, so rows
    // of Q1, Q2 and Q4 keep their retrieval order in the ranking.
    const take = (rows, { via, part }) => {
      let accepted = 0;
      const deprecated = [];
      for (const row of rows) {
        // `via` is a fixed value, or a function of the row (local FTS).
        const candidate = mapRow(row, { via: typeof via === 'function' ? via(row) : via });
        if (candidate) {
          pool.push({ candidate, authIndex: authIndexOf(candidate.authority), stage: part.stage, hitIndex: part.hits++ });
          accepted += 1;
        } else {
          base.rejectedHits += 1;
          if (row?.deprecated === 1) deprecated.push(row);
        }
      }
      return { accepted, deprecated };
    };

    // §6.2: a deprecated hit of stage 1–2 contributes its one-hop replacements.
    const addReplacements = async (deprecated, part) => {
      for (const row of deprecated) {
        const rows = await queries.replacements(row.id, row.authority);
        const { candidates, notes, rejected } = replacementsOf(row, rows);
        base.rejectedHits += rejected;
        base.replacementNotes.push(...notes);
        for (const candidate of candidates) {
          pool.push({ candidate, authIndex: authIndexOf(candidate.authority), stage: part.stage, hitIndex: part.hits++ });
        }
      }
    };

    const failLocal = (err) => {
      base.failures.push(err?.kind === 'cancelled' ? 'cancelled' : LOCAL_DB_ERROR);
      return { ok: false, accepted: 0 };
    };

    // Stages 1–2 on one authority: Q1 then Q2, each accumulated on its own so
    // a later failure never discards what an earlier query already accepted.
    const localExactPart = async (part) => {
      const normalized = normalizeLabel(part.text);
      let accepted = 0;
      let ok = true;
      for (const [name, via] of [['exact', 'label'], ['variant', 'variant']]) {
        try {
          const taken = take(await queries[name](normalized, [part.authority]), { via, part });
          accepted += taken.accepted;
          await addReplacements(taken.deprecated, part);
        } catch (err) {
          failLocal(err);
          ok = false;
        }
      }
      return { ok, accepted };
    };

    const localFtsPart = async (part) => {
      let result;
      try {
        result = await queries.fts(part.text, [part.authority]);
      } catch (err) {
        return failLocal(err);
      }
      for (const err of result.errors) failLocal(err);
      const variantOnly = result.variantOnlyIds || new Set();
      const taken = take(result.rows, { via: (row) => (variantOnly.has(row.id) ? 'variant' : 'label'), part });
      return { ok: result.ran, accepted: taken.accepted };
    };

    const locPart = async (part) => {
      base.requests.push(requester.url(part.authority, part.q, part.searchtype));
      const value = await requester.search(part, { signal, bypass: bypassCache });
      if (!value.ok) {
        base.failures.push(value.kind);
        return { ok: false, accepted: 0 };
      }
      base.rejectedHits += value.rejectedHits;
      const authIndex = authIndexOf(part.authority);
      value.candidates.forEach((candidate) => pool.push({ candidate, authIndex, stage: part.stage, hitIndex: part.hits++ }));
      return { ok: true, accepted: value.candidates.length };
    };

    // One part of a stage, on the backend that holds its authority.
    const runPart = (part) => {
      if (!isLocalAuthority(profile, part.authority)) return locPart(part);
      return part.searchtype === 'keyword' ? localFtsPart(part) : localExactPart(part);
    };

    // ALL parts of a stage finish before the pooled stop condition is checked.
    const runStage = async (stage, parts) => {
      const outcomes = await Promise.all(parts.map((part) => runPart({ ...part, stage, hits: 0 })));
      if (signal?.aborted) base.incomplete = true;
      return outcomes;
    };

    const finish = () => ({ ...base, candidates: rankCandidates(pool, search, limit) });
    const anchored = (text) => route.map((authority) => ({ authority, text, q: text, searchtype: 'leftanchored' }));

    await runStage(1, anchored(search.full));
    if (base.incomplete || hasClass(['exact-full'])) return finish();
    if (search.main !== search.full) {
      await runStage(2, anchored(search.main));
      if (base.incomplete || hasClass(['exact-full'])) return finish();
    }
    if (hasClass(['exact-full', 'exact-main'])) return finish();
    const [s3] = await runStage(3, [{
      authority: route[0], text: search.full, q: keywordText(search.full), searchtype: 'keyword'
    }]);
    if (base.incomplete) return finish();
    if (s3.ok && s3.accepted === 0 && (suggestion.kind === 'name' || suggestion.kind === 'unknown')) {
      await runStage(4, [{ authority: 'lcnaf', text: search.main, q: keywordText(search.main), searchtype: 'keyword' }]);
    }
    return finish();
  };

  return { id: local ? LOCAL_DB : 'loc-api', lookup, cache };
};

export default createCoordinator;
