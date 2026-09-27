/**
 * Install, repair, update and uninstall of the local database
 * (SPEC-P5 §4, §3.4). It runs INSIDE the worker; every settings access goes
 * through the §3.3 page bridge, and every file operation through the injected
 * SAH-pool adapter. Nothing here touches `chrome.storage` or the DOM, so the
 * whole protocol is testable in Node with fakes.
 *
 * The invariants this file exists for:
 *  - ONE mutation at a time, named by its `operationId` (§4.1);
 *  - the commit point is the SUCCESSFUL SETTINGS WRITE (§4.5 step 7); while a
 *    commit's result is unresolved, BOTH files are kept;
 *  - the stored bytes are verified before anything is committed
 *    (HOUSE_RULES 15, §4.5 step 3);
 *  - settings never name a file that does not exist.
 */
import { hashStoredBytes, checkMeta, checkObjects, checkPageProduct, checkAgainstRecord, VerifyError } from './verify';
import {
  InstallError, coalescingPull, streamDatabase, PROGRESS_INTERVAL_MS, STALL_TIMEOUT_MS, MIN_FIRST_CHUNK
} from './download';
import { validateLocalDbSnapshot, isPoolFileName } from './record';

export { InstallError, coalescingPull, PROGRESS_INTERVAL_MS, STALL_TIMEOUT_MS, MIN_FIRST_CHUNK };

/**
 * Whether two installed records are structurally the same (`null` included).
 * @param {object|null} a - First record
 * @param {object|null} b - Second record
 * @returns {boolean}
 */
export const sameRecord = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const keys = ['profile', 'release', 'releaseCommit', 'file', 'dbSize', 'sha256Db', 'compatFingerprint', 'installedAt'];
  return keys.every((k) => a[k] === b[k]);
};

/**
 * "Already installed" (§4.6): same profile, release, digest and fingerprint.
 * @param {object|null} record - The active record
 * @param {{profile:string, release:string, sha256Db:string, compatFingerprint:string}} wanted - The selected install
 * @returns {boolean}
 */
export const isAlreadyInstalled = (record, wanted) => Boolean(record)
  && record.profile === wanted.profile && record.release === wanted.release
  && record.sha256Db === wanted.sha256Db && record.compatFingerprint === wanted.compatFingerprint;

/**
 * A staging file name that collides with nothing (§4.4 step 1).
 * @param {{profile:string, release:string, taken:string[], random:()=>string}} args - Inputs
 * @returns {string}
 */
export const stagingName = ({ profile, release, taken, random }) => {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = `/stage-${profile}-${release}-${random()}.db`;
    if (!used.has(name)) return name;
  }
  throw new InstallError('storage');
};

/**
 * Create the installer.
 * @param {{pool:object, bridge:object, fetchImpl?:Function, random?:()=>string, now?:()=>number,
 *   onProgress?:Function, onPhase?:Function, onGate?:Function, yieldToLoop?:Function,
 *   decompressionStream?:Function, stallMs?:number}} deps - Injected environment
 * @returns {object} - The installer
 */
export const createInstaller = ({
  pool,
  bridge,
  fetchImpl = (...args) => globalThis.fetch(...args),
  random = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join(''),
  now = () => Date.now(),
  onProgress = () => {},
  onPhase = () => {},
  onGate = () => {},
  yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0)),
  decompressionStream = () => new DecompressionStream('gzip'),
  stallMs = STALL_TIMEOUT_MS
}) => {
  // The one mutation, reserved SYNCHRONOUSLY before the first await
  // (HOUSE_RULES 13). `phase` reaching 'committing' refuses every cancel.
  let mutation = null;
  let active = { handle: null, record: null };
  let state = 'starting';
  let gate = null;
  // Handles whose file must be KEPT: an unresolved commit's staging handle, or
  // a handle whose close() failed. Their files are never unlinked
  // (review finding 2).
  const retained = new Set();

  const setPhase = (phase) => {
    mutation.phase = phase;
    onPhase({ operationId: mutation.operationId, phase });
  };
  const gateQueries = () => {
    if (gate) return;
    let open;
    gate = { promise: new Promise((resolve) => { open = resolve; }), open };
    onGate(true);
  };
  const ungate = () => {
    if (!gate) return;
    gate.open();
    gate = null;
    onGate(false);
  };
  const ensureFree = (operationId) => {
    if (mutation) throw new InstallError('busy');
    mutation = { operationId, phase: 'preparing', cancelled: false, controller: new AbortController() };
  };
  const checkCancelled = () => {
    if (mutation.cancelled) throw new InstallError('cancelled');
  };

  /** Read the settings for THIS operation; an invalid snapshot is a read failure. */
  const readSettings = async () => {
    const settings = await bridge.read({ operationId: mutation.operationId });
    const { valid } = validateLocalDbSnapshot(settings);
    if (!valid || settings.valid === false) throw new InstallError('settings_invalid');
    return settings;
  };

  /**
   * Close a handle and report whether it is now definitely closed. A handle
   * that did NOT close is retained: its file must not be unlinked (the real
   * SAH pool would disassociate and truncate a file that is still open).
   */
  const closeHandle = async (handle) => {
    if (!handle) return true;
    try {
      await handle.close();
      retained.delete(handle);
      return true;
    } catch (e) {
      retained.add(handle);
      return false;
    }
  };

  /** The files of handles that are still open because their close() failed or was skipped. */
  const retainedNames = () => new Set([...retained].map((handle) => handle.name).filter(Boolean));

  /**
   * The ONE place a pool file is deleted. Two rules are enforced centrally, so
   * no caller can bypass them (N2):
   *  - only canonical pool names ever reach the pool (review finding 1);
   *  - a file whose handle is still open is NEVER unlinked, whichever path
   *    asks — the real SAH pool would disassociate and truncate it. Such a
   *    file stays pending until its handle is confirmed closed or a fresh
   *    worker's §3.4 recovery runs.
   * @param {string} name - Pool file name
   * @returns {Promise<boolean>} - Whether the file is now gone
   */
  const unlink = async (name) => {
    if (!isPoolFileName(name)) return false;
    if (retainedNames().has(name)) return false;
    try {
      return await pool.unlink(name);
    } catch (e) {
      return false;
    }
  };

  /** §4.8 common terminal rule: close and delete the staging file, ungate, report. */
  const terminal = async (staging, handle, expectedLocalDb) => {
    const closed = await closeHandle(handle);
    // NEVER unlink after an unsuccessful close.
    if (staging && closed) {
      const deleted = await unlink(staging);
      if (!deleted) {
        // Best effort; §3.4 deletes every non-active file at the next start anyway.
        await bridge.commit({
          operationId: mutation.operationId, expectedLocalDb, patch: { pendingDeletesAdd: [staging] }
        }).catch(() => {});
      }
    } else if (staging) {
      await bridge.commit({
        operationId: mutation.operationId, expectedLocalDb, patch: { pendingDeletesAdd: [staging] }
      }).catch(() => {});
    }
    ungate();
  };

  /** §4.4 steps 2–8 plus §4.5 step 1, in download.js. */
  const streamImport = ({ entry, staging }) => {
    setPhase('downloading');
    return streamDatabase({
      entry,
      staging,
      pool,
      controller: mutation.controller,
      isCancelled: () => mutation.cancelled,
      fetchImpl,
      decompressionStream,
      stallMs,
      now,
      onProgress: (event) => onProgress({ operationId: mutation.operationId, ...event })
    });
  };

  /** §4.5 steps 2–6 on the imported staging file. */
  const verifyStaging = async ({ handle, entry, profile, compatFingerprint }) => {
    setPhase('verifying');
    const stored = await hashStoredBytes(await handle.vfs(), {
      size: entry.dbSize,
      onBatch: async (done, total) => {
        onProgress({ operationId: mutation.operationId, phase: 'verifying', done, total });
        // The worker answers `status` and `cancel` here, between batches.
        await yieldToLoop();
        checkCancelled();
      }
    });
    if (stored !== entry.sha256Db) throw new VerifyError('damaged', 'stored-hash');
    checkPageProduct(await handle.pages(), entry.dbSize);
    checkMeta(await handle.meta(), { profile, compatFingerprint });
    checkObjects(await handle.objects());
  };

  /**
   * The commit point (§4.5 step 7 / §4.7 step 2). Returns 'committed',
   * 'refused' or 'unresolved'; 'unresolved' means BOTH files must be kept.
   */
  const commitPoint = async ({ expectedLocalDb, patch, wanted }) => {
    setPhase('committing');
    gateQueries();
    let answer = null;
    try {
      answer = await bridge.commit({ operationId: mutation.operationId, expectedLocalDb, patch });
    } catch (err) {
      answer = null;
    }
    if (answer && answer.ok) return 'committed';
    if (answer && !answer.ok) return 'refused';
    // The answer is lost: the write may or may not have happened. Reread.
    let current;
    try {
      current = (await readSettings()).localDb ?? null;
    } catch (err) {
      return 'unresolved';
    }
    if (sameRecord(current, wanted)) return 'committed';
    if (sameRecord(current, expectedLocalDb ?? null)) return 'refused';
    return 'unresolved';
  };

  /**
   * §4.5 step 9 / §4.7 step 4: delete a retired file and clear its pending
   * entry. `closed` is false when the handle that held the file did not close;
   * the file is then kept and stays pending.
   */
  const retire = async (file, expectedLocalDb, closed = true) => {
    if (!file) return true;
    if (!closed) return false;
    const deleted = await unlink(file);
    if (!deleted) return false;
    await bridge.commit({
      operationId: mutation.operationId, expectedLocalDb, patch: { pendingDeletesRemove: [file] }
    }).catch(() => {});
    return true;
  };

  /**
   * Install, update or repair (§4.3–§4.6).
   * @param {{pointer:object, profile:string, operationId:string, repair?:boolean}} args - The selected install
   * @returns {Promise<{status:string, record?:object, cleanupPending?:boolean}>}
   */
  const install = async ({ pointer, profile, operationId, repair = false }) => {
    ensureFree(operationId);
    const entry = pointer.profiles?.[profile];
    let staging = null;
    let handle = null;
    let expectedLocalDb = null;
    try {
      if (!entry) throw new InstallError('damaged');
      // An invalid snapshot stops here: nothing is downloaded, opened or deleted.
      const settings = await readSettings();
      expectedLocalDb = settings.localDb ?? null;
      const wanted = {
        profile, release: pointer.release, sha256Db: entry.sha256Db, compatFingerprint: pointer.compatFingerprint
      };
      if (!repair && isAlreadyInstalled(expectedLocalDb, wanted)) return { status: 'already-installed', record: expectedLocalDb };
      checkCancelled();

      const taken = await pool.listFiles();
      staging = stagingName({
        profile, release: pointer.release, random, taken: [...taken, expectedLocalDb?.file].filter(Boolean)
      });
      await streamImport({ entry, staging });
      checkCancelled();

      handle = await pool.open(staging);
      await verifyStaging({ handle, entry, profile, compatFingerprint: pointer.compatFingerprint });
      checkCancelled();

      const record = {
        profile,
        release: pointer.release,
        releaseCommit: pointer.releaseCommit,
        file: staging,
        dbSize: entry.dbSize,
        sha256Db: entry.sha256Db,
        compatFingerprint: pointer.compatFingerprint,
        installedAt: new Date(now()).toISOString()
      };
      const oldFile = expectedLocalDb?.file ?? null;
      const outcome = await commitPoint({
        expectedLocalDb,
        wanted: record,
        patch: { localDb: record, ...(oldFile ? { pendingDeletesAdd: [oldFile] } : {}) }
      });
      if (outcome === 'refused') throw new InstallError('settings');
      if (outcome === 'unresolved') {
        // BOTH files are kept. The staging handle is RETAINED, not abandoned,
        // so nothing later unlinks a file that is still open. The state, not
        // the gate, stops local queries, so a waiting query fails fast.
        retained.add(handle);
        state = 'recovery-unavailable';
        staging = null;
        handle = null;
        ungate();
        return { status: 'recovery-unavailable' };
      }

      // Step 8: switch, close the old handle, ungate.
      const previous = active.handle;
      active = { handle, record };
      handle = null;
      staging = null;
      state = 'ready';
      const closed = await closeHandle(previous);
      ungate();

      setPhase('cleaning');
      const cleaned = await retire(oldFile, record, closed);
      return { status: 'installed', record, cleanupPending: !cleaned };
    } catch (err) {
      await terminal(staging, handle, expectedLocalDb);
      throw err instanceof InstallError || err instanceof VerifyError ? err : new InstallError('damaged');
    } finally {
      mutation = null;
    }
  };

  /**
   * Uninstall (§4.7): commit first, delete afterwards.
   * @param {{operationId:string}} args - The operation
   * @returns {Promise<{status:string, cleanupPending?:boolean}>}
   */
  const uninstall = async ({ operationId }) => {
    ensureFree(operationId);
    try {
      const settings = await readSettings();
      const expectedLocalDb = settings.localDb ?? null;
      if (!expectedLocalDb) return { status: 'uninstalled' };
      const file = expectedLocalDb.file;
      // Step 1: gate queries and CLOSE the active handle before the commit, so
      // the file is never deleted while it is open.
      setPhase('committing');
      gateQueries();
      const previous = active.handle;
      active = { handle: null, record: active.record };
      const closed = await closeHandle(previous);

      const outcome = await commitPoint({
        expectedLocalDb,
        wanted: null,
        patch: { localDb: null, lookupBackend: 'loc-api', pendingDeletesAdd: [file] }
      });
      if (outcome === 'unresolved') {
        state = 'recovery-unavailable';
        return { status: 'recovery-unavailable' };
      }
      if (outcome === 'refused') {
        // The installation stays. If the file cannot be reopened, this tab has
        // no usable database: `repair-needed`, never `ready`.
        const reopened = closed ? await pool.open(file, { readOnly: true }).catch(() => null) : null;
        active = { handle: reopened, record: expectedLocalDb };
        state = reopened ? 'ready' : 'repair-needed';
        throw new InstallError('settings');
      }
      active = { handle: null, record: null };
      state = 'uninstalled';
      ungate();
      setPhase('cleaning');
      const cleaned = await retire(file, null, closed);
      return { status: 'uninstalled', cleanupPending: !cleaned };
    } finally {
      ungate();
      mutation = null;
    }
  };

  /**
   * Startup recovery (§3.4 steps 2–4), a serialized internal operation.
   * @param {{operationId?:string}} [args] - The recovery operation id
   * @returns {Promise<{state:string, record:object|null}>}
   */
  const recover = async ({ operationId = 'recovery' } = {}) => {
    ensureFree(operationId);
    try {
      let settings;
      try {
        // A read failure AND an invalid snapshot both land here (§3.4 step 2).
        settings = await readSettings();
      } catch (err) {
        // Keep ALL pool files; serve no local queries; delete NOTHING.
        state = 'recovery-unavailable';
        active = { handle: active.handle, record: active.record };
        return { state, record: null };
      }
      const record = settings.localDb ?? null;
      if (record) {
        // The handle of THIS attempt, so a validation failure closes the file
        // it just opened instead of the previously active one.
        let opened = null;
        try {
          opened = await pool.open(record.file, { readOnly: true });
          checkAgainstRecord(
            { meta: await opened.meta(), objects: await opened.objects(), pages: await opened.pages() },
            record
          );
          const previous = active.handle;
          active = { handle: opened, record };
          // Ownership handed over; the `finally` below must not close it.
          opened = null;
          state = 'ready';
          await closeHandle(previous);
        } catch (err) {
          // Never promote another file because it exists.
          await closeHandle(active.handle);
          active = { handle: null, record: null };
          state = 'repair-needed';
        } finally {
          // A handle this attempt opened and did NOT hand over is always
          // closed, however the attempt ended (HOUSE_RULES 12).
          await closeHandle(opened);
        }
      } else {
        await closeHandle(active.handle);
        active = { handle: null, record: null };
        state = 'ready';
      }
      await cleanPool(settings, record, operationId);
      return { state, record: state === 'ready' ? record : null };
    } finally {
      mutation = null;
    }
  };

  /**
   * §3.4 step 4: delete every pool file that is not the active file (leftover
   * staging files and `localDbPendingDeletes` entries). Deletion is idempotent;
   * an absent file counts as deleted. The recorded file is never deleted here,
   * not even in `repair-needed`.
   */
  const cleanPool = async (settings, record, operationId) => {
    const activeFile = record?.file ?? null;
    let files = [];
    try {
      files = await pool.listFiles();
    } catch (e) {
      files = [];
    }
    const pending = Array.isArray(settings.localDbPendingDeletes) ? settings.localDbPendingDeletes : [];
    // Never the active file; `unlink()` itself refuses retained files.
    const retainedHere = retainedNames();
    const targets = [...new Set([...files, ...pending])]
      .filter((name) => isPoolFileName(name) && name !== activeFile);
    const removed = [];
    for (const name of targets) {
      if (await unlink(name)) removed.push(name);
    }
    // A retained file keeps its pending entry, so the next worker deletes it.
    const clear = pending.filter((name) => !retainedHere.has(name)
      && (removed.includes(name) || !files.includes(name)));
    if (clear.length > 0) {
      await bridge.commit({
        operationId, expectedLocalDb: record ?? null, patch: { pendingDeletesRemove: clear }
      }).catch(() => {});
    }
  };

  return {
    install,
    uninstall,
    recover,
    /** Refuse a cancel once the install is `committing` (§4.5 step 7, §8). */
    cancel(operationId) {
      if (!mutation || mutation.operationId !== operationId) throw new InstallError('busy');
      if (mutation.phase === 'committing' || mutation.phase === 'cleaning') throw new InstallError('finishing');
      mutation.cancelled = true;
      mutation.controller.abort();
      return true;
    },
    /** The running mutation, or null. */
    operation: () => (mutation ? { operationId: mutation.operationId, phase: mutation.phase } : null),
    /** The §3.4 state: local queries are served only in `ready`. */
    state: () => state,
    record: () => active.record,
    handle: () => active.handle,
    /** Queries wait here while a commit is in flight (§4.5 step 7). */
    whenUngated: () => (gate ? gate.promise : Promise.resolve()),
    isGated: () => gate !== null
  };
};

export default createInstaller;
