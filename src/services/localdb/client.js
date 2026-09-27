/**
 * The ONE page-side owner client (SPEC-P5 §3). It is created at module level
 * in `app.html`, above the hash-route components, so hash navigation never
 * terminates it; the popup never creates one.
 *
 * Order of operations is the point of this file:
 *  - the owner Web Lock is requested BEFORE the worker exists, and held until
 *    the document ends (no unload handler; §3.1);
 *  - lock order is always owner → settings, and settings operations never wait
 *    for ownership (§3.1);
 *  - the §3.3 settings bridge admits a worker request only for the CURRENT
 *    worker generation and the RUNNING operation, and rechecks both
 *    immediately before the write (HOUSE_RULES 13);
 *  - replacing the worker drains every ADMITTED commit handler before the new
 *    worker's §3.4 recovery starts (§3.3).
 */
import { readLocalDbSettings, commitLocalDb } from '../settings';

export const OWNER_LOCK = 'lcsh-localdb-owner';
export const STATUS_TIMEOUT_MS = 10000;
/** How often the client asks the worker for a status while it owns one (§3.2). */
export const STATUS_PROBE_MS = 10000;
/** One re-create after the first crash; a second crash gives up for this document. */
export const MAX_WORKER_STARTS = 2;
export const RECOVERY_OPERATION = 'internal-recovery';
/** Phases after which Cancel stays disabled until the operation ends (§8). */
export const FINAL_PHASES = ['committing', 'cleaning'];

const MESSAGES = {
  db_worker_failed: 'The local database stopped responding.',
  db_busy: 'The local database is in use. Close the other tab and try again.',
  db_generation_changed: 'The local database changed while this search was running.',
  db_not_ready: 'The local database is not available in this tab.',
  cancelled: 'Cancelled.'
};

/** A local-database failure. Local text only (HOUSE_RULES 6). */
export class LocalDbError extends Error {
  /** @param {string} kind - Failure kind */
  constructor(kind) {
    super(MESSAGES[kind] || MESSAGES.db_worker_failed);
    this.name = 'LocalDbError';
    this.kind = MESSAGES[kind] ? kind : 'db_worker_failed';
  }
}

/**
 * Create the owner client.
 * @param {{createWorker:Function, locks?:object, settingsApi?:object, statusTimeoutMs?:number,
 *   onChange?:Function, onProgress?:Function}} deps - Injected environment
 * @returns {object}
 */
export const createLocalDbClient = ({
  createWorker,
  locks = navigator.locks,
  settingsApi = { read: readLocalDbSettings, commit: commitLocalDb },
  statusTimeoutMs = STATUS_TIMEOUT_MS,
  probeMs = STATUS_PROBE_MS,
  onChange = () => {},
  onProgress = () => {}
}) => {
  let generation = 0;
  let starts = 0;
  let crashes = 0;
  let worker = null;
  let state = 'starting';
  let record = null;
  let runningOperation = null;
  let seq = 0;
  let releaseLock = null;
  let watchdog = null;
  let probe = null;
  let replacing = null;
  let givingUp = null;
  // Review finding 9: the operation and its progress belong to the DOCUMENT,
  // not to the mounted Settings panel, so leaving and returning to Settings
  // during an install shows the same state.
  let operation = null;
  let progress = null;
  let gated = false;
  const pending = new Map();
  const admitted = new Set();
  const changeListeners = new Set([onChange]);
  const progressListeners = new Set([onProgress]);

  const snapshot = () => ({ state, record, operation, progress, gated });
  const notify = () => {
    const value = snapshot();
    for (const listener of changeListeners) listener(value);
  };
  const notifyProgress = () => {
    const value = snapshot();
    for (const listener of progressListeners) listener(value);
  };

  const setState = (next, info = {}) => {
    if (Object.hasOwn(info, 'record')) record = info.record;
    if (state === next) return;
    state = next;
    notify();
  };

  /**
   * Update the running operation's phase. Once it reaches `committing` it
   * never goes back, so Cancel stays disabled through completion (§8).
   */
  const setPhase = (operationId, phase) => {
    if (!operation || operation.operationId !== operationId) return;
    if (FINAL_PHASES.includes(operation.phase) && !FINAL_PHASES.includes(phase)) return;
    operation = { operationId, phase };
    notifyProgress();
  };

  const postTo = (target, message) => {
    try {
      target?.postMessage(message);
    } catch (e) {
      // A terminated worker cannot answer; the watchdog handles the rest.
    }
  };
  const post = (message) => postTo(worker, message);

  const rejectPending = (kind) => {
    for (const [, entry] of pending) {
      entry.release();
      entry.reject(new LocalDbError(kind));
    }
    pending.clear();
  };

  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const clearProbe = () => {
    if (probe) clearTimeout(probe);
    probe = null;
  };

  /** The §3.3 admission test: current generation AND the running operation. */
  const isCurrent = (workerGeneration, operationId) =>
    workerGeneration === generation && operationId === runningOperation;

  // The answer always goes back to the worker that ASKED, never to a worker
  // that replaced it meanwhile (it would not know the bridge id).
  const answerBridge = (target, bridgeId, answer) => postTo(target, { type: 'bridge-result', bridgeId, ...answer });

  const handleBridge = (message, source) => {
    const { bridgeId, workerGeneration, operationId, action, expectedLocalDb, patch } = message;
    if (!isCurrent(workerGeneration, operationId)) {
      answerBridge(source, bridgeId, { ok: false, reason: 'stale-generation' });
      return;
    }
    const handler = (async () => {
      if (action === 'read') {
        const current = await settingsApi.read();
        answerBridge(source, bridgeId, { ok: true, current });
        return;
      }
      const result = await settingsApi.commit({
        expectedLocalDb: expectedLocalDb ?? null,
        patch,
        // Step 4: rechecked immediately before the write, no await in between.
        fence: () => isCurrent(workerGeneration, operationId)
      });
      answerBridge(source, bridgeId, result);
    })().catch(() => {
      answerBridge(source, bridgeId, { ok: false, reason: 'write-failed' });
    });
    admitted.add(handler);
    handler.finally(() => admitted.delete(handler));
  };

  const handleMessage = (message, source) => {
    // Review finding 4: a message from a worker this client has already
    // replaced proves nothing and must change nothing.
    if (source !== worker) return;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'bridge') {
      handleBridge(message, source);
      return;
    }
    if (message.type === 'phase') {
      setPhase(message.operationId, message.phase);
      return;
    }
    if (message.type === 'gate') {
      // A gate change is NOT a mutation phase (review finding 9).
      gated = Boolean(message.gated);
      notifyProgress();
      return;
    }
    if (message.type === 'progress') {
      setPhase(message.operationId, message.phase);
      progress = { phase: message.phase, done: message.done, total: message.total };
      notifyProgress();
      return;
    }
    if (message.type === 'state') {
      setState(message.state, { record: message.record ?? null });
      return;
    }
    if (message.type !== 'rpc-result') return;
    const entry = pending.get(message.id);
    if (!entry) return; // A late reply of a cancelled call is ignored.
    pending.delete(message.id);
    entry.release();
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new LocalDbError(message.error?.kind));
  };

  /**
   * N1: end the local database for this document. It is called when the
   * REPLACEMENT worker itself fails — its watchdog used to hit
   * `replaceWorker()`, which just handed back the pending replacement promise,
   * so nothing terminated that worker and nothing rejected its recovery. The
   * client could stay `starting` (or stale `ready`) for ever.
   *
   * The generation is raised first, so a late message or an admitted bridge
   * handler can no longer be admitted, and no third worker is ever started.
   */
  function giveUp() {
    if (givingUp) return givingUp;
    generation += 1;
    clearWatchdog();
    clearProbe();
    runningOperation = null;
    rejectPending('db_worker_failed');
    try {
      worker?.terminate();
    } catch (e) {
      // Already gone.
    }
    worker = null;
    setState('worker-failed', { record: null });
    // Draining is preserved: already-issued writes still settle.
    givingUp = Promise.allSettled([...admitted]).then(() => {}).finally(() => { givingUp = null; });
    return givingUp;
  }

  const crash = (myGeneration) => {
    if (myGeneration !== undefined && myGeneration !== generation) return;
    crashes += 1;
    // A failure WHILE a replacement is being brought up, or a spent budget,
    // ends it here; only the first crash gets a replacement worker.
    if (replacing || crashes >= MAX_WORKER_STARTS) return giveUp();
    return replaceWorker();
  };

  function replaceWorker() {
    // Serialize: two crash signals must not start two workers.
    if (replacing) return replacing;
    // The generation is raised FIRST, so a bridge request that is still in
    // flight can no longer be admitted, and an admitted one fails its fence.
    generation += 1;
    clearWatchdog();
    clearProbe();
    rejectPending('db_worker_failed');
    try {
      worker?.terminate();
    } catch (e) {
      // Already gone.
    }
    worker = null;
    replacing = (async () => {
      // Drain: already-issued writes finish before the new worker starts.
      await Promise.allSettled([...admitted]);
      if (crashes >= MAX_WORKER_STARTS) {
        await giveUp();
        return;
      }
      await startWorker();
    })().finally(() => { replacing = null; });
    return replacing;
  }

  /**
   * Review finding 4: one status probe every `probeMs`, each with its OWN
   * deadline. A worker that answers once and then goes silent is replaced.
   */
  function scheduleProbe(myGeneration) {
    clearProbe();
    probe = setTimeout(async () => {
      if (generation !== myGeneration || !worker) return;
      const deadline = setTimeout(() => crash(myGeneration), statusTimeoutMs);
      try {
        await call('status', {});
      } catch (err) {
        // A replaced worker rejects its pending calls; the crash path owns it.
      } finally {
        clearTimeout(deadline);
      }
      if (generation === myGeneration && worker) scheduleProbe(myGeneration);
    }, probeMs);
  }

  async function startWorker() {
    starts += 1;
    generation += 1;
    const myGeneration = generation;
    runningOperation = RECOVERY_OPERATION;
    worker = createWorker();
    const source = worker;
    worker.addEventListener('message', (event) => handleMessage(event.data, source));
    worker.addEventListener('error', () => crash(myGeneration));
    worker.addEventListener('messageerror', () => crash(myGeneration));
    watchdog = setTimeout(() => crash(myGeneration), statusTimeoutMs);
    try {
      const result = await call('recover', { operationId: RECOVERY_OPERATION });
      clearWatchdog();
      setState(result.state, { record: result.record ?? null });
      if (generation === myGeneration) scheduleProbe(myGeneration);
    } catch (err) {
      clearWatchdog();
      crash(myGeneration);
    } finally {
      if (generation === myGeneration) runningOperation = null;
      clearWatchdog();
    }
  }

  function call(op, args, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new LocalDbError('db_worker_failed'));
        return;
      }
      if (signal?.aborted) {
        reject(new LocalDbError('cancelled'));
        return;
      }
      seq += 1;
      const id = seq;
      let onAbort = null;
      // The abort listener is removed when the call settles, however it
      // settles (HOUSE_RULES 12).
      const release = () => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        onAbort = null;
      };
      pending.set(id, { resolve, reject, release });
      if (signal) {
        onAbort = () => {
          if (!pending.delete(id)) return;
          release();
          post({ type: 'drop', id });
          reject(new LocalDbError('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      post({ type: 'rpc', id, op, args, workerGeneration: generation });
    });
  }

  /**
   * One mutation at a time. Review finding 3: a second mutation is refused
   * SYNCHRONOUSLY, before it can take ownership of the running one's identity.
   */
  const mutate = async (op, args) => {
    const operationId = args.operationId;
    if (runningOperation !== null) throw new LocalDbError('db_busy');
    runningOperation = operationId;
    operation = { operationId, phase: 'preparing' };
    progress = null;
    notifyProgress();
    try {
      return await call(op, args);
    } finally {
      if (runningOperation === operationId) runningOperation = null;
      if (operation?.operationId === operationId) {
        operation = null;
        progress = null;
        notifyProgress();
      }
    }
  };

  return {
    /**
     * Request ownership and start the worker. Never throws: a tab that is not
     * the owner simply uses the online backend.
     * @returns {Promise<string>} - The resulting state
     */
    async start() {
      if (releaseLock) return state;
      let granted;
      const gotLock = new Promise((resolve) => { granted = resolve; });
      const held = new Promise((resolve) => { releaseLock = resolve; });
      locks.request(OWNER_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        granted(Boolean(lock));
        // Held until the document ends; the browser releases it then. No
        // unload handler, so correctness never depends on one.
        return lock ? held : undefined;
      }).catch(() => granted(false));
      if (!(await gotLock)) {
        releaseLock = null;
        setState('other-tab', { record: null });
        return state;
      }
      await startWorker();
      return state;
    },
    /** "Try again" after the owner tab closed. */
    async retryOwnership() {
      if (state !== 'other-tab') return state;
      crashes = 0;
      return this.start();
    },
    state: () => state,
    record: () => record,
    workerGeneration: () => generation,
    /** The running mutation of this DOCUMENT, or null (§8, review finding 9). */
    operation: () => operation,
    /** The latest progress event of the running mutation, or null. */
    progress: () => progress,
    /** The whole client snapshot, for a component that just mounted. */
    snapshot,
    /**
     * The installation identity to use for a lookup ATTEMPT (§6.5). It is read
     * fresh each time, so a lookup started after a repair or update uses the
     * new file; the caller keeps the returned object for all of its queries.
     * @returns {{profile:string, release:string, releaseCommit:string, file:string}|null}
     */
    installation() {
      if (state !== 'ready' || !record) return null;
      const { profile, release, releaseCommit, file } = record;
      return { profile, release, releaseCommit, file };
    },
    /**
     * Subscribe to state changes. The listener is called once IMMEDIATELY with
     * the current snapshot, so a remounted panel never shows a blank state.
     * @param {(status:object)=>void} listener - Callback
     * @returns {()=>void} - Unsubscribe
     */
    onChange(listener) {
      changeListeners.add(listener);
      listener(snapshot());
      return () => changeListeners.delete(listener);
    },
    /**
     * Subscribe to install progress, phase and gate events (snapshot first).
     * @param {(event:object)=>void} listener - Callback
     * @returns {()=>void} - Unsubscribe
     */
    onProgress(listener) {
      progressListeners.add(listener);
      listener(snapshot());
      return () => progressListeners.delete(listener);
    },
    /**
     * Run one NAMED query. Local queries are served only in the `ready` state.
     * @param {string} name - Q1 | Q2 | Q3a | Q3b | Q4 | Q5
     * @param {object} args - Bound values, the installation identity and the signal
     * @returns {Promise<object[]>}
     */
    query(name, { signal, ...args } = {}) {
      if (state !== 'ready') return Promise.reject(new LocalDbError('db_not_ready'));
      return call('query', { name, ...args }, { signal });
    },
    status: () => call('status', {}),
    install: (args) => mutate('install', args),
    uninstall: (args) => mutate('uninstall', args),
    cancel: (operationId) => call('cancel', { operationId }),
    /** Whether this document has given up on the local database (tests). */
    workerStarts: () => starts,
    /** Tests and page teardown; in the browser the document's end does this. */
    dispose() {
      clearWatchdog();
      clearProbe();
      rejectPending('db_worker_failed');
      try {
        worker?.terminate();
      } catch (e) {
        // Already gone.
      }
      worker = null;
      if (releaseLock) releaseLock();
      releaseLock = null;
      setState('starting', { record: null });
    }
  };
};

export default createLocalDbClient;
