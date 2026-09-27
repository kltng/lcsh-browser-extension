/**
 * The `loc-api` entry point. Since P5 there is exactly ONE staged-search
 * implementation — `coordinator.js` — and this module is the online-only way
 * into it (SPEC-P5 §6.1). The P4 request-sequence tests therefore exercise the
 * production path (review finding 11).
 *
 * Everything the coordinator and this entry point share lives in
 * `locShared.js`, so there is no circular import.
 */
import { createCoordinator } from './coordinator';

export {
  BACKEND_ID, ROUTING, ENDPOINTS, MATCH_CLASSES, SEARCH_COUNT,
  buildSearchUrl, matchClassOf, rankCandidates, outcomeOf, createLocRequester
} from './locShared';

/**
 * Create the LOC API backend: the coordinator with no local installation, so
 * every authority is answered at id.loc.gov.
 * @param {{scheduler?:object, cache?:object}} [deps] - Scheduler (default: the page queue) and run cache
 * @returns {{id:string, lookup:Function, cache:object}}
 */
export const createLocApiBackend = (deps = {}) => createCoordinator({ ...deps, local: null });

export default createLocApiBackend;
