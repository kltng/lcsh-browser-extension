import { describe, it, expect, vi } from 'vitest';
import { createLocalDbClient, RECOVERY_OPERATION, ACQUIRE_BUDGET_MS, ACQUIRE_BACKOFF_MS, HANG_MS } from '../client';
import { createWorkerDispatcher } from '../worker';
import { acquirePool } from '../guard';
import { createFakeOpfs, createFakeInitializer } from '../../../../test/opfsFakes';
import { fakes, gate, yieldTicks } from '../../../../test/setup';

const RECORD = {
  profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db',
  dbSize: 4096, sha256Db: 'b'.repeat(64), compatFingerprint: 'FP', installedAt: '2026-09-27T00:00:00.000Z'
};

const sleepReal = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Workers that run the REAL dispatcher and the REAL guarded acquisition over
 * a shared fake OPFS. Messages cross the "thread" boundary asynchronously, and
 * termination releases every handle the worker holds — like the browser.
 */
const opfsWorkers = (opfs, { delays = {}, deliveryMs = 0 } = {}) => {
  const created = [];
  const createWorker = () => {
    const owner = `w${created.length + 1}`;
    const fs = opfs.workerScope(owner);
    const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
    let dispatcher;
    const worker = {
      owner,
      fs,
      sent: [],
      terminated: false,
      addEventListener: (type, fn) => listeners[type]?.add(fn),
      postMessage: (message) => {
        worker.sent.push(message);
        setTimeout(() => { if (!worker.terminated) dispatcher.handleMessage(structuredClone(message)); }, 0);
      },
      terminate: () => {
        worker.terminated = true;
        fs.terminate();
      },
      acquires: () => worker.sent.filter((m) => m.type === 'rpc' && m.op === 'acquire').length,
      ops: () => worker.sent.filter((m) => m.type === 'rpc').map((m) => m.op)
    };
    dispatcher = createWorkerDispatcher({
      post: (message) => {
        setTimeout(() => {
          if (!worker.terminated) listeners.message.forEach((fn) => fn({ data: structuredClone(message) }));
        }, deliveryMs);
      },
      createPool: async () => {
        await acquirePool({ scope: fs.scope, installSahPool: createFakeInitializer(fs, { delays }) });
        // The database names the pool reports (none: this suite tests acquisition).
        return {
          listFiles: async () => [], importDb: vi.fn(), unlink: vi.fn(async () => true), open: vi.fn()
        };
      }
    });
    created.push(worker);
    return worker;
  };
  return { createWorker, created };
};

describe('[P5 row13] contention is retried, each time in a FRESH guarded worker (§3.2 rule 2)', () => {
  it('a pool released by the old worker is acquired by a NEW worker, and nothing is deleted', async () => {
    const opfs = createFakeOpfs(['slot-a', 'slot-b']);
    opfs.hold('slot-a', 'old-worker');
    setTimeout(() => opfs.releaseOwner('old-worker'), 40);
    const { createWorker, created } = opfsWorkers(opfs);
    const client = createLocalDbClient({ createWorker, backoffMs: () => 8, acquireBudgetMs: 2000, hangMs: 5000 });
    expect(await client.start()).toBe('ready');

    expect(created.length).toBeGreaterThan(1);
    // Exactly one acquisition attempt per worker; never a retry in the same one.
    for (const worker of created) expect(worker.acquires()).toBe(1);
    // Every failed worker was terminated; only the last one lives.
    expect(created.slice(0, -1).every((w) => w.terminated)).toBe(true);
    expect(created.at(-1).terminated).toBe(false);
    // Recovery ran exactly once, in the worker that acquired the pool.
    expect(created.slice(0, -1).every((w) => !w.ops().includes('recover'))).toBe(true);
    expect(created.at(-1).ops()).toEqual(['acquire', 'recover']);
    // The guard kept every slot file.
    expect([...opfs.files.keys()].sort()).toEqual(['slot-a', 'slot-b']);
    client.dispose();
  });

  it('the fail-fast case: request A rejects, a LATE request B succeeds after the cleanup — B is released by terminating that worker', async () => {
    const opfs = createFakeOpfs(['slot-a', 'slot-b']);
    opfs.hold('slot-a', 'old-worker');
    setTimeout(() => opfs.releaseOwner('old-worker'), 60);
    // B is slower than A's rejection, and the contention answer reaches the
    // page only after B already got its handle.
    const { createWorker, created } = opfsWorkers(opfs, { delays: { 'slot-b': 3 }, deliveryMs: 10 });
    const client = createLocalDbClient({ createWorker, backoffMs: () => 8, acquireBudgetMs: 2000, hangMs: 5000 });
    expect(await client.start()).toBe('ready');

    const first = created[0];
    // The leak really happened in the first worker...
    expect(first.fs.attempts).toContain('late-handle:slot-b');
    // ...and its termination released it, so a later FRESH worker got BOTH.
    expect(first.terminated).toBe(true);
    const winner = created.at(-1);
    expect(opfs.holders()).toEqual({ 'slot-a': winner.owner, 'slot-b': winner.owner });
    for (const worker of created) expect(worker.acquires()).toBe(1);
    expect([...opfs.files.keys()].sort()).toEqual(['slot-a', 'slot-b']);
    client.dispose();
  });

  it('a retry inside the SAME worker would be refused (the worker never re-acquires)', async () => {
    const opfs = createFakeOpfs(['slot-a']);
    opfs.hold('slot-a', 'old-worker');
    const w = opfs.workerScope('solo');
    const sent = [];
    const dispatcher = createWorkerDispatcher({
      post: (m) => sent.push(m),
      createPool: () => acquirePool({ scope: w.scope, installSahPool: createFakeInitializer(w) })
    });
    dispatcher.handleMessage({ type: 'rpc', id: 1, op: 'acquire', workerGeneration: 1 });
    await sleepReal(5);
    opfs.releaseOwner('old-worker');
    dispatcher.handleMessage({ type: 'rpc', id: 2, op: 'acquire', workerGeneration: 1 });
    await sleepReal(5);
    expect(sent.find((m) => m.id === 1)).toMatchObject({ ok: false, error: { kind: 'db_contention' } });
    // Even with the pool free now, THIS worker refuses: only a fresh one may try.
    expect(sent.find((m) => m.id === 2)).toMatchObject({ ok: false, error: { kind: 'db_init_failed' } });
    // Nothing that needs the pool is served either.
    dispatcher.handleMessage({ type: 'rpc', id: 3, op: 'recover', args: {}, workerGeneration: 1 });
    await sleepReal(2);
    expect(sent.find((m) => m.id === 3)).toMatchObject({ ok: false, error: { kind: 'db_not_ready' } });
  });

  it('exhaustion through the REAL 30 s deadline is db_busy, with files and settings untouched', async () => {
    const opfs = createFakeOpfs(['slot-a', 'slot-b']);
    opfs.hold('slot-a', 'old-worker'); // never released
    const { createWorker, created } = opfsWorkers(opfs);
    // A fake monotonic clock: only the backoff sleeps advance it.
    let clock = 0;
    const waits = [];
    const client = createLocalDbClient({
      createWorker,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; await sleepReal(0); }
    });
    fakes.storage.seed({ lookupBackend: 'local-db', localDb: RECORD, localDbPendingDeletes: [] });
    const setCalls = fakes.storage.calls.set.length;
    expect(await client.start()).toBe('db_busy');

    // The attempts follow the backoff schedule until the next wait would
    // reach the deadline, counted from the first attempt.
    const expected = [];
    let t = 0;
    for (let attempt = 0; ; attempt += 1) {
      const wait = ACQUIRE_BACKOFF_MS[Math.min(attempt, ACQUIRE_BACKOFF_MS.length - 1)];
      if (t + wait >= ACQUIRE_BUDGET_MS) break;
      expected.push(wait);
      t += wait;
    }
    expect(ACQUIRE_BUDGET_MS).toBe(30000);
    expect(waits).toEqual(expected);
    expect(created).toHaveLength(expected.length + 1);
    for (const worker of created) {
      expect(worker.acquires()).toBe(1);
      expect(worker.terminated).toBe(true);
      // No recovery anywhere, so no cleanup — an unresolved commit's staging
      // file can never be deleted by a retry expiry.
      expect(worker.ops()).toEqual(['acquire']);
    }
    expect([...opfs.files.keys()].sort()).toEqual(['slot-a', 'slot-b']);
    expect(fakes.storage.calls.set.length).toBe(setCalls);
    expect(fakes.storage.dump().localDb).toEqual(RECORD);
    expect(client.state()).toBe('db_busy');
    client.dispose();
  });

  // Review-4 finding 2: the deadline was checked only BEFORE the backoff sleep.
  // A continuation that resumes late (page scheduling) then spawned another
  // worker outside the 30 s window — which could even acquire and recover.
  it('a backoff that OVERSLEEPS past the deadline spawns no further worker and ends as db_busy', async () => {
    let clock = 0;
    const created = [];
    const waits = [];
    // The pool is free again from 31 s on: a worker started that late WOULD acquire.
    const createWorker = () => {
      const listeners = new Set();
      const worker = {
        sent: [],
        terminated: false,
        startedAt: clock,
        addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
        postMessage: (m) => {
          worker.sent.push(m);
          if (m.type !== 'rpc') return;
          const reply = (payload) => queueMicrotask(() => listeners.forEach((fn) => fn({ data: { type: 'rpc-result', id: m.id, ...payload } })));
          if (m.op === 'acquire') reply(clock >= 31000 ? { ok: true, result: { acquired: true } } : { ok: false, error: { kind: 'db_contention' } });
          if (m.op === 'recover') reply({ ok: true, result: { state: 'ready', record: RECORD } });
        },
        terminate: () => { worker.terminated = true; }
      };
      created.push(worker);
      return worker;
    };
    const client = createLocalDbClient({
      createWorker,
      now: () => clock,
      // Normally the sleep lasts what was asked. The 2 s backoff that starts at
      // 27.75 s resumes only at 31 s, past the 30 s deadline.
      sleep: async (ms) => {
        waits.push({ at: clock, ms });
        clock = clock === 27750 ? 31000 : clock + ms;
        await sleepReal(0);
      },
      hangMs: 100000,
      probeMs: 100000
    });
    expect(await client.start()).toBe('db_busy');

    // The scenario really happened: a 2 s wait began at 27.75 s.
    expect(waits.at(-1)).toEqual({ at: 27750, ms: 2000 });
    // No worker was started after the deadline...
    expect(created.every((w) => w.startedAt < ACQUIRE_BUDGET_MS)).toBe(true);
    expect(created).toHaveLength(waits.length);
    // ...so nothing acquired, nothing recovered, nothing was cleaned up.
    for (const worker of created) {
      expect(worker.sent.filter((m) => m.op === 'acquire')).toHaveLength(1);
      expect(worker.sent.some((m) => m.op === 'recover')).toBe(false);
      expect(worker.terminated).toBe(true);
    }
    expect(client.state()).toBe('db_busy');
    client.dispose();
  });

  it('a non-contention failure is NOT retried', async () => {
    const created = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const listeners = new Set();
        const worker = {
          sent: [],
          terminated: false,
          addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
          postMessage: (m) => {
            worker.sent.push(m);
            if (m.op === 'acquire') {
              queueMicrotask(() => listeners.forEach((fn) => fn({ data: { type: 'rpc-result', id: m.id, ok: false, error: { kind: 'db_guard_failed' } } })));
            }
          },
          terminate: () => { worker.terminated = true; }
        };
        created.push(worker);
        return worker;
      },
      backoffMs: () => 1
    });
    expect(await client.start()).toBe('worker-failed');
    expect(created).toHaveLength(1);
    expect(created[0].terminated).toBe(true);
  });
});

describe('[P5 row13] deadline ordering (§3.2 rule 3)', () => {
  it('the startup watchdog never races the acquisition window: contention for the whole window ends as db_busy', async () => {
    const opfs = createFakeOpfs(['slot-a']);
    opfs.hold('slot-a', 'old-worker');
    // Each acquisition answer takes 15 ms to reach the page.
    const { createWorker, created } = opfsWorkers(opfs, { deliveryMs: 15 });
    // Budget and hang threshold of EQUAL length: an equal-duration startup
    // watchdog would fire at the same moment as the budget expiry.
    const client = createLocalDbClient({ createWorker, acquireBudgetMs: 60, hangMs: 60, backoffMs: () => 10 });
    expect(await client.start()).toBe('db_busy');
    expect(client.state()).toBe('db_busy');
    expect(created.length).toBeGreaterThan(1);
    expect(created.every((w) => w.acquires() === 1)).toBe(true);
  });

  it('the ADMITTED-write drain finishes before a replacement acquires; the budget starts only after it', async () => {
    const workers = [];
    let clock = 0;
    const order = [];
    const readGate = gate();
    // Worker 1 acquires and recovers; every later worker sees contention twice, then succeeds.
    let laterAttempts = 0;
    const client = createLocalDbClient({
      createWorker: () => {
        const listeners = new Set();
        const errors = new Set();
        const index = workers.length;
        const worker = {
          sent: [],
          terminated: false,
          addEventListener: (type, fn) => {
            if (type === 'message') listeners.add(fn);
            if (type === 'error') errors.add(fn);
          },
          fail: () => errors.forEach((fn) => fn(new Event('error'))),
          emit: (data) => listeners.forEach((fn) => fn({ data })),
          postMessage: (m) => {
            worker.sent.push(m);
            if (m.type !== 'rpc') return;
            if (m.op === 'acquire') {
              order.push(`acquire:${index}`);
              const fail = index > 0 && laterAttempts < 2;
              if (index > 0) laterAttempts += 1;
              queueMicrotask(() => worker.emit(fail
                ? { type: 'rpc-result', id: m.id, ok: false, error: { kind: 'db_contention' } }
                : { type: 'rpc-result', id: m.id, ok: true, result: { acquired: true } }));
            }
            if (m.op === 'recover') {
              order.push(`recover:${index}`);
              queueMicrotask(() => worker.emit({ type: 'rpc-result', id: m.id, ok: true, result: { state: 'ready', record: RECORD } }));
            }
          },
          terminate: () => { worker.terminated = true; }
        };
        workers.push(worker);
        return worker;
      },
      settingsApi: {
        read: async () => ({ lookupBackend: 'local-db', localDb: null, localDbPendingDeletes: [] }),
        commit: async ({ fence }) => {
          order.push('commit-start');
          await readGate.promise;
          order.push('commit-settled');
          return fence() ? { ok: true, current: {} } : { ok: false, reason: 'stale-generation' };
        }
      },
      now: () => clock,
      // The budget is tiny compared with the drain below.
      acquireBudgetMs: 1000,
      sleep: async (ms) => { clock += ms; await sleepReal(0); },
      backoffMs: () => 100,
      hangMs: 100000,
      probeMs: 100000
    });
    await client.start();
    expect(order).toEqual(['acquire:0', 'recover:0']);

    // An ADMITTED commit of the recovery-free running operation: a mutation.
    const running = client.install({ operationId: 'op1', pointer: {}, profile: 'core' }).catch(() => {});
    workers[0].emit({
      type: 'bridge', bridgeId: 'b1', workerGeneration: client.workerGeneration(),
      operationId: 'op1', action: 'commit', expectedLocalDb: null, patch: { localDb: RECORD }
    });
    await yieldTicks(3);
    workers[0].fail();
    await yieldTicks(5);
    // The drain is still waiting, so NO replacement exists yet.
    expect(workers).toHaveLength(1);
    // The drain takes far longer than the acquisition budget.
    clock += 60000;
    readGate.open();
    await sleepReal(20);
    await running;

    expect(order).toEqual([
      'acquire:0', 'recover:0', 'commit-start', 'commit-settled', 'acquire:1', 'acquire:2', 'acquire:3', 'recover:3'
    ]);
    // Had the deadline been taken before the drain, the first contention
    // would have been fatal; it was not.
    expect(client.state()).toBe('ready');
    client.dispose();
  });
});

describe('[P5 row13] the §3.2 hang rule: no status answer AND no progress for the threshold', () => {
  /** A worker that acquires and recovers, but NEVER answers a status probe. */
  const silentProber = () => {
    const workers = [];
    const createWorker = () => {
      const listeners = new Set();
      const errors = new Set();
      const worker = {
        sent: [],
        terminated: false,
        addEventListener: (type, fn) => {
          if (type === 'message') listeners.add(fn);
          if (type === 'error') errors.add(fn);
        },
        fail: () => errors.forEach((fn) => fn(new Event('error'))),
        emit: (data) => listeners.forEach((fn) => fn({ data })),
        postMessage: (m) => {
          worker.sent.push(m);
          if (m.type !== 'rpc') return;
          if (m.op === 'acquire') queueMicrotask(() => worker.emit({ type: 'rpc-result', id: m.id, ok: true, result: { acquired: true } }));
          if (m.op === 'recover') queueMicrotask(() => worker.emit({ type: 'rpc-result', id: m.id, ok: true, result: { state: 'ready', record: RECORD } }));
        },
        terminate: () => { worker.terminated = true; }
      };
      workers.push(worker);
      return worker;
    };
    return { workers, createWorker };
  };

  it('a busy install that keeps reporting progress is ALIVE although no probe is answered', async () => {
    const { workers, createWorker } = silentProber();
    const client = createLocalDbClient({ createWorker, hangMs: 40, probeMs: 5 });
    await client.start();
    client.install({ operationId: 'op1', pointer: {}, profile: 'core' }).catch(() => {});
    const beat = setInterval(() => {
      workers[0].emit({ type: 'progress', operationId: 'op1', phase: 'downloading', done: 1, total: 2 });
    }, 8);
    await sleepReal(150);
    clearInterval(beat);
    // Well past the threshold, and still the first worker.
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    // Once progress stops as well, it IS a hang.
    await sleepReal(120);
    expect(workers[0].terminated).toBe(true);
    client.dispose();
  });

  it('progress of ANOTHER operation does not count as liveness', async () => {
    const { workers, createWorker } = silentProber();
    const client = createLocalDbClient({ createWorker, hangMs: 40, probeMs: 5 });
    await client.start();
    client.install({ operationId: 'op1', pointer: {}, profile: 'core' }).catch(() => {});
    const beat = setInterval(() => {
      workers[0].emit({ type: 'progress', operationId: 'some-other-op', phase: 'downloading', done: 1, total: 2 });
    }, 8);
    await sleepReal(120);
    clearInterval(beat);
    expect(workers[0].terminated).toBe(true);
    client.dispose();
  });

  it('progress from a REPLACED worker generation does not keep the new one alive', async () => {
    const { workers, createWorker } = silentProber();
    const client = createLocalDbClient({ createWorker, hangMs: 40, probeMs: 5 });
    await client.start();
    workers[0].fail();
    await sleepReal(5);
    expect(workers).toHaveLength(2);
    client.install({ operationId: 'op1', pointer: {}, profile: 'core' }).catch(() => {});
    // The OLD worker keeps emitting progress for the running operation.
    const beat = setInterval(() => {
      workers[0].emit({ type: 'progress', operationId: 'op1', phase: 'downloading', done: 1, total: 2 });
    }, 8);
    await sleepReal(120);
    clearInterval(beat);
    // The new worker gave no sign of life and was declared hung (second
    // crash → this document gives up).
    expect(workers[1].terminated).toBe(true);
    expect(client.state()).toBe('worker-failed');
    client.dispose();
  });

  it('without a running mutation, the threshold applies to status probes alone', async () => {
    const answering = [];
    const client = createLocalDbClient({
      createWorker: () => {
        const listeners = new Set();
        const worker = {
          sent: [],
          terminated: false,
          addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
          postMessage: (m) => {
            worker.sent.push(m);
            if (m.type !== 'rpc') return;
            const result = { acquire: { acquired: true }, recover: { state: 'ready', record: RECORD }, status: { state: 'ready' } }[m.op];
            if (result) queueMicrotask(() => listeners.forEach((fn) => fn({ data: { type: 'rpc-result', id: m.id, ok: true, result } })));
          },
          terminate: () => { worker.terminated = true; }
        };
        answering.push(worker);
        return worker;
      },
      hangMs: 30,
      probeMs: 5
    });
    await client.start();
    await sleepReal(120);
    // A worker that answers its probes is never replaced.
    expect(answering).toHaveLength(1);
    expect(answering[0].sent.filter((m) => m.op === 'status').length).toBeGreaterThan(3);
    client.dispose();
  });

  it('the production threshold is 30 s', () => {
    expect(HANG_MS).toBe(30000);
    expect(RECOVERY_OPERATION).toBe('internal-recovery');
  });
});
