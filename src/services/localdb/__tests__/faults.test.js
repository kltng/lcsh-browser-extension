/**
 * SPEC-P5 §21: the fault-injection test build. Every supported point/mode pair
 * is exercised at its REAL call site, through the real client, the real
 * dispatcher, the real installer and the real settings bridge
 * (`commitLocalDb` over the fake chrome.storage). Only the pool, the network
 * and the worker thread boundary are faked.
 *
 * Vitest defines `__LCSH_FAULTS__` as true (vitest.config.js); the shipped
 * definitions are checked in faultsConfig.test.js.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLocalDbClient, RECOVERY_OPERATION } from '../client';
import { createWorkerDispatcher } from '../worker';
import { createInstaller } from '../install';
import {
  parseFaultPlan, createDocumentFaults, createWorkerFaults, IMPORT_FAULT_AFTER_BYTES, WORKER_FAULT_POINTS
} from '../faults';
import { sha256Hex } from '../sha256';
import { createFakePool, bodyStream, pointerFor } from '../../../../test/localdbFakes';
import { fakes } from '../../../../test/setup';

const PAGE = 4096;
const PROBE_MS = 20;
const OLD_FILE = '/db-1.db';

const bytesOf = (n, seed = 1) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
};
const OLD_BYTES = bytesOf(2 * PAGE, 7);
const OLD_RECORD = {
  profile: 'core', release: '2026.09.26.1', releaseCommit: 'a'.repeat(40), file: OLD_FILE,
  dbSize: OLD_BYTES.length, sha256Db: sha256Hex(OLD_BYTES), compatFingerprint: 'FP', installedAt: '2026-09-27T00:00:00.000Z'
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitFor = async (condition, { timeout = 10000, what = 'condition' } = {}) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

/**
 * One app document: the page client with its fault state, and workers that
 * run the real dispatcher over ONE shared fake pool (the OPFS of the profile).
 * Messages cross the thread boundary asynchronously and structured-cloned.
 * A `crash` sets `closed`: the worker then neither sends nor receives, like
 * `self.close()`. Termination releases that worker's open handles.
 */
const world = async ({
  search = '', record = OLD_RECORD, pending = [], files = [], hangMs = 600, onClaim = () => {}
} = {}) => {
  const logs = [];
  const warnings = [];
  const faults = createDocumentFaults({ search, log: (...args) => logs.push(args), warn: (text) => warnings.push(text) });
  const claims = [];
  const answerClaim = faults.answerClaim;
  // Every claim the page answers, with a snapshot taken AT that moment.
  faults.answerClaim = (message, valid) => {
    const answer = answerClaim(message, valid);
    const w = workers[workers.length - 1];
    claims.push({
      message,
      answer,
      worker: w.index,
      postedBefore: w.posted.length,
      eventsBefore: pool.events.length,
      storageSetsBefore: fakes.storage.calls.set.length,
      importedBytes: importLog.processed,
      installer: w.installer
        ? { record: w.installer.record(), handle: w.installer.handle()?.name ?? null, gated: w.installer.isGated(), state: w.installer.state() }
        : null
    });
    // Runs before the acknowledgement leaves the page.
    onClaim(message, answer);
    return answer;
  };

  fakes.storage.seed({ lookupBackend: 'local-db', localDb: record, localDbPendingDeletes: pending });
  const pool = createFakePool();
  if (record?.file === OLD_FILE) pool.put(OLD_FILE, OLD_BYTES);
  for (const name of files) pool.put(name, bytesOf(PAGE, 3));

  // The importer behaves like sqlite-wasm's importDbChunked: it writes each
  // chunk before asking for the next, and when the callback throws it
  // disassociates the handle (no file stays under the name) and rethrows.
  const importLog = { processed: 0 };
  pool.importDb = vi.fn(async (name, pull) => {
    const parts = [];
    importLog.processed = 0;
    try {
      for (;;) {
        const chunk = await pull();
        if (chunk === undefined) break;
        parts.push(chunk);
        importLog.processed += chunk.length;
      }
    } catch (err) {
      pool.events.push({ op: 'import-failed', name, error: { name: err?.name, message: err?.message }, processed: importLog.processed });
      pool.files.delete(name);
      throw err;
    }
    const merged = new Uint8Array(importLog.processed);
    let at = 0;
    for (const part of parts) {
      merged.set(part, at);
      at += part.length;
    }
    pool.events.push({ op: 'import', name });
    pool.put(name, merged);
  });

  const workers = [];
  const createWorker = () => {
    const listeners = new Set();
    const w = { index: workers.length + 1, closed: false, terminated: false, posted: [], received: [], handles: new Set(), installer: null };
    const alive = () => !w.closed && !w.terminated;
    const workerPool = {
      ...pool,
      listFiles: (...args) => pool.listFiles(...args),
      importDb: (...args) => pool.importDb(...args),
      unlink: (...args) => pool.unlink(...args),
      open: async (name, opts) => {
        const handle = await pool.open(name, opts);
        w.handles.add(handle);
        const close = handle.close;
        handle.close = async () => {
          await close();
          w.handles.delete(handle);
        };
        return handle;
      }
    };
    const dispatcher = createWorkerDispatcher({
      post: (message) => {
        if (!alive()) return;
        w.posted.push(message);
        setTimeout(() => {
          if (!w.terminated) listeners.forEach((fn) => fn({ data: structuredClone(message) }));
        }, 0);
      },
      createPool: async () => workerPool,
      createInstallerImpl: (deps, hooks) => {
        w.installer = createInstaller(deps, hooks);
        return w.installer;
      },
      yieldToMacrotask: () => new Promise((resolve) => { setTimeout(resolve, 0); })
    }, {
      close: () => {
        w.closed = true;
        pool.events.push({ op: 'worker-closed', worker: w.index, at: Date.now() });
      }
    });
    w.worker = {
      addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
      postMessage: (message) => {
        w.received.push(message);
        setTimeout(() => { if (alive()) dispatcher.handleMessage(structuredClone(message)); }, 0);
      },
      terminate: () => {
        w.terminated = true;
        pool.events.push({ op: 'terminated', worker: w.index, at: Date.now() });
        for (const handle of [...w.handles]) handle.close().catch(() => {});
      }
    };
    workers.push(w);
    return w.worker;
  };

  const client = createLocalDbClient({ createWorker, hangMs, probeMs: PROBE_MS }, faults);
  await client.start();

  const resultOf = (w, op) => {
    const rpc = w.received.find((m) => m.type === 'rpc' && m.op === op);
    return rpc ? w.posted.find((m) => m.type === 'rpc-result' && m.id === rpc.id) : undefined;
  };
  return {
    client, faults, pool, workers, logs, warnings, claims, importLog,
    storage: () => fakes.storage.dump(),
    localDbWrites: () => fakes.storage.calls.set.filter((items) => Object.hasOwn(items, 'localDb')),
    resultOf,
    /** Start an install of `bytes` from a pointer, through the client. */
    install(bytes = bytesOf(2 * PAGE, 11), operationId = 'op1') {
      const { gz, ...pointer } = pointerFor({ profile: 'core', bytes, sha256Hex });
      globalThis.fetch = vi.fn(async () => ({ status: 200, body: bodyStream(gz) }));
      const done = client.install({ pointer, profile: 'core', operationId });
      done.catch(() => {});
      return done;
    },
    uninstall(operationId = 'u1') {
      const done = client.uninstall({ operationId });
      done.catch(() => {});
      return done;
    },
    stagingName: () => pool.events.find((e) => e.op === 'import' || e.op === 'import-failed')?.name
      ?? workers.flatMap((w) => w.posted).find((m) => m.type === 'bridge' && m.patch?.localDb)?.patch.localDb.file
  };
};

/**
 * Everything a worker did after the page answered its claim. `postedBefore`
 * was taken when the page answered, so the claim itself is already counted.
 */
const afterClaim = (env, claim) => {
  const w = env.workers[claim.worker - 1];
  // A `status` probe that was queued before the acknowledgement arrived may
  // still be answered; it is not part of the invoking operation.
  const statusIds = new Set(w.received.filter((m) => m.type === 'rpc' && m.op === 'status').map((m) => m.id));
  return {
    posted: w.posted.slice(claim.postedBefore).filter((m) => !(m.type === 'rpc-result' && statusIds.has(m.id))),
    events: env.pool.events.slice(claim.eventsBefore)
  };
};

/**
 * The common §21 crash contract: the invoking operation sends NOTHING more,
 * cleans up nothing before replacement, and only the existing watchdog
 * replaces the worker (not the hook).
 */
const expectSilentCrashThenWatchdog = async (env, claim, { hangMs = 600 } = {}) => {
  await waitFor(() => env.workers[0].closed, { what: 'the crash' });
  // The hook only closed the worker: the client still holds the first one.
  expect(env.client.workerStarts()).toBe(1);
  expect(env.workers[0].terminated).toBe(false);
  // The watchdog: no status answer and no progress for hangMs.
  await waitFor(() => env.client.workerStarts() === 2, { what: 'the replacement' });
  // The crashed operation sent nothing after the acknowledgement.
  expect(afterClaim(env, claim).posted).toEqual([]);
  // Between the crash and the termination nothing was cleaned up, and the
  // termination came only after a full hang window of silence.
  const events = env.pool.events.slice(claim.eventsBefore);
  const closedAt = events.findIndex((e) => e.op === 'worker-closed');
  const terminatedAt = events.findIndex((e) => e.op === 'terminated' && e.worker === 1);
  expect(closedAt).toBe(0);
  expect(terminatedAt).toBe(1);
  // The last liveness sign precedes the crash a little (a probe interval, or
  // more on a loaded machine), so the bound is loose but far from immediate.
  expect(events[terminatedAt].at - events[closedAt].at).toBeGreaterThanOrEqual(hangMs / 2);
  // The client keeps its last state until the replacement's recovery answers.
  await waitFor(() => env.resultOf(env.workers[1], 'recover'), { what: 'the replacement recovery' });
  await sleep(20);
};

describe('[P5 §21] the fault plan', () => {
  it('parses every supported pair; occurrence numbers only for delete, default 1', () => {
    const warnings = [];
    const plan = parseFaultPlan(
      '?faults=import-write:crash,commit-before:throw,commit-lost:throw,delete@3:throw,after-switch:crash,settings-write:throw',
      (text) => warnings.push(text)
    );
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(plan)).toEqual({
      'import-write': { mode: 'crash', occurrence: 1 },
      'commit-before': { mode: 'throw', occurrence: 1 },
      'commit-lost': { mode: 'throw', occurrence: 1 },
      delete: { mode: 'throw', occurrence: 3 },
      'after-switch': { mode: 'crash', occurrence: 1 },
      'settings-write': { mode: 'throw', occurrence: 1 }
    });
    expect(parseFaultPlan('?faults=delete:crash').get('delete')).toEqual({ mode: 'crash', occurrence: 1 });
    expect(parseFaultPlan('').size).toBe(0);
    expect(parseFaultPlan('?other=1').size).toBe(0);
  });

  it('ignores, with a warning, unknown points, unsupported modes, bad occurrences and duplicates', () => {
    const warnings = [];
    const plan = parseFaultPlan(
      '?faults=nope:throw,after-switch:throw,settings-write:crash,commit-lost@2:throw,delete@0:throw,delete@x:throw,'
      + 'delete@-1:throw,delete@:throw,commit-before:throw,commit-before:crash,garbage',
      (text) => warnings.push(text)
    );
    expect(Object.fromEntries(plan)).toEqual({ 'commit-before': { mode: 'throw', occurrence: 1 } });
    expect(warnings).toHaveLength(10);
    expect(warnings.join('\n')).toMatch(/unknown point/);
    expect(warnings.join('\n')).toMatch(/unsupported mode/);
    expect(warnings.join('\n')).toMatch(/invalid occurrence number/);
    expect(warnings.join('\n')).toMatch(/duplicate entry for commit-before/);
  });

  // Review-5 finding 3: the converted value is checked, not only its spelling.
  it('an occurrence that is not a safe positive integer after conversion is ignored with the warning', () => {
    for (const digits of ['9'.repeat(400), '9007199254740993', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const warnings = [];
      const plan = parseFaultPlan(`?faults=delete@${digits}:throw`, (text) => warnings.push(text));
      expect(plan.has('delete'), digits.slice(0, 20)).toBe(false);
      expect(warnings).toEqual([`[fault] ignored "delete@${digits}:throw": invalid occurrence number`]);
    }
    // The largest safe value is still accepted exactly.
    const max = String(Number.MAX_SAFE_INTEGER);
    expect(parseFaultPlan(`?faults=delete@${max}:throw`).get('delete')).toEqual({ mode: 'throw', occurrence: Number.MAX_SAFE_INTEGER });
  });

  it('the page sends only unconsumed WORKER points, and a consumed point never fires again', () => {
    const logs = [];
    const faults = createDocumentFaults({ search: '?faults=commit-before:crash,settings-write:throw', log: (...a) => logs.push(a), warn: () => {} });
    expect(faults.workerPlan()).toEqual({ points: [{ point: 'commit-before', mode: 'crash' }] });
    const claim = { type: 'fault-claim', claimId: 'f1', point: 'commit-before', workerGeneration: 3, operationId: 'op1' };
    // A claim from a stale generation consumes nothing.
    expect(faults.answerClaim(claim, false)).toMatchObject({ fire: false, spent: false });
    expect(faults.consumed()).toEqual([]);
    expect(faults.answerClaim(claim, true)).toMatchObject({ claimId: 'f1', fire: true, spent: true });
    expect(faults.answerClaim({ ...claim, claimId: 'f2', workerGeneration: 5 }, true)).toMatchObject({ fire: false, spent: true });
    expect(faults.workerPlan()).toBeNull();
    // A worker can never consume the page-side point.
    expect(faults.answerClaim({ ...claim, point: 'settings-write' }, true).fire).toBe(false);
    expect(faults.consumed()).toEqual(['commit-before']);
    expect(logs).toEqual([['[fault] commit-before:crash', { operation: 'op1', workerGeneration: 3 }]]);
  });

  it('delete@N counts eligible attempts across worker generations', () => {
    const logs = [];
    const faults = createDocumentFaults({ search: '?faults=delete@3:throw', log: (...a) => logs.push(a), warn: () => {} });
    const ask = (n, generation) => faults.answerClaim({
      type: 'fault-claim', claimId: `f${n}`, point: 'delete', workerGeneration: generation, operationId: 'op', file: `/f${n}.db`
    }, true);
    expect(ask(1, 1)).toMatchObject({ fire: false, spent: false });
    expect(ask(2, 3)).toMatchObject({ fire: false, spent: false });
    expect(ask(3, 3)).toMatchObject({ fire: true, spent: true });
    expect(ask(4, 3)).toMatchObject({ fire: false, spent: true });
    expect(logs).toEqual([['[fault] delete:throw', { operation: 'op', workerGeneration: 3, file: '/f3.db', occurrence: 3 }]]);
  });

  it('the worker never injects a point that is unsupported or absent from its plan', async () => {
    const posted = [];
    const close = vi.fn();
    const hooks = createWorkerFaults({
      plan: { points: [{ point: 'after-switch', mode: 'throw' }, { point: 'settings-write', mode: 'throw' }, { point: 'commit-lost', mode: 'throw' }] },
      workerGeneration: 1,
      post: (m) => posted.push(m),
      close
    });
    expect(WORKER_FAULT_POINTS.filter((p) => hooks.armed(p))).toEqual(['commit-lost']);
    await hooks.fire('after-switch', {});
    await hooks.fire('settings-write', {});
    expect(posted).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('[P5 §21] an empty plan is inert', () => {
  it('no fault field in acquire, no claim, no log, and a full update install behaves as without hooks', async () => {
    const env = await world({ search: '' });
    expect(env.client.state()).toBe('ready');
    const acquire = env.workers[0].received.find((m) => m.type === 'rpc' && m.op === 'acquire');
    expect(acquire.args).toEqual({});
    const result = await env.install();
    expect(result).toMatchObject({ status: 'installed', cleanupPending: false });
    expect(env.workers.flatMap((w) => w.posted).some((m) => m.type === 'fault-claim')).toBe(false);
    expect(env.logs).toEqual([]);
    expect(env.warnings).toEqual([]);
    expect(env.pool.files.has(OLD_FILE)).toBe(false);
    env.client.dispose();
  });

  it('a plan of only unsupported pairs is inert too, with warnings', async () => {
    const env = await world({ search: '?faults=after-switch:throw,settings-write:crash,import-write@2:throw' });
    expect(env.warnings).toHaveLength(3);
    expect(env.workers[0].received.find((m) => m.op === 'acquire').args).toEqual({});
    expect(await env.install()).toMatchObject({ status: 'installed' });
    expect(env.claims).toEqual([]);
    expect(env.logs).toEqual([]);
    env.client.dispose();
  });
});

describe('[P5 §21] commit-before', () => {
  it('throw (install): before the commit request; the reread resolves it as NOT committed; §4.8 cleanup', async () => {
    const env = await world({ search: '?faults=commit-before:throw' });
    expect(env.workers[0].received.find((m) => m.op === 'acquire').args)
      .toEqual({ faults: { points: [{ point: 'commit-before', mode: 'throw' }] } });
    await expect(env.install()).rejects.toBeTruthy();
    const w = env.workers[0];
    const [claim] = env.claims;
    expect(claim.message).toMatchObject({ point: 'commit-before', operationId: 'op1', workerGeneration: env.client.workerGeneration() });
    // The commit point had been entered: committing, queries gated.
    expect(claim.installer.gated).toBe(true);
    const later = afterClaim(env, claim).posted;
    // No commit request was issued; the existing catch did its locked reread.
    expect(later.filter((m) => m.type === 'bridge' && m.action === 'commit' && m.patch.localDb)).toEqual([]);
    expect(later.find((m) => m.type === 'bridge')).toMatchObject({ action: 'read', operationId: 'op1' });
    expect(env.resultOf(w, 'install').error.kind).toBe('settings');
    // Not committed: the previous record stays; the staging file is gone.
    expect(env.localDbWrites()).toEqual([]);
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    expect([...env.pool.files.keys()]).toEqual([OLD_FILE]);
    expect(env.pool.events.some((e) => e.op === 'unlink' && e.name.startsWith('/stage-'))).toBe(true);
    expect(env.logs).toEqual([['[fault] commit-before:throw', { operation: 'op1', workerGeneration: claim.message.workerGeneration }]]);
    env.client.dispose();
  });

  it('throw (uninstall): not committed; the record stays and the file is reopened', async () => {
    const env = await world({ search: '?faults=commit-before:throw' });
    await expect(env.uninstall()).rejects.toBeTruthy();
    expect(env.claims[0].message).toMatchObject({ point: 'commit-before', operationId: 'u1' });
    expect(env.resultOf(env.workers[0], 'uninstall').error.kind).toBe('settings');
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    expect(env.client.state()).toBe('ready');
    expect(env.workers[0].installer.handle().name).toBe(OLD_FILE);
    env.client.dispose();
  });

  it('crash: silent loss before the request; the watchdog replaces the worker; recovery keeps the old record and deletes the orphan', async () => {
    const env = await world({ search: '?faults=commit-before:crash' });
    const done = env.install();
    await waitFor(() => env.claims.length === 1, { what: 'the claim' });
    const [claim] = env.claims;
    const staging = env.stagingName();
    expect(env.pool.files.has(staging)).toBe(true);
    await expectSilentCrashThenWatchdog(env, claim);
    await expect(done).rejects.toMatchObject({ kind: 'db_worker_failed' });
    // The replacement got no consumed point and ran the normal §3.4 recovery.
    expect(env.workers[1].received.find((m) => m.op === 'acquire').args).toEqual({});
    expect(env.workers[1].received.find((m) => m.op === 'recover').args).toEqual({ operationId: RECOVERY_OPERATION });
    expect(env.client.state()).toBe('ready');
    expect(env.client.record()).toEqual(OLD_RECORD);
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    // Never promoted; deleted by recovery as a non-active file.
    expect(env.pool.files.has(staging)).toBe(false);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    // One-shot: a later install in the same document is fault-free.
    expect(await env.install(bytesOf(2 * PAGE, 13), 'op2')).toMatchObject({ status: 'installed' });
    expect(env.logs).toHaveLength(1);
    env.client.dispose();
  });
});

describe('[P5 §21] commit-lost', () => {
  it('throw: the REAL write succeeded first; the normal locked reread resolves it as committed; install continues', async () => {
    const env = await world({ search: '?faults=commit-lost:throw' });
    const result = await env.install();
    const [claim] = env.claims;
    const w = env.workers[0];
    // The settings write had already happened when the fault was claimed.
    expect(claim.storageSetsBefore).toBeGreaterThan(0);
    const staging = env.localDbWrites()[0].localDb.file;
    expect(fakes.storage.calls.set.slice(0, claim.storageSetsBefore).some((s) => s.localDb?.file === staging)).toBe(true);
    // The successful answer reached the worker before the claim.
    const commit = w.posted.slice(0, claim.postedBefore).find((m) => m.type === 'bridge' && m.action === 'commit' && m.patch.localDb);
    expect(commit.patch.localDb.file).toBe(staging);
    expect(w.received.find((m) => m.type === 'bridge-result' && m.bridgeId === commit.bridgeId)).toMatchObject({ ok: true });
    // The existing catch performed the reread.
    const later = afterClaim(env, claim).posted;
    expect(later.find((m) => m.type === 'bridge')).toMatchObject({ action: 'read', operationId: 'op1' });
    // Committed: switch and retirement ran; the committed file never went to staging cleanup.
    expect(result).toMatchObject({ status: 'installed', cleanupPending: false, record: { file: staging } });
    expect(env.pool.files.has(staging)).toBe(true);
    expect(env.pool.files.has(OLD_FILE)).toBe(false);
    expect(env.pool.events.filter((e) => e.op === 'unlink').map((e) => e.name)).toEqual([OLD_FILE]);
    expect(w.posted.some((m) => m.type === 'bridge' && m.patch?.pendingDeletesAdd?.includes(staging))).toBe(false);
    expect(env.storage().localDb.file).toBe(staging);
    expect(env.storage().localDbPendingDeletes).toEqual([]);
    env.client.dispose();
  });

  it('throw: an UNREADABLE reread follows the existing unresolved path (files kept, no local queries)', async () => {
    // The next settings read after the claim (the reconciliation read) fails.
    const env = await world({
      search: '?faults=commit-lost:throw',
      onClaim: () => fakes.storage.failNext('get', new Error('unreadable'))
    });
    const done = env.install();
    expect(await done).toMatchObject({ status: 'recovery-unavailable' });
    const staging = env.localDbWrites()[0].localDb.file;
    expect(env.pool.files.has(staging)).toBe(true);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    expect(env.pool.events.some((e) => e.op === 'unlink')).toBe(false);
    await waitFor(() => env.client.state() === 'recovery-unavailable', { what: 'the state' });
    env.client.dispose();
  });

  it('crash: written, then lost; no reconciliation read; replacement recovery follows the authoritative settings', async () => {
    const env = await world({ search: '?faults=commit-lost:crash' });
    const done = env.install();
    await waitFor(() => env.claims.length === 1, { what: 'the claim' });
    const [claim] = env.claims;
    const staging = env.localDbWrites()[0].localDb.file;
    expect(claim.storageSetsBefore).toBeGreaterThan(0);
    await expectSilentCrashThenWatchdog(env, claim);
    await expect(done).rejects.toMatchObject({ kind: 'db_worker_failed' });
    // The crashed worker sent no read after the claim (checked above: nothing at all).
    expect(afterClaim(env, claim).posted.filter((m) => m.type === 'bridge')).toEqual([]);
    // The replacement read the settings: the new record is authoritative.
    expect(env.workers[1].posted.find((m) => m.type === 'bridge')).toMatchObject({ action: 'read', operationId: RECOVERY_OPERATION });
    expect(env.client.state()).toBe('ready');
    expect(env.client.record().file).toBe(staging);
    expect(env.pool.files.has(staging)).toBe(true);
    // The old file was pending under the written record and recovery deleted it.
    expect(env.pool.files.has(OLD_FILE)).toBe(false);
    expect(env.storage().localDbPendingDeletes).toEqual([]);
    expect(env.pool.events.filter((e) => e.op === 'unlink').map((e) => e.name)).toEqual([OLD_FILE]);
    env.client.dispose();
  });
});

describe('[P5 §21] after-switch', () => {
  it('crash: the active handle had changed and retirement had not begun; recovery retires the old file', async () => {
    const env = await world({ search: '?faults=after-switch:crash' });
    const done = env.install();
    await waitFor(() => env.claims.length === 1, { what: 'the claim' });
    const [claim] = env.claims;
    const staging = env.localDbWrites()[0].localDb.file;
    // Switched: the new record and handle are active, the old handle closed, ungated.
    expect(claim.installer).toEqual({ record: expect.objectContaining({ file: staging }), handle: staging, gated: false, state: 'ready' });
    const before = env.pool.events.slice(0, claim.eventsBefore);
    expect(before.some((e) => e.op === 'close' && e.name === OLD_FILE)).toBe(true);
    // Retirement not begun: no unlink, no cleaning phase.
    expect(before.some((e) => e.op === 'unlink')).toBe(false);
    expect(env.workers[0].posted.some((m) => m.type === 'phase' && m.phase === 'cleaning')).toBe(false);
    await expectSilentCrashThenWatchdog(env, claim);
    await expect(done).rejects.toMatchObject({ kind: 'db_worker_failed' });
    expect(env.client.state()).toBe('ready');
    expect(env.client.record().file).toBe(staging);
    expect(env.pool.files.has(OLD_FILE)).toBe(false);
    expect(env.pool.files.has(staging)).toBe(true);
    env.client.dispose();
  });
});

describe('[P5 §21] delete', () => {
  it('throw (retirement): no rollback of the committed install; the old file stays pending', async () => {
    const env = await world({ search: '?faults=delete:throw' });
    const result = await env.install();
    const staging = result.record.file;
    expect(result).toMatchObject({ status: 'installed', cleanupPending: true });
    expect(env.claims[0].message).toMatchObject({ point: 'delete', file: OLD_FILE, operationId: 'op1' });
    // The fault replaced the pool call: the file was never unlinked.
    expect(env.pool.events.some((e) => e.op === 'unlink')).toBe(false);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    expect(env.storage().localDb.file).toBe(staging);
    expect(env.storage().localDbPendingDeletes).toEqual([OLD_FILE]);
    expect(env.logs).toEqual([['[fault] delete:throw', {
      operation: 'op1', workerGeneration: env.client.workerGeneration(), file: OLD_FILE, occurrence: 1
    }]]);
    env.client.dispose();
  });

  it('throw @2 (startup recovery): the SECOND eligible attempt fails, the others are unchanged', async () => {
    const env = await world({ search: '?faults=delete@2:throw', files: ['/stage-core-a.db', '/stage-core-b.db'] });
    expect(env.client.state()).toBe('ready');
    expect(env.claims.map((c) => [c.message.file, c.answer.fire])).toEqual([['/stage-core-a.db', false], ['/stage-core-b.db', true]]);
    expect(env.pool.files.has('/stage-core-a.db')).toBe(false);
    expect(env.pool.files.has('/stage-core-b.db')).toBe(true);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    expect(env.logs[0][1]).toMatchObject({ operation: RECOVERY_OPERATION, file: '/stage-core-b.db', occurrence: 2 });
    env.client.dispose();
  });

  it('crash (retirement): after replacement the consumed point does not fire again and recovery deletes the file', async () => {
    const env = await world({ search: '?faults=delete:crash' });
    const done = env.install();
    await waitFor(() => env.claims.length === 1, { what: 'the claim' });
    const [claim] = env.claims;
    expect(claim.message).toMatchObject({ file: OLD_FILE, operationId: 'op1' });
    await expectSilentCrashThenWatchdog(env, claim);
    await expect(done).rejects.toMatchObject({ kind: 'db_worker_failed' });
    expect(env.workers[1].received.find((m) => m.op === 'acquire').args).toEqual({});
    expect(env.claims).toHaveLength(1);
    expect(env.client.state()).toBe('ready');
    expect(env.pool.files.has(OLD_FILE)).toBe(false);
    expect(env.storage().localDbPendingDeletes).toEqual([]);
    env.client.dispose();
  });
});

describe('[P5 §21] settings-write', () => {
  it('throw (install): the targeted write is NOT issued and the bridge returns write-failed; cleanup-only writes are untouched', async () => {
    // Recovery first commits a cleanup-only patch (an absent pending file).
    const env = await world({ search: '?faults=settings-write:throw', pending: ['/gone.db'] });
    expect(env.storage().localDbPendingDeletes).toEqual([]);
    expect(env.logs).toEqual([]);
    const setsBefore = fakes.storage.calls.set.length;
    await expect(env.install()).rejects.toBeTruthy();
    const w = env.workers[0];
    const commit = w.posted.find((m) => m.type === 'bridge' && m.action === 'commit' && m.patch.localDb);
    expect(w.received.find((m) => m.type === 'bridge-result' && m.bridgeId === commit.bridgeId))
      .toMatchObject({ ok: false, reason: 'write-failed' });
    expect(env.localDbWrites()).toEqual([]);
    expect(env.resultOf(w, 'install').error.kind).toBe('settings');
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    expect([...env.pool.files.keys()]).toEqual([OLD_FILE]);
    // Nothing else was written after the fault: the staging file was deleted, so no pending entry.
    expect(fakes.storage.calls.set.slice(setsBefore)).toEqual([]);
    expect(env.logs).toEqual([['[fault] settings-write:throw', { operation: 'op1', workerGeneration: env.client.workerGeneration() }]]);
    env.client.dispose();
  });

  it('throw (uninstall): the null record is not written; the installation stays', async () => {
    const env = await world({ search: '?faults=settings-write:throw' });
    await expect(env.uninstall()).rejects.toBeTruthy();
    expect(env.localDbWrites()).toEqual([]);
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    expect(env.pool.files.has(OLD_FILE)).toBe(true);
    expect(env.client.state()).toBe('ready');
    env.client.dispose();
  });
});

describe('[P5 §21] import-write (64 MiB)', () => {
  const BIG = IMPORT_FAULT_AFTER_BYTES + 256 * PAGE;
  const bigBytes = () => {
    const bytes = new Uint8Array(BIG);
    for (let i = 0; i < BIG; i += PAGE) bytes[i] = (i / PAGE) % 251;
    return bytes;
  };

  it('throw: QuotaExceededError inside the importer after >= 64 MiB; importer cleanup runs; storage error; §4.8', async () => {
    const env = await world({ search: '?faults=import-write:throw' });
    await expect(env.install(bigBytes())).rejects.toBeTruthy();
    const [claim] = env.claims;
    expect(claim.importedBytes).toBeGreaterThanOrEqual(IMPORT_FAULT_AFTER_BYTES);
    expect(claim.importedBytes).toBeLessThan(BIG);
    // The importer's own failure path ran with the injected DOMException.
    const failed = env.pool.events.find((e) => e.op === 'import-failed');
    expect(failed.error).toEqual({ name: 'QuotaExceededError', message: '[fault] import-write' });
    expect(failed.processed).toBe(claim.importedBytes);
    // Worker-side kind: InstallError('storage'); the page mapping is unchanged.
    expect(env.resultOf(env.workers[0], 'install').error.kind).toBe('storage');
    // §4.8: no commit; the staging name is deleted (idempotently); the old installation is unchanged.
    expect(env.workers[0].posted.some((m) => m.type === 'bridge' && m.action === 'commit')).toBe(false);
    expect(env.pool.events.some((e) => e.op === 'unlink' && e.name === failed.name)).toBe(true);
    expect([...env.pool.files.keys()]).toEqual([OLD_FILE]);
    expect(env.storage().localDb).toEqual(OLD_RECORD);
    env.client.dispose();
  }, 60000);

  it('crash: the suspended importer and install do no cleanup or completion; replacement recovers', async () => {
    const hangMs = 1500;
    const env = await world({ search: '?faults=import-write:crash', hangMs });
    const done = env.install(bigBytes());
    await waitFor(() => env.claims.length === 1, { what: 'the claim', timeout: 30000 });
    const [claim] = env.claims;
    expect(claim.importedBytes).toBeGreaterThanOrEqual(IMPORT_FAULT_AFTER_BYTES);
    await expectSilentCrashThenWatchdog(env, claim, { hangMs });
    await expect(done).rejects.toMatchObject({ kind: 'db_worker_failed' });
    // No importer failure path, no §4.8 cleanup by the crashed worker.
    expect(env.pool.events.some((e) => e.op === 'import-failed' || e.op === 'import')).toBe(false);
    expect(env.client.state()).toBe('ready');
    expect(env.client.record()).toEqual(OLD_RECORD);
    expect([...env.pool.files.keys()]).toEqual([OLD_FILE]);
    env.client.dispose();
  }, 60000);
});
