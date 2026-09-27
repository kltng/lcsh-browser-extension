/**
 * The database worker (SPEC-P5 §3.2). It owns the SQLite wasm module, the
 * SAH-pool VFS, the active database handle and the install protocol; the page
 * owns the Web Lock and the settings. Everything it needs from
 * `chrome.storage` goes through the §3.3 bridge.
 *
 * It never runs raw SQL from a message: `query` names one of the SCHEMA_QUERIES
 * queries and binds its parameters (§5 query contract). The internal
 * `db_meta` / `sqlite_master` / `PRAGMA` reads and the §4.5 step 3 file read
 * are not reachable through the `query` RPC.
 *
 * The message dispatcher is `createWorkerDispatcher()`, which takes its pool
 * and installer as injected dependencies so the composition itself is tested
 * in Node (review finding 12). Only the bootstrap at the bottom is
 * Chrome-only.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { buildQuery, QUERY_NAMES } from './sql';
import { createInstaller, InstallError } from './install';
import { createFilePointerVfs, VerifyError } from './verify';

export const POOL_NAME = 'lcsh-pool';
/** A lost bridge answer is an UNRESOLVED commit (§4.5 step 7), not a silent hang. */
export const BRIDGE_TIMEOUT_MS = 30000;

/** The four fields of an installation identity (§6.5); ALL of them are compared. */
export const IDENTITY_FIELDS = ['profile', 'release', 'releaseCommit', 'file'];

const errorOf = (err) => {
  if (err instanceof InstallError || err instanceof VerifyError) return { kind: err.kind, message: err.message };
  if (err?.kind) return { kind: err.kind, message: err.message || 'The local database could not answer.' };
  return { kind: 'local_db', message: 'The local database could not answer.' };
};

const kinded = (kind, message) => {
  const err = new Error(message);
  err.kind = kind;
  return err;
};

/**
 * Create the message dispatcher.
 * @param {{post:Function, createPool:()=>Promise<object>, createInstallerImpl?:Function,
 *   bridgeTimeoutMs?:number, setTimeoutImpl?:Function, clearTimeoutImpl?:Function,
 *   yieldToLoop?:Function}} deps - Injected environment
 * @returns {{handleMessage:(message:object)=>void}}
 */
export const createWorkerDispatcher = ({
  post,
  createPool,
  createInstallerImpl = createInstaller,
  bridgeTimeoutMs = BRIDGE_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0))
}) => {
  let pool = null;
  let installer = null;
  let ready = null;
  let bridgeSeq = 0;
  const bridgeWaiters = new Map();
  const dropped = new Set();

  // Review finding 3: a worker instance belongs to EXACTLY ONE client
  // generation, and each bridge request carries the operation the caller
  // passed. A `status` or `query` RPC can no longer overwrite the identity a
  // running install will commit under.
  let workerGeneration = null;

  /** One bridge round trip to the page (§3.3), for one named operation. */
  const askBridge = (operationId, payload) => new Promise((resolve, reject) => {
    bridgeSeq += 1;
    const bridgeId = `b${bridgeSeq}`;
    const timer = setTimeoutImpl(() => {
      bridgeWaiters.delete(bridgeId);
      reject(new InstallError('settings'));
    }, bridgeTimeoutMs);
    bridgeWaiters.set(bridgeId, {
      resolve: (answer) => {
        clearTimeoutImpl(timer);
        resolve(answer);
      }
    });
    post({ type: 'bridge', bridgeId, workerGeneration, operationId: operationId ?? null, ...payload });
  });

  /** The bridge as install.js expects it: the operation is always explicit. */
  const bridge = {
    read: async ({ operationId } = {}) => {
      const answer = await askBridge(operationId, { action: 'read' });
      if (!answer.ok) throw new InstallError('settings');
      return answer.current;
    },
    commit: (args) => askBridge(args.operationId, {
      action: 'commit', expectedLocalDb: args.expectedLocalDb ?? null, patch: args.patch
    })
  };

  const ensureReady = async () => {
    if (!ready) {
      ready = (async () => {
        pool = await createPool();
        installer = createInstallerImpl({
          pool,
          bridge,
          onProgress: (event) => post({ type: 'progress', ...event }),
          // Review finding 9: the mutation PHASE and the query GATE are
          // different events. A gate change must never look like a phase that
          // re-enables Cancel.
          onPhase: (event) => post({ type: 'phase', ...event }),
          onGate: (gated) => post({ type: 'gate', gated }),
          yieldToLoop
        });
      })().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  };

  /** Run one NAMED query against the ACTIVE handle, under the §6.5 identity fence. */
  const runQuery = async ({ id, name, identity, ...args }) => {
    if (!QUERY_NAMES.includes(name)) throw new InstallError('damaged');
    // New queries wait while a commit is in flight; running ones finish.
    await installer.whenUngated();
    // Review finding 6: a query cancelled while it waited behind the gate must
    // NOT run when the gate opens (§6.4 drops queued local work).
    if (dropped.has(id)) throw kinded('cancelled', 'Cancelled.');
    const record = installer.record();
    const handle = installer.handle();
    if (installer.state() !== 'ready' || !handle || !record) {
      throw kinded('db_worker_failed', 'The local database is not available.');
    }
    if (identity && IDENTITY_FIELDS.some((field) => identity[field] !== record[field])) {
      throw kinded('db_generation_changed', 'The local database changed.');
    }
    const { sql, params } = buildQuery(name, args);
    if (dropped.has(id)) throw kinded('cancelled', 'Cancelled.');
    return handle.db.exec({ sql, bind: params, rowMode: 'object', returnValue: 'resultRows' })
      .map((row) => ({ ...row }));
  };

  const OPS = {
    status: async () => ({ state: installer.state(), record: installer.record(), operation: installer.operation() }),
    query: (args) => runQuery(args),
    recover: (args) => installer.recover(args),
    install: (args) => installer.install(args),
    uninstall: (args) => installer.uninstall(args),
    cancel: (args) => installer.cancel(args.operationId)
  };

  const handleRpc = async (message) => {
    const { id, op, args = {} } = message;
    if (dropped.has(id)) return;
    try {
      await ensureReady();
      const result = await OPS[op](op === 'query' ? { id, ...args } : args);
      if (!dropped.has(id)) post({ type: 'rpc-result', id, ok: true, result });
      if (op !== 'query') post({ type: 'state', state: installer.state(), record: installer.record() });
    } catch (err) {
      if (!dropped.has(id)) post({ type: 'rpc-result', id, ok: false, error: errorOf(err) });
      if (installer && op !== 'query') post({ type: 'state', state: installer.state(), record: installer.record() });
    } finally {
      dropped.delete(id);
    }
  };

  return {
    /** The generation this worker instance is bound to (tests). */
    generation: () => workerGeneration,
    /**
     * Handle one message from the page.
     * @param {object} message - The message data
     */
    handleMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'bridge-result') {
        const waiter = bridgeWaiters.get(message.bridgeId);
        if (!waiter) return;
        bridgeWaiters.delete(message.bridgeId);
        const { type, bridgeId, ...answer } = message;
        waiter.resolve(answer);
        return;
      }
      if (message.type === 'drop') {
        dropped.add(message.id);
        return;
      }
      if (message.type !== 'rpc') return;
      // A worker serves ONE generation for its whole life; the first RPC binds
      // it, and a message for any other generation is refused.
      if (workerGeneration === null) workerGeneration = message.workerGeneration ?? null;
      if ((message.workerGeneration ?? null) !== workerGeneration) {
        post({ type: 'rpc-result', id: message.id, ok: false, error: { kind: 'db_generation_changed', message: 'The local database changed.' } });
        return;
      }
      if (!OPS[message.op]) {
        post({ type: 'rpc-result', id: message.id, ok: false, error: { kind: 'local_db', message: 'Unknown operation' } });
        return;
      }
      handleRpc(message);
    }
  };
};

const metaOf = (db) => Object.fromEntries(
  db.exec({ sql: 'SELECT key, value FROM db_meta', rowMode: 'object', returnValue: 'resultRows' })
    .map((row) => [row.key, row.value])
);

const objectsOf = (db) => db.exec({
  sql: "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%'",
  rowMode: 'object',
  returnValue: 'resultRows'
}).map((row) => ({ name: row.name, type: row.type }));

const pagesOf = (db) => ({
  pageSize: db.selectValue('PRAGMA page_size'),
  pageCount: db.selectValue('PRAGMA page_count')
});

/**
 * The SAH-pool adapter install.js uses. Every database is opened READ-ONLY:
 * the extension never writes a database's contents, and a missing recorded
 * file must FAIL rather than be created (review finding 5).
 * @param {object} sqlite3 - The initialized sqlite3 module
 * @param {object} poolUtil - The installed SAH pool
 * @returns {object}
 */
export const createPoolAdapter = (sqlite3, poolUtil) => ({
  listFiles: async () => poolUtil.getFileNames(),
  importDb: async (name, pull) => poolUtil.importDb(name, pull),
  unlink: async (name) => {
    // Idempotent: a file that is already gone counts as deleted.
    await poolUtil.unlink(name);
    return true;
  },
  open: async (name) => {
    // 'r' = read-only, never create. An absent file throws here.
    const db = new poolUtil.OpfsSAHPoolDb(name, 'r');
    let vfs = null;
    return {
      name,
      db,
      meta: async () => metaOf(db),
      objects: async () => objectsOf(db),
      pages: async () => pagesOf(db),
      vfs: async () => {
        if (!vfs) vfs = createFilePointerVfs(sqlite3, db.pointer);
        return vfs;
      },
      close: async () => {
        vfs?.dispose();
        vfs = null;
        db.close();
      }
    };
  }
});

/** Build the real pool: wasm module, SAH VFS, adapter. */
export const createRealPool = async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  let poolUtil;
  try {
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
  } catch (err) {
    // A busy pool is CONTENTION, never corruption.
    throw kinded('db_busy', 'The local database is in use. Close the other tab and try again.');
  }
  return createPoolAdapter(sqlite3, poolUtil);
};

// Bootstrap: only inside a real Worker.
const scope = typeof self === 'undefined' ? null : self;
if (scope && typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function') {
  const dispatcher = createWorkerDispatcher({
    post: (message) => scope.postMessage(message),
    createPool: createRealPool
  });
  scope.addEventListener('message', (event) => dispatcher.handleMessage(event.data));
}
