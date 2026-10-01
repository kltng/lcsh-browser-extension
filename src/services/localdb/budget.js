/**
 * The cooperative work budget of SPEC-P5 §4.4 step 7b.
 *
 * Live finding (2026-10-01): during the real `full` install the worker stopped
 * answering for more than 2 s, five times. Reading buffered stream data
 * resolves as MICROTASKS and every SAH write is synchronous, so a pull loop
 * that only awaits resolved promises never gives the worker's event loop a
 * turn: `status` and `cancel` messages wait behind the whole import, and the
 * page's watchdog then replaced a worker that was merely busy.
 *
 * One budget is shared by the whole install — import pull, hashing and the
 * stored-byte read-back. Callers invoke `checkpoint()` between BOUNDED work
 * units; once `budgetMs` (100 ms) of monotonic time has passed since the last
 * yield, it awaits a MACROTASK. A resolved Promise is not a yield.
 *
 * It never prefetches and never starts work of its own: it only decides
 * WHEN the caller's next unit may begin, so stream backpressure is unchanged.
 */

/** Yield once this much monotonic time has passed since the last yield. */
export const WORK_BUDGET_MS = 100;

/**
 * A real macrotask: the callback runs in a NEW task, after any message events
 * already queued for this worker. `MessageChannel` is preferred because it is
 * not clamped like nested `setTimeout(0)`.
 * @returns {Promise<void>}
 */
export const macrotask = () => new Promise((resolve) => {
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
    return;
  }
  setTimeout(resolve, 0);
});

/** The monotonic clock (never `Date.now()`, which can jump). */
export const monotonicNow = () => globalThis.performance.now();

/**
 * Create one shared budget.
 * @param {{now?:()=>number, yieldToMacrotask?:()=>Promise<void>, budgetMs?:number}} [deps] - Clock, scheduler, budget
 * @returns {{checkpoint:()=>Promise<boolean>, yields:()=>number}}
 */
export const createWorkBudget = ({
  now = monotonicNow, yieldToMacrotask = macrotask, budgetMs = WORK_BUDGET_MS
} = {}) => {
  let lastYield = now();
  let count = 0;
  return {
    /**
     * Call between bounded work units. Resolves `true` when it yielded.
     * @returns {Promise<boolean>}
     */
    async checkpoint() {
      if (now() - lastYield < budgetMs) return false;
      await yieldToMacrotask();
      lastYield = now();
      count += 1;
      return true;
    },
    /** How many macrotask yields this budget has made (tests, diagnostics). */
    yields: () => count
  };
};

export default createWorkBudget;
