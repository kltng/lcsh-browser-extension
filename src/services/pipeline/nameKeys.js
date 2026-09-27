/**
 * Name MARC keys (SPEC-P5 §7). With the local database, LCNAF rows carry no
 * MARC key; for the names the cataloger actually CHOSE, the key is fetched
 * from LOC and attached to a COPY of the candidate. Identity and label are
 * never changed, and `buildMarc()` still checks the key against the label —
 * every time, including when a key is reused (a changed label never inherits
 * an unchecked earlier result).
 *
 * The requests go through the P4 page scheduler and the run's
 * validated-response cache, so the online behavior is the P4 one.
 */
import { buildMarc } from './marc';
import { NAME_KEY_REASONS } from './types';

/** One deadline for the whole operation, queue waits and retries included. */
export const NAME_KEY_DEADLINE_MS = 120000;
export const MARC_KEY_SOURCE = 'loc-api';

/**
 * Whether this candidate (or recommendation) still needs a name key.
 * @param {{source?:string, authority?:string, marcKey?:string|null}} c - Candidate or recommendation
 * @returns {boolean}
 */
export const needsNameKey = (c) => Boolean(c) && c.source === 'local-db' && c.authority === 'lcnaf'
  && (c.marcKey === null || c.marcKey === undefined);

/**
 * The DISTINCT cids of the effective choices that need a key, in order.
 * @param {object[]} recommendations - Built recommendations (one per cid)
 * @returns {Array<{cid:string, label:string, uri:string}>}
 */
export const nameKeyTargets = (recommendations = []) => {
  const seen = new Set();
  const targets = [];
  for (const rec of recommendations) {
    if (!needsNameKey(rec) || seen.has(rec.cid)) continue;
    seen.add(rec.cid);
    targets.push({ cid: rec.cid, label: rec.label, uri: rec.uri });
  }
  return targets;
};

/**
 * Read one validated answer for one target (§7 "Result per cid").
 * @param {{ok:boolean, kind?:string, candidates:object[]}} answer - The requester's answer
 * @param {{uri:string}} target - The candidate the key must belong to
 * @returns {{marcKey:string}|{reason:string, errorKind?:string}}
 */
export const readNameAnswer = (answer, target) => {
  if (!answer.ok) return { reason: NAME_KEY_REASONS.failed, errorKind: answer.kind };
  const matching = answer.candidates.filter((c) => c.uri === target.uri);
  if (matching.length === 0) return { reason: NAME_KEY_REASONS['no-match'] };
  const keys = [...new Set(matching.map((c) => c.marcKey).filter((k) => typeof k === 'string' && k !== ''))];
  // Several matching hits with different keys: nothing is chosen.
  if (keys.length > 1) return { reason: NAME_KEY_REASONS.failed };
  if (keys.length === 0) return { reason: 'no key' };
  return { marcKey: keys[0] };
};

/**
 * Resolve the keys of the given targets. It never throws for one target: each
 * cid gets either a key or a reason.
 * @param {{targets:object[], requester:object, signal?:AbortSignal, deadlineMs?:number,
 *   bypassCids?:Set<string>, isOnline?:()=>boolean, setTimeoutImpl?:Function}} args - Inputs
 * @returns {Promise<Map<string, {marcKey?:string, reason?:string, errorKind?:string}>>}
 */
export const resolveNameKeys = async ({
  targets, requester, signal, deadlineMs = NAME_KEY_DEADLINE_MS, bypassCids = new Set(),
  isOnline = () => globalThis.navigator?.onLine !== false, setTimeoutImpl = setTimeout
}) => {
  const resolved = new Map();
  if (targets.length === 0) return resolved;
  if (!isOnline()) {
    // Offline: no request at all.
    for (const target of targets) resolved.set(target.cid, { reason: NAME_KEY_REASONS.offline });
    return resolved;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeoutImpl(() => controller.abort(), deadlineMs);
  try {
    await Promise.all(targets.map(async (target) => {
      const answer = await requester.search(
        { authority: 'lcnaf', q: target.label, searchtype: 'leftanchored' },
        { signal: controller.signal, bypass: bypassCids.has(target.cid) }
      );
      resolved.set(target.cid, readNameAnswer(answer, target));
    }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return resolved;
};

/**
 * Apply the resolved keys to the recommendations. `keys` holds the keys
 * resolved SO FAR in this run (reused across regenerations); `reasons` holds
 * the last reason per cid. Every application re-runs `buildMarc()` against the
 * CURRENT candidate copy.
 * @param {object[]} recommendations - Built recommendations
 * @param {{keys?:Map<string,string>, reasons?:Map<string,string>}} [state] - Per-run name-key state
 * @returns {object[]} - New recommendations
 */
export const applyNameKeys = (recommendations = [], { keys = new Map(), reasons = new Map() } = {}) =>
  recommendations.map((rec) => {
    if (!needsNameKey(rec)) return rec;
    const key = keys.get(rec.cid);
    if (typeof key === 'string') {
      // A COPY of the candidate: the label and the identity are unchanged.
      // Review finding 7: the resolved key STAYS on the copy that goes
      // downstream, so this recommendation is no longer "unresolved" and a
      // Retry does not fetch it again.
      const withKey = { ...rec, marcKey: key, marcKeySource: MARC_KEY_SOURCE };
      return { ...withKey, marc: buildMarc(withKey) };
    }
    const reason = reasons.get(rec.cid);
    if (!reason) return rec;
    return { ...rec, marc: { ...rec.marc, status: 'unavailable', reason } };
  });

/**
 * Merge one resolution round into the per-run state (§7: resolved keys are
 * kept per run by cid and reused; a failure keeps only its reason).
 * @param {{keys:Map<string,string>, reasons:Map<string,string>}} state - Per-run state (mutated)
 * @param {Map<string, object>} resolved - Result of resolveNameKeys
 * @returns {{keys:Map<string,string>, reasons:Map<string,string>}}
 */
export const mergeNameKeys = (state, resolved) => {
  for (const [cid, value] of resolved) {
    if (typeof value.marcKey === 'string') {
      state.keys.set(cid, value.marcKey);
      state.reasons.delete(cid);
    } else {
      state.reasons.set(cid, value.reason);
    }
  }
  return state;
};

/**
 * A fresh per-run name-key state.
 * @returns {{keys:Map<string,string>, reasons:Map<string,string>}}
 */
export const emptyNameKeyState = () => ({ keys: new Map(), reasons: new Map() });

export default resolveNameKeys;
