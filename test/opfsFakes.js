/**
 * A fake Origin Private File System for SPEC-P5 §12 row 13 (v2.5): exclusive
 * sync access handles shared by every "worker", per-worker globals, worker
 * termination that releases that worker's handles, and an initializer that
 * reproduces the pinned library's failure path.
 *
 * The pinned initializer (`@sqlite.org/sqlite-wasm` 3.53.4, dist/index.mjs)
 * does, in this order:
 *   acquireAccessHandles():  Promise.all(files.map(createSyncAccessHandle))
 *                            — on the FIRST rejection: storeErr, release the
 *                            handles acquired so far, rethrow (fail-fast: a
 *                            slower request can still succeed afterwards);
 *   installOpfsSAHPoolVfs(): .catch(async (e) => { await removeVfs().catch(()=>{}); throw e; })
 *   removeVfs():             try { removeEntry(OPAQUE_DIR, {recursive:true});
 *                                  removeEntry(rootDir, {recursive:true}) }
 *                            catch (e) { log("removeVfs() failed with no recovery strategy") }
 * `createFakeInitializer()` performs exactly that sequence against this fake.
 */

/** The pool's directory names, as the pinned library lays them out. */
export const ROOT_DIR = '.lcsh-pool';
export const OPAQUE_DIR = '.opaque';

const contention = () => new DOMException(
  'Access Handles cannot be created if there is another open one', 'NoModificationAllowedError'
);

/**
 * Create the shared storage. Files live in the pool's opaque directory.
 * @param {string[]} [names] - Slot files present at the start
 * @returns {object}
 */
export const createFakeOpfs = (names = []) => {
  const files = new Map(names.map((name) => [name, { bytes: new Uint8Array([1, 2, 3]), holder: null }]));
  const log = [];
  let rootPresent = true;

  const opfs = {
    files,
    log,
    rootPresent: () => rootPresent,
    /** Which owner holds each file's access handle. */
    holders: () => Object.fromEntries([...files].map(([name, f]) => [name, f.holder])),
    hold(name, owner) {
      files.get(name).holder = owner;
    },
    /** A worker died: the browser releases every handle it held. */
    releaseOwner(owner) {
      for (const f of files.values()) if (f.holder === owner) f.holder = null;
    },
    /**
     * One worker's global scope. Each worker gets its OWN directory-handle
     * class, exactly like a real worker gets its own prototype objects, so a
     * guard installed in one worker does not leak into another.
     * @param {string} owner - The worker's identity
     * @returns {{scope:object, root:()=>object, terminate:()=>void, terminated:()=>boolean}}
     */
    workerScope(owner) {
      let dead = false;
      class FileSystemDirectoryHandle {
        constructor(path) {
          this.path = path;
          this.name = path[path.length - 1] ?? '';
        }

        async getDirectoryHandle(name) {
          return new FileSystemDirectoryHandle([...this.path, name]);
        }

        // eslint-disable-next-line class-methods-use-this
        fileNames() {
          return [...files.keys()];
        }

        removeEntry(name, options) {
          log.push({ owner, op: 'removeEntry', dir: this.path.join('/'), name, options: options ?? null });
          if (options?.recursive) {
            // Deleting the opaque directory or the pool root deletes EVERY file.
            if (name === OPAQUE_DIR || name === ROOT_DIR) {
              files.clear();
              if (name === ROOT_DIR) rootPresent = false;
            }
            return Promise.resolve();
          }
          files.delete(name);
          return Promise.resolve();
        }
      }
      const createSyncAccessHandle = (name) => {
        if (dead) throw new Error('worker terminated');
        const f = files.get(name);
        if (!f) throw new DOMException('not found', 'NotFoundError');
        if (f.holder !== null && f.holder !== owner) throw contention();
        f.holder = owner;
        return { name, close: () => { if (f.holder === owner) f.holder = null; } };
      };
      return {
        scope: { FileSystemDirectoryHandle },
        root: () => new FileSystemDirectoryHandle([ROOT_DIR]),
        createSyncAccessHandle,
        /** What the fake initializer tried to do (e.g. 'removeVfs'). */
        attempts: [],
        terminate: () => {
          dead = true;
          opfs.releaseOwner(owner);
        },
        terminated: () => dead
      };
    }
  };
  return opfs;
};

/**
 * The pinned initializer's sequence, against one worker of the fake OPFS.
 * `delays[name]` makes the request for that file resolve later than the
 * others, which is how a fail-fast `Promise.all` leaves a LATE handle behind.
 * @param {object} worker - Result of `opfs.workerScope(owner)`
 * @param {{delays?:Object<string,number>}} [opts] - Per-file request latency in ms
 * @returns {(options:object)=>Promise<object>}
 */
export const createFakeInitializer = (worker, { delays = {} } = {}) => async (options) => {
  const root = worker.root();
  const opaque = await root.getDirectoryHandle(OPAQUE_DIR);
  const acquired = [];
  let rejected = false;
  const acquireAccessHandles = () => Promise.all(opaque.fileNames().map(async (name) => {
    if (delays[name]) await new Promise((resolve) => { setTimeout(resolve, delays[name]); });
    const ah = worker.createSyncAccessHandle(name);
    // A request that succeeds AFTER the fail-fast rejection keeps its handle:
    // nothing in the abandoned pool will ever release it.
    if (rejected) worker.attempts.push(`late-handle:${name}`);
    else acquired.push(ah);
  }));
  try {
    await acquireAccessHandles();
  } catch (e) {
    rejected = true;
    // storeErr(e); releaseAccessHandles(); throw e — only what is held NOW.
    for (const ah of acquired.splice(0)) ah.close();
    // removeVfs(): the recursive deletion of the pool, errors swallowed.
    worker.attempts.push('removeVfs');
    try {
      await root.removeEntry(OPAQUE_DIR, { recursive: true });
      await root.removeEntry(ROOT_DIR, { recursive: true });
    } catch (removeError) {
      // "removeVfs() failed with no recovery strategy"
    }
    throw e;
  }
  return { options, fileNames: () => opaque.fileNames() };
};
