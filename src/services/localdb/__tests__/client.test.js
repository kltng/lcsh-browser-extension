import { describe, it, expect, vi } from 'vitest';
import { createLocalDbClient, LocalDbError, OWNER_LOCK, RECOVERY_OPERATION } from '../client';
import { commitLocalDb, readLocalDbSettings, setLookupBackend, getSettings, localDbUpdateCheck } from '../../settings';
import { fakes, yieldTicks, gate } from '../../../../test/setup';

const RECORD = {
  profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db',
  dbSize: 4096, sha256Db: 'b'.repeat(64), compatFingerprint: 'FP', installedAt: '2026-09-27T00:00:00.000Z'
};

/** A fake Worker: it records what the page sent and lets a test answer. */
const fakeWorker = () => {
  const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
  const sent = [];
  const worker = {
    sent,
    terminated: false,
    addEventListener: (type, fn) => listeners[type]?.add(fn),
    postMessage: (message) => sent.push(message),
    terminate: () => { worker.terminated = true; },
    /** Deliver a message from the worker to the page. */
    emit: (data) => listeners.message.forEach((fn) => fn({ data })),
    fail: () => listeners.error.forEach((fn) => fn(new Event('error'))),
    failMessage: () => listeners.messageerror.forEach((fn) => fn(new Event('messageerror'))),
    lastRpc: (op) => [...sent].reverse().find((m) => m.type === 'rpc' && (!op || m.op === op)),
    answer: (op, result) => {
      const rpc = worker.lastRpc(op);
      worker.emit({ type: 'rpc-result', id: rpc.id, ok: true, result });
    },
    reject: (op, kind) => {
      const rpc = worker.lastRpc(op);
      worker.emit({ type: 'rpc-result', id: rpc.id, ok: false, error: { kind } });
    }
  };
  return worker;
};

/** A client whose worker answers `recover` with the given state. */
const startedClient = async ({ recovery = { state: 'ready', record: RECORD }, ...opts } = {}) => {
  const workers = [];
  const client = createLocalDbClient({
    createWorker: () => {
      const worker = fakeWorker();
      workers.push(worker);
      // Answer `recover` as soon as the page asks.
      queueMicrotask(() => {
        if (worker.lastRpc('recover')) worker.answer('recover', recovery);
      });
      return worker;
    },
    statusTimeoutMs: 50,
    ...opts
  });
  const state = await client.start();
  return { client, workers, state };
};

describe('[P5 row9] ownership: one owner per browser profile', () => {
  it('the owner lock is requested BEFORE the worker exists and held for the document', async () => {
    const order = [];
    const client = createLocalDbClient({
      createWorker: () => {
        order.push('worker');
        const worker = fakeWorker();
        queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        return worker;
      },
      locks: {
        request: (name, opts, cb) => {
          order.push(`lock:${name}:${opts.mode}:${opts.ifAvailable}`);
          return fakes.locks.request(name, opts, cb);
        }
      }
    });
    await client.start();
    expect(order).toEqual([`lock:${OWNER_LOCK}:exclusive:true`, 'worker']);
    expect(fakes.locks.isHeld(OWNER_LOCK)).toBe(true);
    expect(client.state()).toBe('ready');
    client.dispose();
    await yieldTicks();
    expect(fakes.locks.isHeld(OWNER_LOCK)).toBe(false);
  });

  it('a second tab gets no lock, creates NO worker, and shows the other-tab state', async () => {
    const first = await startedClient();
    const createWorker = vi.fn(() => fakeWorker());
    const second = createLocalDbClient({ createWorker });
    expect(await second.start()).toBe('other-tab');
    expect(createWorker).not.toHaveBeenCalled();

    // "Try again" takes over once the owner tab is gone.
    expect(await second.retryOwnership()).toBe('other-tab');
    first.client.dispose();
    await yieldTicks(5);
    const taken = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        return worker;
      }
    });
    expect(await taken.start()).toBe('ready');
    taken.dispose();
  });

  it('local queries are served only in the ready state', async () => {
    const repair = await startedClient({ recovery: { state: 'repair-needed', record: null } });
    expect(repair.state).toBe('repair-needed');
    await expect(repair.client.query('Q1', { text: 'cats', authorities: ['lcsh'] }))
      .rejects.toMatchObject({ kind: 'db_not_ready' });

    const broken = await startedClient({ recovery: { state: 'recovery-unavailable', record: null } });
    await expect(broken.client.query('Q1', { text: 'cats', authorities: ['lcsh'] }))
      .rejects.toBeInstanceOf(LocalDbError);
  });
});

describe('[P5 row9] worker crashes', () => {
  it('a crash rejects the pending calls, and ONE new worker is created under the same lock', async () => {
    const { client, workers } = await startedClient();
    const query = client.query('Q1', { text: 'cats', authorities: ['lcsh'] });
    workers[0].fail();
    await expect(query).rejects.toMatchObject({ kind: 'db_worker_failed' });
    await yieldTicks(6);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(fakes.locks.isHeld(OWNER_LOCK)).toBe(true);
    expect(client.state()).toBe('ready');
    client.dispose();
  });

  it('a SECOND crash gives up for this document', async () => {
    const { client, workers } = await startedClient();
    workers[0].fail();
    await yieldTicks(6);
    workers[1].failMessage();
    await yieldTicks(6);
    expect(workers).toHaveLength(2);
    expect(client.state()).toBe('worker-failed');
    await expect(client.query('Q1', {})).rejects.toBeInstanceOf(LocalDbError);
    client.dispose();
  });

  // N1: the REPLACEMENT worker failing used to hand `crash()` the pending
  // replacement promise, so nothing terminated it and nothing rejected its
  // recovery. These two cases are the ones the second-crash test above misses,
  // because that one answers recovery first.
  it('a replacement that NEVER answers recovery is terminated and gives up', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        // Only the first worker answers; the replacement hangs on `recover`.
        if (workers.length === 1) queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        return worker;
      },
      statusTimeoutMs: 20,
      probeMs: 100000
    });
    await client.start();
    expect(client.state()).toBe('ready');

    workers[0].fail();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(workers).toHaveLength(2);
    expect(workers[1].terminated).toBe(true);
    expect(client.state()).toBe('worker-failed');
    expect(client.workerStarts()).toBe(2);
    await expect(client.query('Q1', {})).rejects.toBeInstanceOf(LocalDbError);
    client.dispose();
  });

  it('a replacement that ERRORS before recovery completes rejects its RPCs and gives up', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        if (workers.length === 1) queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        // The replacement errors while its `recover` is still pending.
        else queueMicrotask(() => worker.fail());
        return worker;
      },
      statusTimeoutMs: 100000,
      probeMs: 100000
    });
    await client.start();
    workers[0].fail();
    await yieldTicks(10);

    expect(workers).toHaveLength(2);
    expect(workers[1].terminated).toBe(true);
    expect(client.state()).toBe('worker-failed');
    // No third worker, and nothing is left pending.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workers).toHaveLength(2);
    await expect(client.status()).rejects.toMatchObject({ kind: 'db_worker_failed' });
    client.dispose();
  });

  it('a worker that says nothing at all is treated as a crash by the watchdog', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        return worker; // never answers
      },
      statusTimeoutMs: 10
    });
    const started = client.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await started.catch(() => {});
    expect(workers.length).toBeGreaterThanOrEqual(2);
    client.dispose();
  });

  it('the generation rises with every worker, so a late reply cannot be admitted', async () => {
    const { client, workers } = await startedClient();
    const before = client.workerGeneration();
    workers[0].fail();
    await yieldTicks(6);
    expect(client.workerGeneration()).toBeGreaterThan(before);
    client.dispose();
  });
});

describe('[P5 row9] the settings bridge', () => {
  const bridged = (message) => ({ type: 'bridge', bridgeId: 'b1', ...message });
  const answerOf = (worker) => [...worker.sent].reverse().find((m) => m.type === 'bridge-result');

  it('a request with a stale workerGeneration is refused without touching the settings', async () => {
    const { client, workers } = await startedClient();
    const read = vi.spyOn(fakes.storage.local, 'get');
    workers[0].emit(bridged({ workerGeneration: 0, operationId: RECOVERY_OPERATION, action: 'read' }));
    await yieldTicks(4);
    expect(answerOf(workers[0])).toEqual({ type: 'bridge-result', bridgeId: 'b1', ok: false, reason: 'stale-generation' });
    read.mockRestore();
    client.dispose();
  });

  it('a request for an operation that is not running is refused', async () => {
    const { client, workers } = await startedClient();
    workers[0].emit(bridged({ workerGeneration: client.workerGeneration(), operationId: 'not-running', action: 'read' }));
    await yieldTicks(4);
    expect(answerOf(workers[0]).reason).toBe('stale-generation');
    client.dispose();
  });

  it('a read of the running operation answers the current local-database settings', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        queueMicrotask(() => {
          worker.emit(bridged({ workerGeneration: 1, operationId: RECOVERY_OPERATION, action: 'read' }));
        });
        return worker;
      },
      statusTimeoutMs: 1000
    });
    fakes.storage.seed({ lookupBackend: 'local-db', localDb: RECORD, localDbPendingDeletes: ['/x.db'] });
    const starting = client.start();
    await yieldTicks(30);
    expect(answerOf(workers[0])).toEqual({
      type: 'bridge-result',
      bridgeId: 'b1',
      ok: true,
      current: {
        lookupBackend: 'local-db', localDb: RECORD, localDbPendingDeletes: ['/x.db'],
        valid: true, invalidReason: null
      }
    });
    workers[0].answer('recover', { state: 'ready', record: RECORD });
    await starting;
    client.dispose();
  });
});

describe('[P5 row9] commitLocalDb: the compare-and-write of §3.3', () => {
  it('compares expectedLocalDb STRUCTURALLY, null included', async () => {
    expect(await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD } }))
      .toMatchObject({ ok: true });
    expect((await readLocalDbSettings()).localDb).toEqual(RECORD);

    // A reordered copy of the same record is still the same record.
    const reordered = Object.fromEntries(Object.entries(RECORD).reverse());
    expect(await commitLocalDb({ expectedLocalDb: reordered, patch: { localDb: null } }))
      .toMatchObject({ ok: true });

    await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD } });
    const stale = await commitLocalDb({ expectedLocalDb: { ...RECORD, file: '/other.db' }, patch: { localDb: null } });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe('changed');
    expect((await readLocalDbSettings()).localDb).toEqual(RECORD);
  });

  it('the patch is allowlisted; every other setting is preserved', async () => {
    fakes.storage.seed({ activeProviderId: 'deepseek', systemPromptRules: 'keep me' });
    await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD, lookupBackend: 'local-db' } });
    const settings = await getSettings();
    expect(settings.activeProviderId).toBe('deepseek');
    expect(settings.systemPromptRules).toBe('keep me');
    expect(settings.lookupBackend).toBe('local-db');
    await expect(commitLocalDb({ expectedLocalDb: RECORD, patch: { activeProviderId: 'gemini' } })).rejects.toThrow();
    await expect(commitLocalDb({ expectedLocalDb: RECORD, patch: { lookupBackend: 'nope' } })).rejects.toThrow();
  });

  it('pending deletes are added and removed on the FRESH list, not on a stale snapshot', async () => {
    fakes.storage.seed({ localDbPendingDeletes: ['/a.db'] });
    await commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesAdd: ['/b.db'] } });
    expect((await readLocalDbSettings()).localDbPendingDeletes).toEqual(['/a.db', '/b.db']);
    await commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesRemove: ['/a.db'] } });
    expect((await readLocalDbSettings()).localDbPendingDeletes).toEqual(['/b.db']);
    // Adding the same name twice is idempotent.
    await commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesAdd: ['/b.db'] } });
    expect((await readLocalDbSettings()).localDbPendingDeletes).toEqual(['/b.db']);
  });

  it('the fence runs immediately before the write; a false fence writes nothing', async () => {
    const calls = [];
    const original = fakes.storage.local.set;
    fakes.storage.local.set = async (items) => {
      calls.push('write');
      return original(items);
    };
    const result = await commitLocalDb({
      expectedLocalDb: null,
      patch: { localDb: RECORD },
      fence: () => {
        calls.push('fence');
        return false;
      }
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale-generation' });
    expect(calls).toEqual(['fence']);
    expect((await readLocalDbSettings()).localDb).toBeNull();

    calls.length = 0;
    await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD }, fence: () => { calls.push('fence'); return true; } });
    expect(calls).toEqual(['fence', 'write']);
    fakes.storage.local.set = original;
  });

  it('a failed write is reported, and the stored settings are unchanged', async () => {
    fakes.storage.failNext('set', new Error('quota'));
    const result = await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD } });
    expect(result).toMatchObject({ ok: false, reason: 'write-failed' });
    expect((await readLocalDbSettings()).localDb).toBeNull();
  });

  it('two pages committing at the same time do not lose an update (the settings lock)', async () => {
    await commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesAdd: ['/a.db'] } });
    await Promise.all([
      commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesAdd: ['/b.db'] } }),
      commitLocalDb({ expectedLocalDb: null, patch: { pendingDeletesAdd: ['/c.db'] } })
    ]);
    expect((await readLocalDbSettings()).localDbPendingDeletes.sort()).toEqual(['/a.db', '/b.db', '/c.db']);
  });

  it('the update check is page-owned and separate from the installed record', async () => {
    expect(await localDbUpdateCheck()).toBeNull();
    await localDbUpdateCheck({ lastCheckedAt: 1790000000000, latestSeen: '2026.09.28.1' });
    expect(await localDbUpdateCheck()).toEqual({ lastCheckedAt: 1790000000000, latestSeen: '2026.09.28.1' });
    expect((await readLocalDbSettings()).localDb).toBeNull();
  });

  it('setLookupBackend writes only the backend', async () => {
    await setLookupBackend('local-db');
    expect((await getSettings()).lookupBackend).toBe('local-db');
    await expect(setLookupBackend('nope')).rejects.toThrow();
  });
});

describe('[P5 row9] worker replacement drains the admitted commit handlers', () => {
  it('a handler still awaiting its settings read fails the final fence, and recovery waits for it', async () => {
    const workers = [];
    const readGate = gate();
    const order = [];
    const settingsApi = {
      read: async () => {
        order.push('read-start');
        await readGate.promise;
        order.push('read-done');
        return { lookupBackend: 'local-db', localDb: null, localDbPendingDeletes: [] };
      },
      commit: async ({ fence }) => {
        order.push('commit-start');
        await readGate.promise;
        order.push('commit-fence');
        // The real settings.js runs the fence immediately before the write.
        if (!fence()) return { ok: false, reason: 'stale-generation' };
        order.push('commit-write');
        return { ok: true, current: {} };
      }
    };
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        queueMicrotask(() => {
          if (workers.length === 1) return; // the first worker hangs on purpose
          order.push('recovery-started');
          worker.answer('recover', { state: 'ready', record: RECORD });
        });
        return worker;
      },
      settingsApi,
      statusTimeoutMs: 10000
    });
    const starting = client.start();
    await yieldTicks(4);

    // An ADMITTED commit handler that is still awaiting.
    workers[0].emit({
      type: 'bridge', bridgeId: 'b1', workerGeneration: client.workerGeneration(),
      operationId: RECOVERY_OPERATION, action: 'commit', expectedLocalDb: null, patch: { localDb: RECORD }
    });
    await yieldTicks(3);
    expect(order).toEqual(['commit-start']);

    workers[0].fail();
    await yieldTicks(3);
    // The new worker's recovery has NOT started while the handler is pending.
    expect(order).toEqual(['commit-start']);
    readGate.open();
    await yieldTicks(8);
    expect(order).toEqual(['commit-start', 'commit-fence', 'recovery-started']);
    const answer = [...workers[0].sent].reverse().find((m) => m.type === 'bridge-result');
    expect(answer).toMatchObject({ ok: false, reason: 'stale-generation' });
    await starting.catch(() => {});
    client.dispose();
  });
});

describe('[P5 fix4] the watchdog keeps watching after the first message', () => {
  it('a worker that goes silent AFTER a successful start is replaced', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        // Only the FIRST worker answers, and only its `recover`.
        if (workers.length === 1) queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        else queueMicrotask(() => worker.answer('recover', { state: 'ready', record: RECORD }));
        return worker;
      },
      statusTimeoutMs: 20,
      probeMs: 10
    });
    await client.start();
    expect(workers).toHaveLength(1);
    // The client keeps probing; this worker answers nothing any more.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(workers.length).toBeGreaterThan(1);
    expect(workers[0].terminated).toBe(true);
    client.dispose();
  });

  it('a worker that keeps answering its status probes is NOT replaced', async () => {
    const workers = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const worker = fakeWorker();
        workers.push(worker);
        const answerAll = () => {
          const recover = worker.sent.find((m) => m.type === 'rpc' && m.op === 'recover' && !m.__done);
          if (recover) {
            recover.__done = true;
            worker.emit({ type: 'rpc-result', id: recover.id, ok: true, result: { state: 'ready', record: RECORD } });
          }
          for (const m of worker.sent) {
            if (m.type === 'rpc' && m.op === 'status' && !m.__done) {
              m.__done = true;
              worker.emit({ type: 'rpc-result', id: m.id, ok: true, result: { state: 'ready' } });
            }
          }
        };
        worker.pump = setInterval(answerAll, 2);
        return worker;
      },
      statusTimeoutMs: 40,
      probeMs: 5
    });
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(workers).toHaveLength(1);
    expect(client.state()).toBe('ready');
    const probes = workers[0].sent.filter((m) => m.type === 'rpc' && m.op === 'status');
    expect(probes.length).toBeGreaterThan(1);
    clearInterval(workers[0].pump);
    client.dispose();
  });

  it('a message from a REPLACED worker changes nothing', async () => {
    const { client, workers } = await startedClient();
    workers[0].fail();
    await yieldTicks(8);
    expect(workers).toHaveLength(2);
    const before = client.state();
    // The dead worker speaks again.
    workers[0].emit({ type: 'state', state: 'repair-needed', record: null });
    await yieldTicks(3);
    expect(client.state()).toBe(before);
    client.dispose();
  });

  it('two crash signals replace the worker only once', async () => {
    const { client, workers } = await startedClient();
    workers[0].fail();
    workers[0].failMessage();
    await yieldTicks(8);
    expect(workers).toHaveLength(2);
    client.dispose();
  });
});

describe('[P5 fix3] a second mutation is refused before it takes ownership', () => {
  it('the running operation keeps its identity, and the second call fails fast', async () => {
    const { client, workers } = await startedClient();
    const first = client.install({ operationId: 'op1', pointer: {}, profile: 'core' });
    await expect(client.install({ operationId: 'op2', pointer: {}, profile: 'core' }))
      .rejects.toMatchObject({ kind: 'db_busy' });
    // The bridge still admits op1 only.
    workers[0].emit({
      type: 'bridge', bridgeId: 'b9', workerGeneration: client.workerGeneration(),
      operationId: 'op1', action: 'read'
    });
    await yieldTicks(20);
    const answer = [...workers[0].sent].reverse().find((m) => m.type === 'bridge-result');
    expect(answer).toMatchObject({ ok: true });
    workers[0].answer('install', { status: 'installed' });
    await first;
    client.dispose();
  });
});

describe('[P5 fix9] the operation lives in the client, not in the panel', () => {
  it('a subscriber that arrives mid-install sees the operation and its phase', async () => {
    const { client, workers } = await startedClient();
    const running = client.install({ operationId: 'op1', pointer: {}, profile: 'core' });
    workers[0].emit({ type: 'phase', operationId: 'op1', phase: 'downloading' });
    workers[0].emit({ type: 'progress', operationId: 'op1', phase: 'downloading', done: 10, total: 100 });
    await yieldTicks(3);

    // A panel that mounts NOW gets the snapshot immediately.
    const seen = [];
    const stop = client.onProgress((snapshot) => seen.push(snapshot));
    expect(seen[0].operation).toEqual({ operationId: 'op1', phase: 'downloading' });
    expect(seen[0].progress).toEqual({ phase: 'downloading', done: 10, total: 100 });
    stop();

    workers[0].answer('install', { status: 'installed' });
    await running;
    expect(client.operation()).toBeNull();
    client.dispose();
  });

  it('a gate event is NOT a mutation phase, so Cancel stays disabled once committing', async () => {
    const { client, workers } = await startedClient();
    const running = client.install({ operationId: 'op1', pointer: {}, profile: 'core' });
    workers[0].emit({ type: 'phase', operationId: 'op1', phase: 'committing' });
    await yieldTicks(2);
    expect(client.operation().phase).toBe('committing');

    // The worker gates the queries right after; this must not look like a phase.
    workers[0].emit({ type: 'gate', gated: true });
    workers[0].emit({ type: 'progress', operationId: 'op1', phase: 'downloading', done: 1, total: 2 });
    await yieldTicks(2);
    expect(client.operation().phase).toBe('committing');
    expect(client.snapshot().gated).toBe(true);

    workers[0].answer('install', { status: 'installed' });
    await running;
    client.dispose();
  });

  it('onChange also delivers a snapshot to a late subscriber', async () => {
    const { client } = await startedClient();
    const seen = [];
    const stop = client.onChange((snapshot) => seen.push(snapshot));
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toBe('ready');
    expect(seen[0].record).toEqual(RECORD);
    stop();
    client.dispose();
  });
});

describe('[P5 fix8] the installation identity is read fresh', () => {
  it('installation() reflects the CURRENT record, and is null when not ready', async () => {
    const { client, workers } = await startedClient();
    expect(client.installation()).toEqual({
      profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db'
    });
    const repaired = { ...RECORD, file: '/db-2.db', release: '2026.09.28.1' };
    workers[0].emit({ type: 'state', state: 'ready', record: repaired });
    await yieldTicks(2);
    expect(client.installation().file).toBe('/db-2.db');
    expect(client.installation().release).toBe('2026.09.28.1');

    workers[0].emit({ type: 'state', state: 'repair-needed', record: null });
    await yieldTicks(2);
    expect(client.installation()).toBeNull();
    client.dispose();
  });
});

describe('[P5 row9] cancelling a local call', () => {
  it('settles at once and ignores the late reply', async () => {
    const { client, workers } = await startedClient();
    const controller = new AbortController();
    const query = client.query('Q3a', { text: '"cats"', authorities: ['lcsh'], signal: controller.signal });
    controller.abort();
    await expect(query).rejects.toMatchObject({ kind: 'cancelled' });
    expect(workers[0].sent.some((m) => m.type === 'drop')).toBe(true);
    // A late answer for the dropped call changes nothing.
    workers[0].answer('query', [{ id: 1 }]);
    await yieldTicks(3);
    client.dispose();
  });

  it('an error kind from the worker reaches the caller', async () => {
    const { client, workers } = await startedClient();
    const query = client.query('Q1', { text: 'cats', authorities: ['lcsh'] });
    workers[0].reject('query', 'db_generation_changed');
    await expect(query).rejects.toMatchObject({ kind: 'db_generation_changed' });
    client.dispose();
  });
});
