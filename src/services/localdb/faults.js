/**
 * The fault-injection test build (SPEC-P5 §21). NOTHING here runs in the
 * shipped extension: it is LOADED only by a `require()` inside a compile-time
 * `if (__LCSH_FAULTS__)` branch (app.jsx, worker.js), which is `false` in
 * `webpack.prod.js` and `webpack.dev.js`. Webpack does not follow a require in
 * a dead branch, so neither build contains this module or runs its top-level
 * initialization. No production file imports it statically.
 *
 * Ownership (§21 "Plan"): the PAGE parses the plan once, owns the delete
 * occurrence counter and the consumed-point set, and acknowledges every claim
 * before a worker injects anything. A worker only receives the unconsumed
 * worker points in its first `acquire` RPC, and asks the page each time.
 */

/** The supported modes per point (§21 "Modes"). Every other pair is ignored. */
export const FAULT_MODES = {
  'import-write': ['throw', 'crash'],
  'commit-before': ['throw', 'crash'],
  'commit-lost': ['throw', 'crash'],
  delete: ['throw', 'crash'],
  'after-switch': ['crash'],
  'settings-write': ['throw']
};

/** Points injected inside the worker; `settings-write` is page-side. */
export const WORKER_FAULT_POINTS = ['import-write', 'commit-before', 'commit-lost', 'delete', 'after-switch'];

/** `import-write` fires only after this many bytes were handed to and processed by the importer. */
export const IMPORT_FAULT_AFTER_BYTES = 64 * 1024 * 1024;

const isSupported = (point, mode) => Object.hasOwn(FAULT_MODES, point) && FAULT_MODES[point].includes(mode);

/**
 * Parse `?faults=<point>[@<occurrence>]:<mode>[,...]`. Unknown points,
 * unsupported modes, invalid occurrence numbers and duplicate entries for a
 * point are ignored with a warning; the first valid entry of a point wins.
 * @param {string} search - The document's `location.search`
 * @param {(text:string)=>void} [warn] - Warning sink
 * @returns {Map<string, {mode:string, occurrence:number}>}
 */
export function parseFaultPlan(search, warn = () => {}) {
  const plan = new Map();
  const value = new URLSearchParams(search || '').get('faults');
  if (!value) return plan;
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = /^([a-z-]+)(?:@([^:]*))?:([a-z]+)$/.exec(entry);
    if (!match) {
      warn(`[fault] ignored "${entry}": not <point>[@<occurrence>]:<mode>`);
      continue;
    }
    const [, point, occurrenceText, mode] = match;
    if (!Object.hasOwn(FAULT_MODES, point)) {
      warn(`[fault] ignored "${entry}": unknown point`);
      continue;
    }
    if (!isSupported(point, mode)) {
      warn(`[fault] ignored "${entry}": unsupported mode`);
      continue;
    }
    let occurrence = 1;
    if (occurrenceText !== undefined) {
      // The spelling AND the converted value: "9…9" can become Infinity or
      // round to a different number, so only a safe positive integer counts.
      const value = Number(occurrenceText);
      if (point !== 'delete' || !/^[1-9]\d*$/.test(occurrenceText) || !Number.isSafeInteger(value)) {
        warn(`[fault] ignored "${entry}": invalid occurrence number`);
        continue;
      }
      occurrence = value;
    }
    if (plan.has(point)) {
      warn(`[fault] ignored "${entry}": duplicate entry for ${point}`);
      continue;
    }
    plan.set(point, { mode, occurrence });
  }
  return plan;
}

/**
 * The page-owned fault state of ONE document.
 * @param {{search:string, log?:(...args:any[])=>void, warn?:(text:string)=>void}} args - The query and the log sinks
 * @returns {object}
 */
export function createDocumentFaults({
  search,
  log = (...args) => console.warn(...args),
  warn = (text) => console.warn(text)
}) {
  const plan = parseFaultPlan(search, warn);
  const consumed = new Set();
  // Eligible unlink attempts across ALL worker generations of this document.
  let deleteAttempts = 0;

  /** Record one claim; returns the mode when the point fires now, else null. */
  const claim = ({ point, workerGeneration = null, operationId = null, file = null }) => {
    const entry = plan.get(point);
    if (!entry || consumed.has(point)) return null;
    const details = { operation: operationId, workerGeneration };
    if (point === 'delete') {
      deleteAttempts += 1;
      if (deleteAttempts !== entry.occurrence) return null;
      details.file = file;
      details.occurrence = deleteAttempts;
    }
    consumed.add(point);
    log(`[fault] ${point}:${entry.mode}`, details);
    return entry.mode;
  };

  return {
    /** The parsed plan (tests). */
    plan: () => new Map(plan),
    /** The points that already fired in this document. */
    consumed: () => [...consumed],
    /**
     * The fault-only field of a worker's first `acquire` RPC: the worker
     * points that have not fired yet, or null when there are none.
     * @returns {{points:{point:string, mode:string}[]}|null}
     */
    workerPlan() {
      const points = [...plan]
        .filter(([point]) => WORKER_FAULT_POINTS.includes(point) && !consumed.has(point))
        .map(([point, entry]) => ({ point, mode: entry.mode }));
      return points.length > 0 ? { points } : null;
    },
    /**
     * Answer a worker's claim. The client has already checked that it came
     * from the current worker; `valid` is the generation check.
     * @param {object} message - The `fault-claim` message
     * @param {boolean} valid - Whether it belongs to the current worker generation
     * @returns {{type:string, claimId:string, fire:boolean, spent:boolean}}
     */
    answerClaim(message, valid) {
      const point = message?.point;
      const fire = valid && WORKER_FAULT_POINTS.includes(point)
        ? claim({
          point, workerGeneration: message.workerGeneration, operationId: message.operationId, file: message.file
        }) !== null
        : false;
      return { type: 'fault-ack', claimId: message?.claimId, fire, spent: !plan.has(point) || consumed.has(point) };
    },
    /**
     * The page-side `settings-write` hook for one admitted bridge commit. It
     * runs synchronously inside the storage-write try block and throws
     * instead of issuing the write.
     * @param {{workerGeneration:number, operationId:string}} context - The admitted request
     * @returns {()=>void}
     */
    settingsWrite: (context) => () => {
      if (claim({ point: 'settings-write', ...context })) throw new Error('[fault] settings-write');
    }
  };
}

/**
 * The worker half: it knows only the points the page sent with `acquire`,
 * claims each selected occurrence from the page, and injects the fault only
 * after the page acknowledged it.
 * @param {{plan:object, workerGeneration:number, post:(message:object)=>void, close:()=>void}} args - Plan and environment
 * @returns {object}
 */
export function createWorkerFaults({ plan, workerGeneration, post, close }) {
  const modes = new Map();
  for (const item of Array.isArray(plan?.points) ? plan.points : []) {
    if (WORKER_FAULT_POINTS.includes(item?.point) && isSupported(item.point, item.mode)) modes.set(item.point, item.mode);
  }
  // A point the page reported as spent is never claimed again by this worker.
  const spent = new Set();
  const waiters = new Map();
  let seq = 0;

  const ask = (point, info) => new Promise((resolve) => {
    seq += 1;
    const claimId = `f${seq}`;
    waiters.set(claimId, resolve);
    post({
      type: 'fault-claim', claimId, point, workerGeneration, operationId: info.operationId ?? null, file: info.file ?? null
    });
  });

  const armed = (point) => modes.has(point) && !spent.has(point);

  /**
   * Claim `point` and, if the page selected it, inject it. `crash` closes
   * the worker and never settles, so the invoking operation goes no further.
   */
  const fire = async (point, info = {}) => {
    if (!armed(point)) return;
    // Only `delete` counts occurrences; every other point is claimed once.
    if (point !== 'delete') spent.add(point);
    const answer = await ask(point, info);
    if (answer.spent) spent.add(point);
    if (!answer.fire) return;
    spent.add(point);
    const mode = modes.get(point);
    if (mode === 'throw') {
      throw point === 'import-write'
        ? new DOMException('[fault] import-write', 'QuotaExceededError')
        : new Error(`[fault] ${point}`);
    }
    close();
    await new Promise(() => {});
  };

  return {
    armed,
    fire,
    /** Deliver the page's acknowledgement of a claim. */
    handleAck(message) {
      const resolve = waiters.get(message?.claimId);
      if (!resolve) return;
      waiters.delete(message.claimId);
      resolve({ fire: message.fire === true, spent: message.spent === true });
    },
    /**
     * Wrap the coalesced pull callback given to the real importer. The fault
     * fires on a LATER callback, once at least 64 MiB of preceding chunks were
     * returned to (and so processed by) the importer, before another chunk is
     * returned.
     * @param {()=>Promise<Uint8Array|undefined>} pull - The real pull callback
     * @param {{operationId:string}} info - The invoking operation
     * @returns {()=>Promise<Uint8Array|undefined>}
     */
    wrapImportPull(pull, info) {
      let handed = 0;
      return async () => {
        if (handed >= IMPORT_FAULT_AFTER_BYTES && armed('import-write')) await fire('import-write', info);
        const chunk = await pull();
        if (chunk) handed += chunk.byteLength;
        return chunk;
      };
    }
  };
}
