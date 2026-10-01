import { describe, it, expect, vi } from 'vitest';
import { createWorkerDispatcher, createPoolAdapter, IDENTITY_FIELDS } from '../worker';
import { sha256Hex } from '../sha256';
import { createFakePool, createFakeBridge, bodyStream, pointerFor } from '../../../../test/localdbFakes';

const PROFILE = 'core';
const GENERATION = 7;

const dbBytes = (n = 4096 * 2) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31) % 251;
  return bytes;
};

const describeDb = (bytes, over = {}) => ({
  meta: {
    profile: PROFILE, schema_version: '2', normalize_version: 'NORMALIZE_V1', lh_format: 'LH1', compat_fingerprint: 'FP'
  },
  objects: [
    { name: 'db_meta', type: 'table' }, { name: 'auth', type: 'table' }, { name: 'alt_label', type: 'table' },
    { name: 'hierarchy', type: 'table' }, { name: 'auth_fts', type: 'table' }, { name: 'alt_label_fts', type: 'table' }
  ],
  pages: { pageSize: 4096, pageCount: bytes.length / 4096 },
  ...over
});

// An OLDER release than the pointer's, so an install is a real update.
const RECORD = {
  profile: PROFILE, release: '2026.09.26.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db',
  dbSize: 8192, sha256Db: sha256Hex(dbBytes()), compatFingerprint: 'FP', installedAt: '2026-09-27T00:00:00.000Z'
};

/**
 * The REAL dispatcher over the REAL installer, with only the pool, the page
 * and the network faked (review finding 12: worker composition is exercised).
 */
const setup = ({ settings = {}, poolOpts = {}, rows = [], bytes = dbBytes(), describe: over } = {}) => {
  const sent = [];
  const pool = createFakePool({ describe: (name, imported) => describeDb(imported, over ? over(imported) : {}), ...poolOpts });
  const bridge = createFakeBridge({ settings });
  const pointer = pointerFor({ profile: PROFILE, bytes, sha256Hex });
  // Every SQL call that reaches a handle, so a test can assert there were none.
  const execCalls = [];
  let acquiredResolve;
  const acquired = new Promise((resolve) => { acquiredResolve = resolve; });
  const dispatcher = createWorkerDispatcher({
    post: (message) => {
      sent.push(message);
      if (message.type === 'rpc-result' && message.id === 'acquire-0') acquiredResolve(message);
    },
    createPool: async () => ({
      ...pool,
      open: async (name, opts) => {
        const handle = await pool.open(name, opts);
        // A real handle also answers SQL; the fake returns the given rows.
        handle.db = {
          exec: vi.fn((args) => {
            execCalls.push({ name, sql: args?.sql });
            return rows.map((r) => ({ ...r }));
          })
        };
        return handle;
      }
    }),
    createInstallerImpl: undefined,
    bridgeTimeoutMs: 1000,
    yieldToMacrotask: () => new Promise((resolve) => { setTimeout(resolve, 0); })
  });
  // §3.2 rule 3: like the real client, the page acquires FIRST and sends
  // recovery, queries and mutations only after the acquisition succeeded.
  dispatcher.handleMessage({ type: 'rpc', id: 'acquire-0', op: 'acquire', args: {}, workerGeneration: GENERATION });
  let chain = acquired;

  // The page half: answer every bridge request the worker sends.
  const pump = async (ticks = 30) => {
    for (let i = 0; i < ticks; i++) {
      const request = sent.find((m) => m.type === 'bridge' && !m.__answered);
      if (request) {
        request.__answered = true;
        const answer = request.action === 'read'
          ? { ok: true, current: await bridge.read() }
          : await bridge.commit({ operationId: request.operationId, expectedLocalDb: request.expectedLocalDb, patch: request.patch });
        dispatcher.handleMessage({ type: 'bridge-result', bridgeId: request.bridgeId, ...answer });
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  // Messages keep their order, and none is sent before the acquisition answered.
  const rpc = (id, op, args = {}, generation = GENERATION) => {
    chain = chain.then(() => dispatcher.handleMessage({ type: 'rpc', id, op, args, workerGeneration: generation }));
    return chain;
  };
  const resultOf = (id) => sent.find((m) => m.type === 'rpc-result' && m.id === id);
  const bridgesOf = () => sent.filter((m) => m.type === 'bridge');

  return {
    dispatcher, pool, bridge, pointer, sent, pump, rpc, resultOf, bridgesOf, execCalls,
    install: (id = 1, operationId = 'op1') => {
      // The fake body is the gzip of the pointer's bytes.
      globalThis.fetch = vi.fn(async () => ({ status: 200, body: bodyStream(pointer.gz) }));
      rpc(id, 'install', { pointer, profile: PROFILE, operationId });
    }
  };
};

/** Everything an existing installation must still be after a failed attempt. */
const snapshotOf = (env) => ({
  record: JSON.parse(JSON.stringify(env.bridge.current.localDb)),
  pending: [...env.bridge.current.localDbPendingDeletes],
  files: [...env.pool.files.entries()].map(([name, entry]) => [name, sha256Hex(entry.bytes)]).sort()
});

describe('[P5 fix3] a concurrent RPC never steals the running mutation\'s bridge identity', () => {
  it('a status and a query during an install leave every bridge request on the install operation', async () => {
    const env = setup();
    env.install(1, 'op-install');
    // Interleave exactly the RPCs that used to overwrite `bridgeContext`.
    env.rpc(2, 'status');
    env.rpc(3, 'query', { name: 'Q1', text: 'cats', authorities: ['lcsh'] });
    await env.pump();

    const bridges = env.bridgesOf();
    expect(bridges.length).toBeGreaterThan(0);
    for (const request of bridges) {
      expect(request.operationId, JSON.stringify(request)).toBe('op-install');
      expect(request.workerGeneration).toBe(GENERATION);
    }
    // The install still commits under its own identity.
    expect(env.resultOf(1)).toMatchObject({ ok: true });
    expect(env.bridge.current.localDb).toMatchObject({ profile: PROFILE });
    expect(env.resultOf(2)).toMatchObject({ ok: true });
  });

  it('a status RPC is answered while a mutation runs, without disturbing it', async () => {
    const env = setup();
    env.install(1, 'op-install');
    env.rpc(2, 'status');
    await env.pump();
    expect(env.resultOf(2).result.operation === null || env.resultOf(2).result.operation.operationId === 'op-install').toBe(true);
    expect(env.resultOf(1)).toMatchObject({ ok: true });
  });

  it('a message for another worker generation is refused, never served', async () => {
    const env = setup();
    env.rpc(1, 'status');
    await env.pump(3);
    env.rpc(2, 'status', {}, GENERATION + 1);
    await env.pump(3);
    expect(env.resultOf(2)).toMatchObject({ ok: false, error: { kind: 'db_generation_changed' } });
  });
});

describe('[P5 fix6] a query cancelled behind the commit gate never runs', () => {
  // N4(d): the gate is really CLOSED, the query really WAITS behind it, it is
  // cancelled while it waits, the gate is then released, and no SQL runs.
  it('a query cancelled while the commit gate is closed makes ZERO SQL calls', async () => {
    const env = setup({ settings: { localDb: RECORD }, rows: [{ id: 1, uri: 'sh1' }] });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    expect(env.resultOf(1).result.state).toBe('ready');
    // Recovery reads db_meta/sqlite_master through the handle object, not SQL.
    expect(env.execCalls).toEqual([]);

    // Answer the install's `read`, but HOLD its `commit` so the gate stays shut.
    let heldCommit = null;
    const pumpHoldingCommit = async (ticks = 20) => {
      for (let i = 0; i < ticks; i++) {
        const request = env.sent.find((m) => m.type === 'bridge' && !m.__answered);
        if (request && request.action === 'read') {
          request.__answered = true;
          env.dispatcher.handleMessage({
            type: 'bridge-result', bridgeId: request.bridgeId, ok: true, current: await env.bridge.read()
          });
        } else if (request && request.action === 'commit') {
          request.__answered = true;
          heldCommit = request;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    env.install(2, 'op-install');
    await pumpHoldingCommit();

    // The gate is closed: the worker said so, and the commit is still in flight.
    expect(heldCommit, 'the commit must be in flight').toBeTruthy();
    expect(env.sent.filter((m) => m.type === 'gate').at(-1)).toEqual({ type: 'gate', gated: true });

    // A query issued now WAITS behind the gate rather than running.
    env.rpc(3, 'query', { name: 'Q1', text: 'cats', authorities: ['lcsh'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(env.resultOf(3)).toBeUndefined();
    expect(env.execCalls, 'a gated query must not have run yet').toEqual([]);

    // It is cancelled while it waits; then the gate is released.
    env.dispatcher.handleMessage({ type: 'drop', id: 3 });
    const answer = await env.bridge.commit({
      operationId: heldCommit.operationId, expectedLocalDb: heldCommit.expectedLocalDb, patch: heldCommit.patch
    });
    env.dispatcher.handleMessage({ type: 'bridge-result', bridgeId: heldCommit.bridgeId, ...answer });
    await env.pump(40);

    // The install finished and the gate re-opened...
    expect(env.resultOf(2)).toMatchObject({ ok: true });
    expect(env.sent.filter((m) => m.type === 'gate').at(-1)).toEqual({ type: 'gate', gated: false });
    // ...but the cancelled query neither answered nor executed any SQL.
    expect(env.resultOf(3)).toBeUndefined();
    expect(env.execCalls).toEqual([]);
  });

  it('an ungated query DOES reach the SQL, so the assertion above is meaningful', async () => {
    const env = setup({ settings: { localDb: RECORD }, rows: [{ id: 1, uri: 'sh1' }] });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    env.rpc(2, 'query', { name: 'Q1', text: 'cats', authorities: ['lcsh'] });
    await env.pump(5);
    expect(env.resultOf(2)).toMatchObject({ ok: true });
    expect(env.execCalls).toHaveLength(1);
    expect(env.execCalls[0].sql).toContain('FROM auth');
  });

  it('a query that is not cancelled is answered from the active handle', async () => {
    const env = setup({ settings: { localDb: RECORD }, rows: [{ id: 1, uri: 'sh1' }] });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    env.rpc(2, 'query', {
      name: 'Q1', text: 'cats', authorities: ['lcsh'], identity: { ...RECORD }
    });
    await env.pump(5);
    expect(env.resultOf(2)).toMatchObject({ ok: true, result: [{ id: 1, uri: 'sh1' }] });
  });
});

describe('[P5 fix8] the worker compares ALL FOUR identity fields', () => {
  const fenced = async (patch) => {
    const env = setup({ settings: { localDb: RECORD }, rows: [{ id: 1 }] });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    env.rpc(2, 'query', {
      name: 'Q1', text: 'cats', authorities: ['lcsh'],
      identity: { profile: RECORD.profile, release: RECORD.release, releaseCommit: RECORD.releaseCommit, file: RECORD.file, ...patch }
    });
    await env.pump(5);
    return env.resultOf(2);
  };

  it('a mismatch in any field fails the query with db_generation_changed', async () => {
    expect(IDENTITY_FIELDS).toEqual(['profile', 'release', 'releaseCommit', 'file']);
    for (const field of IDENTITY_FIELDS) {
      const answer = await fenced({ [field]: 'other' });
      expect(answer, field).toMatchObject({ ok: false, error: { kind: 'db_generation_changed' } });
    }
  });

  it('the complete matching identity is served', async () => {
    expect(await fenced({})).toMatchObject({ ok: true });
  });
});

describe('[P5 fix1] malformed settings stop the worker before it deletes anything', () => {
  it('an incomplete record is unreadable settings, not a damaged database', async () => {
    const env = setup({ settings: { localDb: { profile: 'core' } } });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.pool.put('/stage-leftover.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    expect(env.resultOf(1).result.state).toBe('recovery-unavailable');
    expect([...env.pool.files.keys()].sort()).toEqual(['/db-1.db', '/stage-leftover.db']);
    expect(env.pool.unlink).not.toHaveBeenCalled();
  });

  it('an install refuses to run on an unreadable snapshot and downloads nothing', async () => {
    const env = setup({ settings: { localDb: { file: '/db-1.db' } } });
    env.install(1, 'op-install');
    await env.pump();
    expect(env.resultOf(1)).toMatchObject({ ok: false, error: { kind: 'settings_invalid' } });
    expect(env.pool.importDb).not.toHaveBeenCalled();
    expect(env.pool.unlink).not.toHaveBeenCalled();
  });
});

describe('[P5 fix2] the worker keeps files whose handle did not close', () => {
  it('a failed close of the retired file leaves it on disk and pending', async () => {
    const env = setup({ settings: { localDb: RECORD } });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.pool.failClose.add('/db-1.db');
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();

    env.install(2, 'op-install');
    await env.pump(60);
    const answer = env.resultOf(2);
    expect(answer).toMatchObject({ ok: true });
    expect(answer.result.cleanupPending).toBe(true);
    // The file that would not close was NOT unlinked.
    expect(env.pool.files.has('/db-1.db')).toBe(true);
    expect(env.bridge.current.localDbPendingDeletes).toEqual(['/db-1.db']);
  });
});

describe('[P5 fix12] an UNCERTAIN commit through the real worker keeps both files', () => {
  it('a commit whose answer never arrives and whose reread fails stops local queries', async () => {
    const env = setup({ settings: { localDb: RECORD } });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    env.rpc(1, 'recover', { operationId: 'internal-recovery' });
    await env.pump();
    expect(env.resultOf(1).result.state).toBe('ready');

    // The page answers the install's READ, then never answers again.
    let answered = 0;
    const pumpOnce = async () => {
      for (let i = 0; i < 40; i++) {
        const request = env.sent.find((m) => m.type === 'bridge' && !m.__answered);
        if (request && answered === 0) {
          request.__answered = true;
          answered += 1;
          env.dispatcher.handleMessage({
            type: 'bridge-result', bridgeId: request.bridgeId, ok: true, current: await env.bridge.read()
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    env.install(2, 'op-install');
    await pumpOnce();
    // The bridge timeout turns the lost commit answer into an unresolved
    // commit, and the reread that follows times out as well.
    for (let i = 0; i < 60 && !env.resultOf(2); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const answer = env.resultOf(2);
    expect(answer).toMatchObject({ ok: true, result: { status: 'recovery-unavailable' } });
    // BOTH files are kept, and this tab serves no local queries any more.
    expect([...env.pool.files.keys()].length).toBe(2);
    expect(env.pool.files.has('/db-1.db')).toBe(true);
    env.rpc(3, 'query', { name: 'Q1', text: 'cats', authorities: ['lcsh'] });
    await env.pump(5);
    expect(env.resultOf(3)).toMatchObject({ ok: false, error: { kind: 'db_worker_failed' } });
  }, 15000);
});

/**
 * N4(a)(b): the verification steps that only the STORED bytes can catch, run
 * through the real dispatcher with an installation already in place.
 */
describe('[P5 fix-N4] verification failures with an existing installation', () => {
  const withInstallation = (poolOpts = {}, over) => {
    const env = setup({ settings: { localDb: RECORD }, poolOpts, describe: over });
    env.pool.put('/db-1.db', dbBytes(), describeDb(dbBytes()));
    return env;
  };

  const failsSafely = async (env, id = 2) => {
    const before = snapshotOf(env);
    env.install(id, 'op-install');
    await env.pump(60);
    const answer = env.resultOf(id);
    expect(answer, 'the install must be REFUSED').toMatchObject({ ok: false });
    // Zero activation writes.
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
    // The old record and the old bytes are untouched.
    const after = snapshotOf(env);
    expect(after.record).toEqual(before.record);
    expect(after.pending).toEqual(before.pending);
    expect(env.pool.files.has('/db-1.db')).toBe(true);
    expect(sha256Hex(env.pool.files.get('/db-1.db').bytes)).toBe(sha256Hex(dbBytes()));
    // No staging file survives.
    expect([...env.pool.files.keys()]).toEqual(['/db-1.db']);
    return answer;
  };

  // The one case only the §4.5 step 3 digest can catch: the stream hashes pass,
  // the length is exactly right, and the stored bytes still differ.
  it('SAME-LENGTH stored corruption is rejected and changes nothing', async () => {
    const env = withInstallation({ corruptStored: true });
    const answer = await failsSafely(env);
    expect(answer.error.kind).toBe('damaged');
    // It really did get past the stream checks and reach the stored-byte read.
    expect(env.pool.importDb).toHaveBeenCalled();
  });

  it('a wrong page-count product is rejected and changes nothing', async () => {
    const env = withInstallation({}, (bytes) => ({ pages: { pageSize: 4096, pageCount: (bytes.length / 4096) + 1 } }));
    await failsSafely(env);
  });

  it('db_meta of the wrong profile is rejected and changes nothing', async () => {
    const env = withInstallation({}, () => ({
      meta: {
        profile: 'full', schema_version: '2', normalize_version: 'NORMALIZE_V1', lh_format: 'LH1', compat_fingerprint: 'FP'
      }
    }));
    await failsSafely(env);
  });

  it('a missing application object is rejected and changes nothing', async () => {
    const env = withInstallation({}, () => ({ objects: [{ name: 'auth', type: 'table' }] }));
    await failsSafely(env);
  });

  it('an unexpected object in sqlite_master is rejected and changes nothing', async () => {
    const env = withInstallation({}, (bytes) => ({
      objects: [...describeDb(bytes).objects, { name: 'secrets', type: 'table' }]
    }));
    await failsSafely(env);
  });
});

describe('[P5 fix5] every database is opened read-only', () => {
  it('createPoolAdapter passes the read-only flag and never creates a file', async () => {
    const opened = [];
    class FakeDb {
      constructor(name, flags) {
        opened.push([name, flags]);
        this.pointer = 1;
      }

      exec() { return []; }

      selectValue() { return 4096; }

      close() {}
    }
    const poolUtil = {
      getFileNames: () => [],
      importDb: vi.fn(),
      unlink: vi.fn(async () => {}),
      OpfsSAHPoolDb: FakeDb
    };
    const adapter = createPoolAdapter({}, poolUtil);
    await adapter.open('/db-1.db');
    expect(opened).toEqual([['/db-1.db', 'r']]);
  });
});

/**
 * N4(c): the PRODUCTION adapter's deletion path. The fake-pool lifecycle tests
 * cannot see an adapter that deletes the wrong file, because they never call
 * this method.
 */
describe('[P5 fix-N4] the production pool adapter deletes exactly one named file', () => {
  const poolUtilOf = () => {
    const files = new Set(['/db-1.db', '/db-2.db', '/stage-x.db']);
    return {
      files,
      getFileNames: vi.fn(() => [...files]),
      importDb: vi.fn(),
      unlink: vi.fn(async (name) => {
        files.delete(name);
      }),
      OpfsSAHPoolDb: class {}
    };
  };

  it('forwards the name unchanged and leaves every unrelated file alone', async () => {
    const poolUtil = poolUtilOf();
    const adapter = createPoolAdapter({}, poolUtil);
    expect(await adapter.unlink('/stage-x.db')).toBe(true);
    expect(poolUtil.unlink).toHaveBeenCalledTimes(1);
    expect(poolUtil.unlink).toHaveBeenCalledWith('/stage-x.db');
    expect([...poolUtil.files].sort()).toEqual(['/db-1.db', '/db-2.db']);
    expect(await adapter.listFiles()).toEqual(['/db-1.db', '/db-2.db']);
  });

  it('is idempotent: an absent file counts as deleted, and nothing else is touched', async () => {
    const poolUtil = poolUtilOf();
    const adapter = createPoolAdapter({}, poolUtil);
    expect(await adapter.unlink('/never-existed.db')).toBe(true);
    expect(poolUtil.unlink).toHaveBeenCalledWith('/never-existed.db');
    expect([...poolUtil.files].sort()).toEqual(['/db-1.db', '/db-2.db', '/stage-x.db']);
  });

  it('a pool failure is reported, not swallowed as success', async () => {
    const poolUtil = poolUtilOf();
    poolUtil.unlink = vi.fn(async () => { throw new Error('locked'); });
    const adapter = createPoolAdapter({}, poolUtil);
    await expect(adapter.unlink('/stage-x.db')).rejects.toThrow();
    expect([...poolUtil.files].sort()).toEqual(['/db-1.db', '/db-2.db', '/stage-x.db']);
  });

  it('importDb forwards the staging name and the pull function untouched', async () => {
    const poolUtil = poolUtilOf();
    const adapter = createPoolAdapter({}, poolUtil);
    const pull = async () => undefined;
    await adapter.importDb('/stage-y.db', pull);
    expect(poolUtil.importDb).toHaveBeenCalledWith('/stage-y.db', pull);
  });
});
