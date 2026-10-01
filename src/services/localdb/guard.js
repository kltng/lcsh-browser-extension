/**
 * NON-DESTRUCTIVE pool acquisition (SPEC-P5 §3.2 rules 1–2).
 *
 * In the pinned `@sqlite.org/sqlite-wasm` 3.53.4, ANY failure of
 * `installOpfsSAHPoolVfs()` after the pool directory is opened runs
 * `removeVfs()`, which RECURSIVELY deletes the pool directory — the installed
 * database (dist/index.mjs ~16951 → ~16449). Contention is such a failure:
 * live, a replacement worker failed with "Access Handles cannot be created if
 * there is another open one" and the cleanup then tried to delete the pool; it
 * failed only because the old worker still held the handles.
 *
 * Rule 1: before the pool is acquired, this worker installs — for its whole
 * life — a guard on `FileSystemDirectoryHandle.prototype.removeEntry` that
 * REFUSES every call with `{recursive: true}` and forwards every other call
 * unchanged (same receiver, same arguments). The library's cleanup swallows
 * the refusal, so the init failure still propagates and NOTHING is deleted.
 * In the pinned package the only recursive removals are `removeVfs()` and the
 * `opfs`-VFS `rmfr` helpers, which this extension does not use; this
 * extension's own code never removes a directory.
 *
 * Rule 2 is enforced by the CLIENT: a contention failure is retried only in a
 * FRESH guarded worker (the pinned initializer caches its rejection, and its
 * fail-fast `Promise.all` can leave a late handle in the abandoned pool).
 */

/** Marks the installed guard function so it is never wrapped twice. */
const GUARD_MARK = Symbol.for('lcsh.localdb.removeEntryGuard');

/** The pool name (SPEC-P5 §3.2). */
export const POOL_NAME = 'lcsh-pool';

/** The error a refused recursive removal throws. Local text only. */
export class RecursiveRemovalRefused extends Error {
  constructor() {
    super('A recursive removal in the local database storage was refused.');
    this.name = 'RecursiveRemovalRefused';
  }
}

/** An acquisition failure with a stable kind for the page. */
export class AcquireError extends Error {
  /**
   * @param {'db_contention'|'db_guard_failed'|'db_init_failed'} kind - Failure kind
   * @param {string} message - Local text
   */
  constructor(kind, message) {
    super(message);
    this.name = 'AcquireError';
    this.kind = kind;
  }
}

const isRecursive = (options) => options !== null && typeof options === 'object' && Boolean(options.recursive);

/**
 * Whether the guard is installed on this scope's directory handles.
 * @param {object} [scope] - The worker global (tests pass a fake)
 * @returns {boolean}
 */
export const isGuardInstalled = (scope = globalThis) => {
  const fn = scope.FileSystemDirectoryHandle?.prototype?.removeEntry;
  return typeof fn === 'function' && fn[GUARD_MARK] === true;
};

/**
 * Install and VERIFY the recursive-removal guard. It throws when it cannot be
 * installed; the caller must then abort initialization.
 * @param {object} [scope] - The worker global (tests pass a fake)
 * @returns {void}
 */
export const installRemoveEntryGuard = (scope = globalThis) => {
  const proto = scope.FileSystemDirectoryHandle?.prototype;
  if (!proto || typeof proto.removeEntry !== 'function') {
    throw new AcquireError('db_guard_failed', 'The local database storage cannot be protected in this browser.');
  }
  if (isGuardInstalled(scope)) return;
  const original = proto.removeEntry;
  // A plain (non-async) function: a permitted call returns exactly what the
  // original returns, with the original receiver and every argument.
  const guarded = function removeEntry(...args) {
    if (isRecursive(args[1])) throw new RecursiveRemovalRefused();
    return original.apply(this, args);
  };
  Object.defineProperty(guarded, GUARD_MARK, { value: true });
  try {
    Object.defineProperty(proto, 'removeEntry', {
      value: guarded, writable: true, configurable: true, enumerable: false
    });
  } catch (err) {
    throw new AcquireError('db_guard_failed', 'The local database storage cannot be protected in this browser.');
  }
  // Verify, never assume: the property must now BE the guard.
  if (!isGuardInstalled(scope) || proto.removeEntry !== guarded) {
    throw new AcquireError('db_guard_failed', 'The local database storage cannot be protected in this browser.');
  }
};

/**
 * Whether an acquisition error is pool CONTENTION — another worker still holds
 * the access handles. Only this kind is ever retried (§3.2 rule 2).
 * @param {any} err - The initializer's rejection
 * @returns {boolean}
 */
export const isContention = (err) => Boolean(err) && err.name === 'NoModificationAllowedError';

/**
 * Acquire the pool non-destructively: guard first (abort if it fails), then
 * the pinned initializer with `clearOnInit: false`. Exactly ONE attempt; a
 * retry needs a fresh worker.
 * @param {{scope?:object, installSahPool:(options:object)=>Promise<object>}} deps - Worker global and initializer
 * @returns {Promise<object>} - The pool utility
 */
export const acquirePool = async ({ scope = globalThis, installSahPool }) => {
  installRemoveEntryGuard(scope);
  try {
    return await installSahPool({ name: POOL_NAME, clearOnInit: false });
  } catch (err) {
    if (isContention(err)) {
      throw new AcquireError('db_contention', 'The local database is still held by a previous worker.');
    }
    throw new AcquireError('db_init_failed', 'The local database storage could not be opened.');
  }
};

export default acquirePool;
