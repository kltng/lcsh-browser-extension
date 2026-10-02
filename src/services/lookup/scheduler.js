/**
 * Request scheduling for id.loc.gov (SPEC-P4 §4.5) and the per-run cache
 * (§4.2). One queue per page: at most 2 requests in flight, at least 500 ms
 * between request starts, a shared cooldown on 429/503, a 15 s timeout per
 * request, and cancellation of active AND queued work by the caller's signal.
 * Tabs do not share the queue (documented P4 limitation).
 */
import { parseRetryAfter } from '../providers/http';
import { KEY_ECHO_MESSAGES } from '../keyGuard';

export const LOC_USER_AGENT = 'LCSH-Browser-Extension/1.1 (https://github.com/kltng/lcsh-browser-extension)';

const MESSAGES = {
  network: 'Could not reach id.loc.gov. Check your connection.',
  timeout: 'id.loc.gov did not answer in time.',
  rate_limit: 'id.loc.gov asked for fewer requests (rate limit). Try again in a minute.',
  server: 'id.loc.gov returned an error. Try again later.',
  invalid_output: 'id.loc.gov returned an answer in an unexpected format.',
  // P6 fix 13, exit (a): the query was refused before it was built.
  key_echo: KEY_ECHO_MESSAGES.lookup,
  cancelled: 'Cancelled.'
};

/** A lookup request failure. The message is local text; no response data is kept. */
export class LookupError extends Error {
  /**
   * @param {'network'|'timeout'|'rate_limit'|'server'|'invalid_output'|'cancelled'} kind - Failure kind
   * @param {{status?:number}} [ctx] - Local facts only
   */
  constructor(kind, { status } = {}) {
    super(MESSAGES[kind] || MESSAGES.server);
    this.name = 'LookupError';
    this.kind = MESSAGES[kind] ? kind : 'server';
    this.status = typeof status === 'number' ? status : null;
  }
}

/**
 * The user message for a lookup error kind.
 * @param {string} kind - Error kind
 * @returns {string}
 */
export const lookupErrorMessage = (kind) => MESSAGES[kind] || MESSAGES.server;

const raceAbort = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException('Aborted', 'AbortError'));
    return;
  }
  const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
});

const discardBody = (res) => {
  try {
    const pending = res?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (e) {
    // Nothing to release.
  }
};

/**
 * Create a request scheduler (one per page; tests create their own).
 * @param {object} [opts] - Limits (defaults are the §4.5 values) and a fetch override
 * @returns {{request:(url:string, opts?:{signal?:AbortSignal})=>Promise<{status:number, text:string}>,
 *   stats:object, cooldownUntil:()=>number}}
 */
export const createScheduler = ({
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxInFlight = 2,
  spacingMs = 500,
  timeoutMs = 15000,
  maxRetries = 2,
  defaultWaitMs = 4000,
  maxWaitMs = 20000
} = {}) => {
  const queue = [];
  let inFlight = 0;
  let lastStart = -Infinity;
  let cooldownUntil = 0;
  let timer = null;
  const stats = { maxConcurrent: 0, starts: [] };

  const pump = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (inFlight < maxInFlight && queue.length > 0) {
      const now = Date.now();
      const at = Math.max(lastStart + spacingMs, cooldownUntil);
      if (now < at) {
        timer = setTimeout(pump, at - now);
        return;
      }
      const job = queue.shift();
      lastStart = now;
      inFlight += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, inFlight);
      stats.starts.push({ url: job.url, at: now });
      attempt(job);
    }
  };

  const settle = (job, fn, value) => {
    if (job.done) return;
    job.done = true;
    if (job.signal) job.signal.removeEventListener('abort', job.onAbort);
    fn(value);
  };

  const attempt = async (job) => {
    const controller = new AbortController();
    job.controller = controller;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let requeued = false;
    try {
      const res = await raceAbort(fetchImpl(job.url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': LOC_USER_AGENT },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal
      }), controller.signal);
      if (res.status === 429 || res.status === 503) {
        discardBody(res);
        const parsed = parseRetryAfter(res.headers?.get?.('Retry-After') ?? null);
        const wait = parsed === null ? defaultWaitMs : parsed;
        if (wait > maxWaitMs) throw new LookupError('rate_limit', { status: res.status });
        // The server asked the PAGE to pause: the shared cooldown applies even
        // when this request has no retry left.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        if (job.retries >= maxRetries) {
          throw new LookupError(res.status === 429 ? 'rate_limit' : 'server', { status: res.status });
        }
        job.retries += 1;
        queue.unshift(job);
        requeued = true;
        return;
      }
      if (!res.ok) {
        discardBody(res);
        throw new LookupError('server', { status: res.status });
      }
      const text = await raceAbort(res.text(), controller.signal);
      settle(job, job.resolve, { status: res.status, text });
    } catch (err) {
      let error = err instanceof LookupError ? err : new LookupError('network');
      if (job.cancelled) error = new LookupError('cancelled');
      else if (timedOut) error = new LookupError('timeout');
      settle(job, job.reject, error);
    } finally {
      clearTimeout(deadline);
      job.controller = null;
      inFlight -= 1;
      if (requeued && job.cancelled) {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
      }
      pump();
    }
  };

  /**
   * Queue one GET request.
   * @param {string} url - Request URL
   * @param {{signal?:AbortSignal}} [opts] - Caller signal (cancels queued and active work)
   * @returns {Promise<{status:number, text:string}>}
   */
  const request = (url, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LookupError('cancelled'));
      return;
    }
    const job = { url, signal, resolve, reject, retries: 0, done: false, cancelled: false, controller: null };
    job.onAbort = () => {
      job.cancelled = true;
      const i = queue.indexOf(job);
      if (i >= 0) {
        queue.splice(i, 1);
        settle(job, job.reject, new LookupError('cancelled'));
        return;
      }
      if (job.controller) job.controller.abort();
    };
    if (signal) signal.addEventListener('abort', job.onAbort, { once: true });
    queue.push(job);
    pump();
  });

  return { request, stats, cooldownUntil: () => cooldownUntil, queued: () => queue.length, inFlight: () => inFlight };
};

let pageScheduler = null;

/**
 * The one scheduler of this page, used by all lookups of the page.
 * @returns {ReturnType<typeof createScheduler>}
 */
export const getPageScheduler = () => {
  if (!pageScheduler) pageScheduler = createScheduler();
  return pageScheduler;
};

/**
 * The per-run cache, keyed by URL (§4.2). It stores successful, validated
 * values only; identical in-flight requests are coalesced; a consumer that
 * cancels does not cancel the shared request while another consumer waits;
 * failed and cancelled entries are evicted; `bypass` ignores a COMPLETED entry.
 * @returns {{get:(url:string, load:(signal:AbortSignal)=>Promise<any>, opts?:{signal?:AbortSignal, bypass?:boolean})=>Promise<any>, has:(url:string)=>boolean, size:()=>number}}
 */
export const createRunCache = () => {
  const entries = new Map();

  const consume = (url, entry, signal) => new Promise((resolve, reject) => {
    entry.consumers += 1;
    let finished = false;
    const finish = () => {
      finished = true;
      entry.consumers -= 1;
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (finished) return;
      finish();
      if (entry.consumers === 0 && entry.status === 'pending') {
        if (entries.get(url) === entry) entries.delete(url);
        entry.controller.abort();
      }
      reject(new LookupError('cancelled'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    entry.promise.then(
      (value) => { if (!finished) { finish(); resolve(value); } },
      (err) => { if (!finished) { finish(); reject(err); } }
    );
  });

  const get = (url, load, { signal, bypass = false } = {}) => {
    let entry = entries.get(url);
    if (entry && entry.status === 'done' && !bypass) return Promise.resolve(entry.value);
    if (!entry || entry.status === 'done') {
      const controller = new AbortController();
      const created = { status: 'pending', consumers: 0, controller, value: undefined };
      created.promise = Promise.resolve()
        .then(() => load(controller.signal))
        .then((value) => {
          if (entries.get(url) === created) {
            created.status = 'done';
            created.value = value;
          }
          return value;
        }, (err) => {
          if (entries.get(url) === created) entries.delete(url);
          throw err;
        });
      created.promise.catch(() => {});
      entries.set(url, created);
      entry = created;
    }
    return consume(url, entry, signal);
  };

  return { get, has: (url) => entries.has(url), isDone: (url) => entries.get(url)?.status === 'done', size: () => entries.size };
};

export default createScheduler;
