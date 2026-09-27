/**
 * Step 2 — lookup orchestration over a backend (SPEC-P4 §4), with the 120 s
 * work budget of §4.5. On budget expiry, active work is aborted, queued work
 * is dropped, and every suggestion is finalized: an unfinished one becomes
 * `partial`/`failed` with `errorKind:'timeout'` (never `cancelled`).
 */
import { outcomeOf } from '../lookup/locApi';
import { LookupError } from '../lookup/scheduler';
import { makeLookupResult } from './types';

export const LOOKUP_BUDGET_MS = 120000;

/**
 * Look up suggestions. A cancel by the caller's signal rejects with a
 * `cancelled` LookupError (nothing is committed).
 * @param {{backend:object, suggestions:object[], limit?:number, signal?:AbortSignal,
 *   budgetMs?:number, bypassCache?:boolean, onResult?:(result:object)=>void}} args - Backend, suggestions, options
 * @returns {Promise<{results:object[], debug:{rejectedHits:number, requests:string[], budgetExpired:boolean}}>}
 */
export async function runLookupStep({
  backend, suggestions, limit = 10, signal, budgetMs = LOOKUP_BUDGET_MS, bypassCache = false, onResult
}) {
  if (signal?.aborted) throw new LookupError('cancelled');
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budgetMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const debug = { rejectedHits: 0, requests: [], budgetExpired: false };
  try {
    const results = await Promise.all(suggestions.map(async (suggestion) => {
      const raw = await backend.lookup(suggestion, { limit, signal: controller.signal, bypassCache });
      debug.rejectedHits += raw.rejectedHits;
      debug.requests.push(...raw.requests);
      const { outcome, errorKind } = outcomeOf({ ...raw, incompleteKind: 'timeout' });
      // SPEC-P5 §6.4: `provenance` and `replacementNotes` travel with the result.
      const result = makeLookupResult({
        suggestionId: suggestion.id, outcome, errorKind, candidates: raw.candidates,
        searchedAt: new Date().toISOString(),
        provenance: raw.provenance, replacementNotes: raw.replacementNotes
      });
      if (!signal?.aborted) onResult?.(result);
      return result;
    }));
    if (signal?.aborted && !expired) throw new LookupError('cancelled');
    debug.budgetExpired = expired;
    return { results, debug };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

export default runLookupStep;
