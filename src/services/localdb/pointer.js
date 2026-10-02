/**
 * The release pointer `latest.json` of the builder's Hugging Face dataset
 * (SPEC-P5 §4.2): fetch with fixed options and a 20 s timeout, then FULL
 * validation before anything is downloaded. Every download URL is rebuilt
 * from the pointer's own `release_commit`/`release`/profile and compared with
 * the pointer's `url_pinned` after parsing, so no spelling of the path can
 * point somewhere else.
 *
 * Pure apart from the injected `fetchImpl`: Node-testable, no real network.
 */

export const DATASET = 'kltng/lcsh-db-lite';
export const POINTER_URL = `https://huggingface.co/datasets/${DATASET}/resolve/main/latest.json`;
export const POINTER_HOST = 'huggingface.co';
export const POINTER_TIMEOUT_MS = 20000;
export const PROFILES = ['core', 'full'];

/**
 * The compatibility fingerprints this extension build can read. A pointer with
 * anything else is a NEWER database format: the message asks the user to
 * update the extension, and the installed database stays usable (§4.2).
 */
export const SUPPORTED_FINGERPRINTS = [
  '2|NORMALIZE_V1|LH1|1ac37a0494bdaa0f2b614c6a1debfd5677793e0cc36a94db6762dda5d730e284'
];

export const UNSUPPORTED_MESSAGE = 'A newer database format is available; update the extension to use it.';

const MESSAGES = {
  network: 'Could not reach huggingface.co. Check your connection.',
  timeout: 'huggingface.co did not answer in time.',
  server: 'huggingface.co returned an error. Try again later.',
  invalid_output: 'The release information from huggingface.co could not be read.',
  unsupported: UNSUPPORTED_MESSAGE
};

/** A pointer failure. The message is local text; no response data is kept (HOUSE_RULES 6). */
export class PointerError extends Error {
  /** @param {'network'|'timeout'|'server'|'invalid_output'|'unsupported'} kind - Failure kind */
  constructor(kind) {
    super(MESSAGES[kind] || MESSAGES.invalid_output);
    this.name = 'PointerError';
    this.kind = MESSAGES[kind] ? kind : 'invalid_output';
  }
}

const RELEASE_RE = /^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d*)$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const isPositiveSafeInt = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * The four numbers of a release id, or null when it is not a real dated release.
 * @param {any} release - Release id, e.g. `2026.09.27.1`
 * @returns {number[]|null} - [year, month, day, sequence]
 */
export const parseRelease = (release) => {
  if (typeof release !== 'string') return null;
  const m = RELEASE_RE.exec(release);
  if (!m) return null;
  const [year, month, day, seq] = m.slice(1).map(Number);
  if (!Number.isSafeInteger(seq)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? [year, month, day, seq] : null;
};

/**
 * Compare two release ids as four numbers.
 * @param {string} a - First release
 * @param {string} b - Second release
 * @returns {number} - < 0, 0 or > 0
 */
export const compareReleases = (a, b) => {
  const pa = parseRelease(a);
  const pb = parseRelease(b);
  if (!pa || !pb) throw new PointerError('invalid_output');
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

/**
 * The only download path this extension accepts for a profile.
 * @param {string} releaseCommit - 40 hex commit of the release
 * @param {string} release - Release id
 * @param {string} profile - core | full
 * @returns {string}
 */
export const expectedPath = (releaseCommit, release, profile) =>
  `/datasets/${DATASET}/resolve/${releaseCommit}/releases/${release}/lcsh-${profile}.db.gz`;

/**
 * The CHANGES.md link of a release (shown in the update banner, §4.6).
 * @param {{release:string, releaseCommit:string}} info - Release and its commit
 * @returns {string}
 */
export const changesUrl = ({ release, releaseCommit }) =>
  `https://${POINTER_HOST}/datasets/${DATASET}/blob/${releaseCommit}/releases/${release}/CHANGES.md`;

const checkUrl = (value, releaseCommit, release, profile) => {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return false;
  }
  // `new URL` resolves dot segments and keeps percent-encoded separators
  // encoded, so string equality after parsing rejects every re-spelling that
  // does not mean exactly this path.
  return url.protocol === 'https:' && url.host === POINTER_HOST
    && url.username === '' && url.password === ''
    && url.search === '' && url.hash === ''
    && url.pathname === expectedPath(releaseCommit, release, profile);
};

/**
 * Validate a parsed `latest.json` (§4.2). Everything is required and exactly
 * typed; an unsupported version or fingerprint throws `unsupported`, anything
 * else `invalid_output`.
 * @param {any} json - The parsed body
 * @returns {{release:string, releaseCommit:string, compatFingerprint:string,
 *   profiles:Object<string,{gzSize:number, dbSize:number, sha256Gz:string, sha256Db:string, url:string, file:string}>}}
 */
export const validatePointer = (json) => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new PointerError('invalid_output');
  if (json.pointer_version !== 1 || json.schema_version !== 2 || json.normalize_version !== 'NORMALIZE_V1') {
    throw new PointerError('unsupported');
  }
  if (typeof json.compat_fingerprint !== 'string') throw new PointerError('invalid_output');
  if (!SUPPORTED_FINGERPRINTS.includes(json.compat_fingerprint)) throw new PointerError('unsupported');
  if (!parseRelease(json.release)) throw new PointerError('invalid_output');
  if (typeof json.release_commit !== 'string' || !HEX40.test(json.release_commit)) throw new PointerError('invalid_output');
  const source = json.profiles;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new PointerError('invalid_output');

  const profiles = {};
  for (const profile of PROFILES) {
    const p = source[profile];
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PointerError('invalid_output');
    if (!isPositiveSafeInt(p.gz_size) || !isPositiveSafeInt(p.db_size)) throw new PointerError('invalid_output');
    if (typeof p.sha256_gz !== 'string' || !HEX64.test(p.sha256_gz)) throw new PointerError('invalid_output');
    if (typeof p.sha256_db !== 'string' || !HEX64.test(p.sha256_db)) throw new PointerError('invalid_output');
    if (!checkUrl(p.url_pinned, json.release_commit, json.release, profile)) throw new PointerError('invalid_output');
    profiles[profile] = {
      gzSize: p.gz_size,
      dbSize: p.db_size,
      sha256Gz: p.sha256_gz,
      sha256Db: p.sha256_db,
      url: p.url_pinned,
      file: `lcsh-${profile}.db.gz`
    };
  }
  return {
    release: json.release,
    releaseCommit: json.release_commit,
    compatFingerprint: json.compat_fingerprint,
    profiles
  };
};

/**
 * Fetch and validate the pointer. The installer uses only the returned profile
 * entries; it never reads the manifest or the index files.
 * @param {{fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number, url?:string}} [opts] - Overrides for tests
 * @returns {Promise<ReturnType<typeof validatePointer>>}
 */
export const fetchPointer = async ({
  fetchImpl = (...args) => globalThis.fetch(...args), signal, timeoutMs = POINTER_TIMEOUT_MS, url = POINTER_URL
} = {}) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
    } catch (err) {
      throw new PointerError(timedOut ? 'timeout' : 'network');
    }
    if (res.status !== 200) throw new PointerError('server');
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch (err) {
      if (timedOut) throw new PointerError('timeout');
      throw new PointerError('invalid_output');
    }
    return validatePointer(json);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

/** At most one automatic check per 24 h (§4.6). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The update check, owned by the DOCUMENT rather than by the Settings panel
 * (review finding 13). The throttle governs only the AUTOMATIC check; a
 * validated pointer is cached here and stays available to the panel however
 * often it is mounted, and `refresh()` is always allowed.
 *
 * @param {{fetchPointerImpl?:Function, readCheck:Function, writeCheck:Function, now?:()=>number}} deps - Injected environment
 * @returns {object}
 */
export const createUpdateChecker = ({
  fetchPointerImpl = fetchPointer, readCheck, writeCheck, now = () => Date.now()
}) => {
  let pointer = null;
  let error = null;
  let update = null;
  const listeners = new Set();

  const snapshot = () => ({ pointer, error, update });
  const notify = () => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };

  /**
   * Fetch and validate the pointer now. `installed` is the current record, used
   * only to decide whether to raise the "new data" banner.
   * @param {object|null} [installed] - The installed record
   * @returns {Promise<object|null>} - The validated pointer, or null on failure
   */
  const refresh = async (installed = null) => {
    try {
      const value = await fetchPointerImpl();
      pointer = value;
      error = null;
      if (installed?.release && compareReleases(value.release, installed.release) > 0) {
        update = { release: value.release, changesUrl: changesUrl(value) };
      } else {
        update = null;
      }
      await writeCheck({ lastCheckedAt: now(), latestSeen: value.release });
      notify();
      return value;
    } catch (err) {
      // The installed database stays usable; only the banner is missing.
      error = err instanceof PointerError ? err.message : 'The release information could not be read.';
      notify();
      return null;
    }
  };

  return {
    snapshot,
    pointer: () => pointer,
    error: () => error,
    update: () => update,
    refresh,
    /**
     * The automatic check when the owner page opens: at most once per 24 h,
     * and only when a database is installed.
     * @param {object|null} installed - The installed record
     * @returns {Promise<void>}
     */
    async checkOnOpen(installed = null) {
      // P6 security review finding 3: with no database installed, nothing
      // contacts Hugging Face on its own. The pointer is fetched only by a user
      // action (the §4.3 confirmation or "Check for a new release": refresh()).
      if (!installed) return;
      let last = null;
      try {
        last = await readCheck();
      } catch (err) {
        last = null;
      }
      if (last && now() - last.lastCheckedAt <= UPDATE_CHECK_INTERVAL_MS) return;
      await refresh(installed);
    },
    /**
     * Subscribe; the listener is called once immediately with the snapshot.
     * @param {(value:object)=>void} listener - Callback
     * @returns {()=>void} - Unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    }
  };
};

export default fetchPointer;
