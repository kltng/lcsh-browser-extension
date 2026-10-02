/**
 * HTTP transport with one absolute deadline per public operation (SPEC-P3 §4.5).
 */
import { ProviderError, errorFromStatus } from './errors';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [1000, 2000];

/**
 * Create one operation: a single AbortController for the deadline plus the
 * caller's signal. It records which one fired first.
 * @param {{deadlineMs:number, signal?:AbortSignal}} opts - Deadline and caller signal
 * @returns {{signal:AbortSignal, reason:()=>('timeout'|'cancelled'|null), remaining:()=>number, close:()=>void}}
 */
export const createOperation = ({ deadlineMs, signal } = {}) => {
  const controller = new AbortController();
  const endsAt = Date.now() + deadlineMs;
  let reason = null;
  const fire = (source) => {
    if (reason) return;
    reason = source;
    controller.abort();
  };
  const timer = setTimeout(() => fire('timeout'), deadlineMs);
  const onCallerAbort = () => fire('cancelled');
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    reason: () => reason,
    remaining: () => endsAt - Date.now(),
    close: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      // Terminate any transport work still outstanding (for example a late
      // body stream). `reason` is not touched, so the error already reported
      // for this operation keeps its kind.
      if (!controller.signal.aborted) controller.abort();
    }
  };
};

/**
 * Cancel a response body that will not be read. Guarded; errors are swallowed.
 * @param {Response} res - A fetch response
 */
export const discardBody = (res) => {
  try {
    const pending = res?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (e) {
    // The body was already used or is not cancellable: nothing to release.
  }
};

/**
 * The ProviderError for an operation that was aborted (deadline or caller).
 * @param {object} op - Operation from createOperation()
 * @param {object} ctx - Result of errorContext()
 * @returns {ProviderError}
 */
export const abortError = (op, ctx) => (
  new ProviderError(op.reason() === 'timeout' ? 'timeout' : 'cancelled', ctx)
);

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts.
 * @param {Promise<any>} promise - Work to wait for
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<any>}
 */
export const raceAbort = (promise, signal) => new Promise((resolve, reject) => {
  const abortErr = () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  };
  if (signal.aborted) {
    reject(abortErr());
    return;
  }
  const onAbort = () => reject(abortErr());
  signal.addEventListener('abort', onAbort, { once: true });
  Promise.resolve(promise).then(resolve, reject).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
});

const sleep = (ms, signal) => raceAbort(new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}), signal);

/**
 * Parse a Retry-After header (seconds or an HTTP date).
 * @param {string|null} value - Header value
 * @returns {number|null} - Milliseconds to wait, or null when absent/invalid
 */
export const parseRetryAfter = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
};

/**
 * fetch() with retries, backoff and one deadline for the whole operation,
 * including every body read and every backoff sleep.
 * Non-2xx statuses (after retries) become ProviderErrors, except `passStatuses`.
 * @param {string} url - Request URL
 * @param {RequestInit} init - fetch init (method, headers, body)
 * @param {{op?:object, deadlineMs?:number, signal?:AbortSignal, maxRetries?:number,
 *   ctx:object, passStatuses?:number[]}} opts - Operation (or deadline + signal) and error context
 * @returns {Promise<{status:number, text:string|null}>}
 */
export const fetchWithDeadline = async (url, init, opts) => {
  const { maxRetries = 2, ctx, passStatuses = [] } = opts;
  const ownOp = !opts.op;
  const op = opts.op || createOperation({ deadlineMs: opts.deadlineMs, signal: opts.signal });
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await raceAbort(fetch(url, {
          ...init,
          signal: op.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          // P6 security review finding 2: never follow a redirect. A key in a
          // custom header (x-goog-api-key, x-api-key) is not stripped by Fetch
          // on a cross-origin redirect, so a 3xx must end the request. Fetch
          // rejects with a TypeError, which becomes the typed `network` error.
          redirect: 'error'
        }), op.signal);
      } catch (err) {
        if (op.reason()) throw abortError(op, ctx);
        if (err instanceof TypeError && attempt < maxRetries) {
          if (BACKOFF_MS[attempt] > op.remaining()) throw new ProviderError('network', ctx);
          await sleep(BACKOFF_MS[attempt], op.signal);
          continue;
        }
        throw new ProviderError('network', ctx);
      }

      if (res.ok) {
        let text = null;
        try {
          text = await raceAbort(res.text(), op.signal);
        } catch (err) {
          if (op.reason()) throw abortError(op, ctx);
          throw new ProviderError('network', ctx);
        }
        return { status: res.status, text };
      }

      // Every non-2xx body is discarded unread (never parsed, never shown).
      discardBody(res);
      if (passStatuses.includes(res.status)) return { status: res.status, text: null };

      if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(res.headers?.get?.('retry-after') ?? null);
        const wait = retryAfter ?? BACKOFF_MS[attempt];
        if (wait > op.remaining()) throw errorFromStatus(res.status, ctx);
        await sleep(wait, op.signal);
        continue;
      }
      throw errorFromStatus(res.status, ctx);
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (op.reason()) throw abortError(op, ctx);
    throw new ProviderError('network', ctx);
  } finally {
    if (ownOp) op.close();
  }
};

/**
 * Parse a 2xx body as JSON; anything else is `invalid_output`.
 * @param {string|null} text - Response body
 * @param {object} ctx - Result of errorContext()
 * @returns {object}
 */
export const parseJsonBody = (text, ctx) => {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') return data;
  } catch (e) {
    // fall through: the body is not JSON
  }
  throw new ProviderError('invalid_output', ctx);
};

export default fetchWithDeadline;
