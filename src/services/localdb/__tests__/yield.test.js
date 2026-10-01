import { describe, it, expect } from 'vitest';
import { createWorkerDispatcher } from '../worker';
import { createInstaller } from '../install';
import { createWorkBudget } from '../budget';
import { sha256Hex } from '../sha256';
import { createFakePool, createFakeBridge } from '../../../../test/localdbFakes';

/**
 * SPEC-P5 §4.4 step 7b / §12 row 13, through the REAL dispatcher and the REAL
 * installer. The live failure: reading buffered stream data resolves as
 * MICROTASKS and SAH writes are synchronous, so without a macrotask yield the
 * worker cannot answer `status` or `cancel` until the whole import is done.
 *
 * Everything here is microtask-only on purpose: the body is FULLY BUFFERED,
 * decompression is an identity transform (Node's DecompressionStream would
 * yield on its own thread pool and hide the defect), the fake pool writes
 * synchronously, and hashing is synchronous. Time is an injected monotonic
 * clock; the only macrotasks are the ones the budget asks for.
 */
const GENERATION = 3;
const CHUNK = 4096;
const CHUNKS = 64;

const dbBytes = () => {
  const bytes = new Uint8Array(CHUNK * CHUNKS);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 253;
  return bytes;
};

const describeDb = (bytes) => ({
  meta: { profile: 'core', schema_version: '2', normalize_version: 'NORMALIZE_V1', lh_format: 'LH1', compat_fingerprint: 'FP' },
  objects: ['db_meta', 'auth', 'alt_label', 'hierarchy', 'auth_fts', 'alt_label_fts'].map((name) => ({ name, type: 'table' })),
  pages: { pageSize: 4096, pageCount: bytes.length / 4096 }
});

/** A body whose every chunk is already queued: each read resolves at once. */
const bufferedBody = (bytes) => new ReadableStream({
  start(controller) {
    for (let at = 0; at < bytes.length; at += CHUNK) controller.enqueue(bytes.slice(at, at + CHUNK));
    controller.close();
  }
});

const setup = ({ budgetMs = 100 } = {}) => {
  const bytes = dbBytes();
  const pointer = {
    release: '2026.10.01.1',
    releaseCommit: 'a'.repeat(40),
    compatFingerprint: 'FP',
    profiles: {
      core: {
        // Identity "decompression": the compressed and the decompressed stream are the same bytes.
        gzSize: bytes.length, dbSize: bytes.length, sha256Gz: sha256Hex(bytes), sha256Db: sha256Hex(bytes),
        url: 'https://huggingface.co/x', file: 'lcsh-core.db.gz'
      }
    }
  };
  const pool = createFakePool({ describe: (name, imported) => describeDb(imported) });
  const bridge = createFakeBridge();
  const sent = [];
  const trace = { phase: null, yields: [], chunks: 0, importDone: false };

  // An injected monotonic clock: every reading "costs" 30 ms.
  let clock = 0;
  const monotonic = () => { clock += 30; return clock; };
  // A controllable MACROTASK scheduler: it records where it yielded, then
  // really yields to the event loop (so queued messages get their turn).
  const yieldToMacrotask = () => {
    trace.yields.push({ phase: trace.phase, chunks: trace.chunks });
    return new Promise((resolve) => { setTimeout(resolve, 0); });
  };

  // Instrument the importer: count the chunks it writes, and notice its end.
  const importDb = pool.importDb;
  pool.importDb = async (name, pull) => {
    const counting = async () => {
      const chunk = await pull();
      if (chunk !== undefined) trace.chunks += 1;
      return chunk;
    };
    trace.onImportStart?.();
    const result = await importDb(name, counting);
    trace.importDone = true;
    return result;
  };

  let acquiredResolve;
  const acquired = new Promise((resolve) => { acquiredResolve = resolve; });
  const dispatcher = createWorkerDispatcher({
    post: (message) => {
      if (message.type === 'phase') trace.phase = message.phase;
      if (message.type === 'rpc-result') {
        message.observed = { chunks: trace.chunks, importDone: trace.importDone, phase: trace.phase };
        if (message.id === 'acquire') acquiredResolve();
      }
      sent.push(message);
    },
    createPool: async () => pool,
    createInstallerImpl: (deps) => createInstaller({
      ...deps,
      budgetMs,
      verifyBatchBytes: CHUNK,
      fetchImpl: async () => ({ status: 200, body: bufferedBody(bytes) }),
      decompressionStream: () => new TransformStream()
    }),
    monotonic,
    yieldToMacrotask
  });
  dispatcher.handleMessage({ type: 'rpc', id: 'acquire', op: 'acquire', args: {}, workerGeneration: GENERATION });

  // The page: answers bridge requests in its own macrotasks, like a real page.
  const answerBridges = () => {
    for (const request of sent.filter((m) => m.type === 'bridge' && !m.answered)) {
      request.answered = true;
      setTimeout(async () => {
        const answer = request.action === 'read'
          ? { ok: true, current: await bridge.read() }
          : await bridge.commit({ operationId: request.operationId, expectedLocalDb: request.expectedLocalDb, patch: request.patch });
        dispatcher.handleMessage({ type: 'bridge-result', bridgeId: request.bridgeId, ...answer });
      }, 0);
    }
  };
  const pageLoop = setInterval(answerBridges, 0);

  const rpc = (id, op, args = {}) => dispatcher.handleMessage({ type: 'rpc', id, op, args, workerGeneration: GENERATION });
  const resultOf = (id) => sent.find((m) => m.type === 'rpc-result' && m.id === id);
  const settled = async (id) => {
    for (let i = 0; i < 400 && !resultOf(id); i++) await new Promise((resolve) => { setTimeout(resolve, 0); });
    return resultOf(id);
  };
  return { pointer, pool, bridge, sent, trace, rpc, resultOf, settled, acquired, stop: () => clearInterval(pageLoop) };
};

describe('[P5 row13] the cooperative budget keeps the worker responsive during the import', () => {
  it('CONTROL — without the budget, a status sent at import start is answered only after the import', async () => {
    const env = setup({ budgetMs: Infinity });
    await env.acquired;
    // The page sends `status` while the import runs: a message in a NEW task.
    env.trace.onImportStart = () => setTimeout(() => env.rpc('ping', 'status'), 0);
    env.rpc('install', 'install', { pointer: env.pointer, profile: 'core', operationId: 'op1' });
    const status = await env.settled('ping');
    await env.settled('install');
    env.stop();
    // Starvation reproduced: the whole import ran before the message got a turn.
    expect(status.observed.importDone).toBe(true);
    expect(status.observed.chunks).toBe(CHUNKS);
    expect(env.trace.yields).toEqual([]);
  });

  it('WITH the budget, status is answered while the import is still running', async () => {
    const env = setup();
    await env.acquired;
    env.trace.onImportStart = () => setTimeout(() => env.rpc('ping', 'status'), 0);
    env.rpc('install', 'install', { pointer: env.pointer, profile: 'core', operationId: 'op1' });
    const status = await env.settled('ping');
    const install = await env.settled('install');
    env.stop();
    expect(status.ok).toBe(true);
    expect(status.observed.importDone).toBe(false);
    expect(status.observed.chunks).toBeGreaterThan(0);
    expect(status.observed.chunks).toBeLessThan(CHUNKS);
    expect(status.result.operation).toEqual({ operationId: 'op1', phase: 'downloading' });
    // The install itself still completes correctly.
    expect(install).toMatchObject({ ok: true, result: { status: 'installed' } });
  });

  it('budget-triggered yields happen in the import AND in the stored-byte check', async () => {
    const env = setup();
    await env.acquired;
    env.rpc('install', 'install', { pointer: env.pointer, profile: 'core', operationId: 'op1' });
    await env.settled('install');
    env.stop();
    const phases = new Set(env.trace.yields.map((y) => y.phase));
    expect(phases.has('downloading')).toBe(true);
    expect(phases.has('verifying')).toBe(true);
    // Mid-import yields: some before the last chunk was written.
    expect(env.trace.yields.some((y) => y.phase === 'downloading' && y.chunks < CHUNKS)).toBe(true);
    expect(phases.has('committing')).toBe(false);
  });

  it('WITH the budget, a cancel sent at import start is served BEFORE the import completes', async () => {
    const env = setup();
    await env.acquired;
    env.trace.onImportStart = () => setTimeout(() => env.rpc('cancel', 'cancel', { operationId: 'op1' }), 0);
    env.rpc('install', 'install', { pointer: env.pointer, profile: 'core', operationId: 'op1' });
    const cancel = await env.settled('cancel');
    const install = await env.settled('install');
    env.stop();
    expect(cancel).toMatchObject({ ok: true, result: true });
    expect(cancel.observed.importDone).toBe(false);
    // Cancellation is rechecked after the yield, before another chunk is
    // handed over: NOT ONE chunk reached the importer after the cancel.
    expect(install).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(env.trace.chunks).toBe(cancel.observed.chunks);
    expect(env.trace.chunks).toBeLessThan(CHUNKS);
    expect(env.trace.importDone).toBe(false);
    // Nothing was activated, and the staging file is gone.
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('a cancel that arrives during the stored-byte check stops it before committing', async () => {
    const env = setup();
    await env.acquired;
    let sentCancel = false;
    const check = setInterval(() => {
      if (!sentCancel && env.trace.phase === 'verifying') {
        sentCancel = true;
        env.rpc('cancel', 'cancel', { operationId: 'op1' });
      }
    }, 0);
    env.rpc('install', 'install', { pointer: env.pointer, profile: 'core', operationId: 'op1' });
    const install = await env.settled('install');
    clearInterval(check);
    env.stop();
    expect(sentCancel).toBe(true);
    expect(install).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
  });
});

describe('[P5 row13] the work budget itself', () => {
  it('yields a macrotask only once the budget has elapsed since the last yield', async () => {
    let t = 0;
    const yields = [];
    const budget = createWorkBudget({ now: () => t, yieldToMacrotask: async () => { yields.push(t); }, budgetMs: 100 });
    for (const step of [30, 30, 30, 30, 30, 30, 30, 30]) {
      t += step;
      await budget.checkpoint();
    }
    // 120 ms → first yield; then 240 ms (120 after it).
    expect(yields).toEqual([120, 240]);
    expect(budget.yields()).toBe(2);
  });

  it('a resolved Promise is NOT a yield: the default scheduler is a real macrotask', async () => {
    const { macrotask } = await import('../budget');
    // A long microtask chain started BEFORE the yield. A microtask-based
    // "yield" would resolve in the middle of it; a macrotask runs only after
    // the whole chain (every queued microtask) has drained.
    let depth = 0;
    const chain = (n) => (n === 0 ? Promise.resolve() : Promise.resolve().then(() => { depth += 1; return chain(n - 1); }));
    const running = chain(2000);
    await macrotask();
    expect(depth).toBe(2000);
    await running;

    // For contrast: awaiting a resolved Promise lets almost none of it run.
    depth = 0;
    const again = chain(2000);
    await Promise.resolve();
    expect(depth).toBeLessThan(10);
    await again;
  });
});
