import { describe, it, expect, vi } from 'vitest';
import {
  createInstaller, InstallError, coalescingPull, stagingName, sameRecord, isAlreadyInstalled, MIN_FIRST_CHUNK
} from '../install';
import { hashStoredBytes, checkMeta, checkObjects, checkPageProduct, VerifyError, SQLITE_IOERR_SHORT_READ } from '../verify';
import { sha256Hex } from '../sha256';
import { createFakePool, createFakeBridge, bodyStream, gzip, pointerFor } from '../../../../test/localdbFakes';

const PROFILE = 'core';
const dbBytes = (n = 4096 * 3) => {
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
    { name: 'hierarchy', type: 'table' }, { name: 'auth_fts', type: 'table' }, { name: 'alt_label_fts', type: 'table' },
    { name: 'auth_fts_data', type: 'table' }, { name: 'sqlite_autoindex_auth_1', type: 'index' }
  ],
  pages: { pageSize: 4096, pageCount: bytes.length / 4096 },
  ...over
});

/** A complete installer environment; every part can be overridden per test. */
const setup = ({
  bytes = dbBytes(), pool: poolOpts = {}, settings = {}, behavior = {}, stream = {}, fetchImpl, describe: over
} = {}) => {
  const pointer = pointerFor({ profile: PROFILE, bytes, sha256Hex });
  const pool = createFakePool({
    describe: (name, imported) => describeDb(imported, over ? over(imported) : {}), ...poolOpts
  });
  const bridge = createFakeBridge({ settings, behavior });
  const events = [];
  const installer = createInstaller({
    pool,
    bridge,
    fetchImpl: fetchImpl || vi.fn(async () => ({ status: 200, body: bodyStream(pointer.gz, stream) })),
    random: (() => {
      let n = 0;
      return () => String(n++).padStart(8, '0');
    })(),
    now: () => 1790000000000,
    onProgress: (e) => events.push({ ...e, type: 'progress' }),
    onPhase: (e) => events.push({ ...e, type: 'phase' }),
    yieldToMacrotask: () => new Promise((resolve) => { setTimeout(resolve, 0); })
  });
  return { installer, pool, bridge, pointer, bytes, events, phases: () => events.filter((e) => e.type === 'phase').map((e) => e.phase) };
};

const installed = (over = {}) => ({
  profile: PROFILE, release: '2026.09.26.1', releaseCommit: 'b'.repeat(40), file: '/old.db',
  dbSize: 4096, sha256Db: 'c'.repeat(64), compatFingerprint: 'FP', installedAt: '2026-09-26T00:00:00.000Z', ...over
});

describe('[P5 row7] the first-chunk rule and the pull function', () => {
  const pullOf = (chunks) => {
    const list = [...chunks];
    return () => Promise.resolve(list.shift());
  };

  it('coalesces leading chunks until the first one is at least 512 bytes', async () => {
    for (const lead of [1, 7, 15, 511]) {
      const chunks = [new Uint8Array(lead), new Uint8Array(600), new Uint8Array(40)];
      const pull = coalescingPull(pullOf(chunks));
      const first = await pull();
      expect(first.length, `lead ${lead}`).toBe(lead + 600);
      expect((await pull()).length).toBe(40);
      expect(await pull()).toBeUndefined();
    }
  });

  it('a first chunk that is already big enough is passed through untouched', async () => {
    const big = new Uint8Array(MIN_FIRST_CHUNK);
    const pull = coalescingPull(pullOf([big, new Uint8Array(3)]));
    expect(await pull()).toBe(big);
  });

  it('drops empty chunks, before and after the first one', async () => {
    const pull = coalescingPull(pullOf([
      new Uint8Array(0), new Uint8Array(0), new Uint8Array(600), new Uint8Array(0), new Uint8Array(5)
    ]));
    expect((await pull()).length).toBe(600);
    expect((await pull()).length).toBe(5);
    expect(await pull()).toBeUndefined();
  });

  it('a body shorter than 512 bytes is still one chunk, and an empty body is none', async () => {
    expect((await coalescingPull(pullOf([new Uint8Array(3), new Uint8Array(4)]))()).length).toBe(7);
    expect(await coalescingPull(pullOf([]))()).toBeUndefined();
    expect(await coalescingPull(pullOf([new Uint8Array(0)]))()).toBeUndefined();
  });
});

describe('[P5 row7] staging names and record identity', () => {
  it('a name that collides with an existing pool file is regenerated', () => {
    let n = 0;
    const random = () => ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'][n++];
    const taken = ['/stage-core-2026.09.27.1-aaaaaaaa.db', '/stage-core-2026.09.27.1-bbbbbbbb.db'];
    expect(stagingName({ profile: 'core', release: '2026.09.27.1', taken, random }))
      .toBe('/stage-core-2026.09.27.1-cccccccc.db');
  });

  it('records compare structurally, null included', () => {
    expect(sameRecord(null, null)).toBe(true);
    expect(sameRecord(null, installed())).toBe(false);
    expect(sameRecord(installed(), { ...installed() })).toBe(true);
    expect(sameRecord(installed(), installed({ file: '/x.db' }))).toBe(false);
  });

  it('"already installed" needs the same profile, release, digest and fingerprint', () => {
    const wanted = { profile: 'core', release: '2026.09.26.1', sha256Db: 'c'.repeat(64), compatFingerprint: 'FP' };
    expect(isAlreadyInstalled(installed(), wanted)).toBe(true);
    expect(isAlreadyInstalled(installed(), { ...wanted, release: '2026.09.27.1' })).toBe(false);
    expect(isAlreadyInstalled(installed(), { ...wanted, sha256Db: 'd'.repeat(64) })).toBe(false);
    expect(isAlreadyInstalled(installed(), { ...wanted, compatFingerprint: 'OTHER' })).toBe(false);
    expect(isAlreadyInstalled(null, wanted)).toBe(false);
  });
});

describe('[P5 row7] a first install', () => {
  it('streams, verifies and commits, and the settings then name the staged file', async () => {
    const env = setup();
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('installed');
    expect(result.record.file).toBe('/stage-core-2026.09.27.1-00000000.db');
    expect(result.record.dbSize).toBe(env.bytes.length);
    expect(result.record.sha256Db).toBe(sha256Hex(env.bytes));
    expect(env.bridge.current.localDb).toEqual(result.record);
    expect(env.bridge.current.localDbPendingDeletes).toEqual([]);
    expect(env.installer.state()).toBe('ready');
    expect(env.phases()).toEqual(['downloading', 'verifying', 'committing', 'cleaning']);
    expect(env.installer.isGated()).toBe(false);
  });

  it('the first chunk given to the importer is at least 512 bytes even with tiny leading chunks', async () => {
    const env = setup({ stream: { leading: [1, 7, 15, 511], chunkSize: 64 } });
    await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    const imported = env.pool.events.find((e) => e.op === 'import');
    expect(imported.chunkSizes[0]).toBeGreaterThanOrEqual(MIN_FIRST_CHUNK);
    expect(imported.chunkSizes.every((n) => n > 0)).toBe(true);
  });

  it('progress is reported for both phases and never claims more than the pointer size', async () => {
    const env = setup({ stream: { chunkSize: 1024 } });
    await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    const progress = env.events.filter((e) => e.type === 'progress');
    expect(progress.some((p) => p.phase === 'downloading')).toBe(true);
    expect(progress.some((p) => p.phase === 'verifying')).toBe(true);
    for (const p of progress) expect(p.done).toBeLessThanOrEqual(p.total);
  });
});

describe('[P5 row7] a damaged or oversized download changes nothing', () => {
  /**
   * Every verification failure must leave the installation EXACTLY as it was:
   * the stored record, the stored bytes and the pending list are snapshotted
   * BEFORE the attempt and compared afterwards, and no activation write may
   * have been issued at all (review finding 12: the old assertion compared a
   * value with itself).
   */
  const fails = async (env, kind) => {
    const before = {
      record: JSON.parse(JSON.stringify(env.bridge.current.localDb)),
      pending: [...env.bridge.current.localDbPendingDeletes],
      files: [...env.pool.files.entries()].map(([name, entry]) => [name, sha256Hex(entry.bytes)])
    };
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind });
    expect(env.bridge.current.localDb).toEqual(before.record);
    expect(env.bridge.current.localDbPendingDeletes).toEqual(before.pending);
    expect([...env.pool.files.entries()].map(([name, entry]) => [name, sha256Hex(entry.bytes)])).toEqual(before.files);
    // No commit that would ACTIVATE anything was ever issued.
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
    expect([...env.pool.files.keys()].filter((n) => n.startsWith('/stage-'))).toEqual([]);
  };

  it('an installed database survives every verification failure unchanged', async () => {
    const bytes = dbBytes(4096);
    for (const damage of [
      (p) => { p.sha256Gz = 'f'.repeat(64); },
      (p) => { p.sha256Db = 'f'.repeat(64); },
      (p) => { p.dbSize += 4096; },
      (p) => { p.gzSize = 10; }
    ]) {
      const env = setup({ settings: { localDb: installed() } });
      env.pool.put('/old.db', bytes, describeDb(bytes));
      damage(env.pointer.profiles[PROFILE]);
      await fails(env, 'damaged');
      expect(env.bridge.current.localDb).toEqual(installed());
      expect(sha256Hex(env.pool.files.get('/old.db').bytes)).toBe(sha256Hex(bytes));
    }
  });

  it('a SHORT WRITE with an installed database also changes nothing', async () => {
    const bytes = dbBytes(4096);
    const env = setup({ settings: { localDb: installed() }, pool: { shortWrite: 4096 } });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toBeInstanceOf(VerifyError);
    expect(env.bridge.current.localDb).toEqual(installed());
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
    expect(sha256Hex(env.pool.files.get('/old.db').bytes)).toBe(sha256Hex(bytes));
  });

  it('a wrong gz digest is rejected and the staging file is deleted', async () => {
    const env = setup();
    env.pointer.profiles[PROFILE].sha256Gz = 'f'.repeat(64);
    await fails(env, 'damaged');
  });

  it('a wrong db digest is rejected', async () => {
    const env = setup();
    env.pointer.profiles[PROFILE].sha256Db = 'f'.repeat(64);
    await fails(env, 'damaged');
  });

  it('a wrong size is rejected', async () => {
    const env = setup();
    env.pointer.profiles[PROFILE].dbSize = env.bytes.length + 4096;
    await fails(env, 'damaged');
  });

  it('a body larger than gz_size aborts as soon as the count is exceeded', async () => {
    const env = setup();
    env.pointer.profiles[PROFILE].gzSize = 10;
    await fails(env, 'damaged');
  });

  it('a truncated gzip body fails', async () => {
    const bytes = dbBytes();
    const pointer = pointerFor({ profile: PROFILE, bytes, sha256Hex });
    const env = setup({ fetchImpl: vi.fn(async () => ({ status: 200, body: bodyStream(pointer.gz.slice(0, 20)) })) });
    env.pointer = pointer;
    // SPEC-P5 v2.7 §4.4 step 4: the body ended normally, so this is `damaged`.
    await expect(env.installer.install({ pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ name: 'InstallError', kind: 'damaged' });
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  // Live finding (lead, fix 9, §13 row 8): one flipped byte in the real gzip
  // showed "Check your connection" (kind `network`).
  describe('[P5 fix9] a gzip decoding failure is damaged, a body failure is network (§4.4 step 4)', () => {
    const bytes = dbBytes();
    const pointer = pointerFor({ profile: PROFILE, bytes, sha256Hex });
    const installWith = (body) => {
      const env = setup({ fetchImpl: vi.fn(async () => ({ status: 200, body })) });
      env.pointer = pointer;
      return { env, done: env.installer.install({ pointer, profile: PROFILE, operationId: 'op1' }) };
    };
    const flipped = (at) => {
      const gz = Uint8Array.from(pointer.gz);
      gz[at] ^= 0xff;
      return gz;
    };

    it('(a) an invalid gzip body that the fetch delivers COMPLETELY is damaged', async () => {
      // A broken header, and a flipped byte in the CRC-32 trailer (the decoder's own check).
      for (const gz of [flipped(0), flipped(pointer.gz.length - 6)]) {
        const { env, done } = installWith(bodyStream(gz, { chunkSize: 64 }));
        await expect(done).rejects.toMatchObject({ name: 'InstallError', kind: 'damaged' });
        expect([...env.pool.files.keys()]).toEqual([]);
        expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
      }
    });

    it('(b) a truncated gzip body that ENDS NORMALLY is damaged', async () => {
      for (const length of [20, Math.floor(pointer.gz.length / 2), pointer.gz.length - 1]) {
        const { env, done } = installWith(bodyStream(pointer.gz.slice(0, length), { chunkSize: 64 }));
        await expect(done, String(length)).rejects.toMatchObject({ name: 'InstallError', kind: 'damaged' });
        expect([...env.pool.files.keys()]).toEqual([]);
      }
    });

    it('(c) a body stream that ERRORS mid-download is network', async () => {
      const half = pointer.gz.slice(0, Math.floor(pointer.gz.length / 2));
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(half);
            return;
          }
          controller.error(new TypeError('network error'));
        }
      });
      const { env, done } = installWith(body);
      await expect(done).rejects.toMatchObject({ name: 'InstallError', kind: 'network' });
      expect([...env.pool.files.keys()]).toEqual([]);
    });

    it('(c) a body that errors before its first byte is network as well', async () => {
      const body = new ReadableStream({ pull(controller) { controller.error(new TypeError('connection reset')); } });
      const { done } = installWith(body);
      await expect(done).rejects.toMatchObject({ kind: 'network' });
    });
  });

  it('a non-200 answer is a network failure and nothing is staged', async () => {
    const env = setup({ fetchImpl: vi.fn(async () => ({ status: 403, body: bodyStream(new Uint8Array(0)) })) });
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'network' });
    expect(env.pool.importDb).not.toHaveBeenCalled();
  });

  it('SHORT WRITE: the stream hashes pass, the stored bytes do not', async () => {
    const env = setup({ pool: { shortWrite: 4096 } });
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toBeInstanceOf(VerifyError);
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('db_meta of the wrong profile, or a missing object, is rejected after the byte check', async () => {
    const wrongProfile = setup({ describe: () => ({ meta: { profile: 'full', schema_version: '2', normalize_version: 'NORMALIZE_V1', lh_format: 'LH1', compat_fingerprint: 'FP' } }) });
    await expect(wrongProfile.installer.install({ pointer: wrongProfile.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ detail: 'db_meta.profile' });

    const missing = setup({ describe: () => ({ objects: [{ name: 'auth', type: 'table' }] }) });
    await expect(missing.installer.install({ pointer: missing.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ detail: 'missing:db_meta' });
  });
});

describe('[P5 row7] the stored-byte reader against a fake VFS', () => {
  const bytes = dbBytes(4096 * 4);
  const goodVfs = () => ({
    fileSize: async () => bytes.length,
    read: async (buffer, offset, length) => {
      buffer.set(bytes.subarray(offset, offset + length));
      return 0;
    }
  });

  it('hashes the stored bytes in batches and yields between them', async () => {
    const batches = [];
    const hash = await hashStoredBytes(goodVfs(), {
      size: bytes.length, bufferBytes: 4096, onBatch: (done, total) => batches.push([done, total])
    });
    expect(hash).toBe(sha256Hex(bytes));
    expect(batches).toEqual([[4096, 16384], [8192, 16384], [12288, 16384], [16384, 16384]]);
  });

  it('a short read is a failure, not a success', async () => {
    const vfs = { ...goodVfs(), read: async () => SQLITE_IOERR_SHORT_READ };
    await expect(hashStoredBytes(vfs, { size: bytes.length })).rejects.toMatchObject({ detail: 'read-rc-522' });
  });

  it('any other error code is a failure', async () => {
    const vfs = { ...goodVfs(), read: async () => 10 };
    await expect(hashStoredBytes(vfs, { size: bytes.length })).rejects.toMatchObject({ detail: 'read-rc-10' });
  });

  it('a wrong xFileSize is a failure before any read', async () => {
    const read = vi.fn(async () => 0);
    await expect(hashStoredBytes({ fileSize: async () => bytes.length - 1, read }, { size: bytes.length }))
      .rejects.toMatchObject({ detail: 'file-size' });
    expect(read).not.toHaveBeenCalled();
  });

  it('the batch hook can stop the check (the worker cancels there)', async () => {
    const stop = new Error('stop');
    await expect(hashStoredBytes(goodVfs(), {
      size: bytes.length,
      bufferBytes: 4096,
      onBatch: (done) => { if (done >= 8192) throw stop; }
    })).rejects.toBe(stop);
  });

  it('page_count × page_size must equal db_size', () => {
    expect(() => checkPageProduct({ pageSize: 4096, pageCount: 4 }, 16384)).not.toThrow();
    expect(() => checkPageProduct({ pageSize: 4096, pageCount: 3 }, 16384)).toThrow(VerifyError);
    expect(() => checkPageProduct({ pageSize: null, pageCount: 4 }, 16384)).toThrow(VerifyError);
  });

  it('sqlite_master may hold the six named objects, FTS shadow tables and indexes, nothing else', () => {
    const base = describeDb(bytes).objects;
    expect(() => checkObjects(base)).not.toThrow();
    expect(() => checkObjects([...base, { name: 'alt_label_fts_docsize', type: 'table' }])).not.toThrow();
    expect(() => checkObjects([...base, { name: 'sqlite_stat1', type: 'table' }])).not.toThrow();
    expect(() => checkObjects([...base, { name: 'secrets', type: 'table' }])).toThrow(VerifyError);
    expect(() => checkObjects([...base, { name: 'do_evil', type: 'trigger' }])).toThrow(VerifyError);
  });

  it('db_meta must match the SELECTED profile and this format', () => {
    const meta = describeDb(bytes).meta;
    expect(() => checkMeta(meta, { profile: 'core', compatFingerprint: 'FP' })).not.toThrow();
    expect(() => checkMeta(meta, { profile: 'full', compatFingerprint: 'FP' })).toThrow(VerifyError);
    expect(() => checkMeta(meta, { profile: 'core', compatFingerprint: 'OTHER' })).toThrow(VerifyError);
    expect(() => checkMeta({ ...meta, lh_format: 'LH2' }, { profile: 'core', compatFingerprint: 'FP' })).toThrow(VerifyError);
    expect(() => checkMeta({ ...meta, schema_version: 2 }, { profile: 'core', compatFingerprint: 'FP' })).toThrow(VerifyError);
  });
});

describe('[P5 row7] one mutation at a time, and cancel', () => {
  it('a second mutation while one runs is refused', async () => {
    const env = setup({ stream: { chunkSize: 256 } });
    const first = env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    await expect(env.installer.uninstall({ operationId: 'op2' })).rejects.toMatchObject({ kind: 'busy' });
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op2' }))
      .rejects.toMatchObject({ kind: 'busy' });
    await expect(env.installer.recover()).rejects.toMatchObject({ kind: 'busy' });
    await first;
  });

  it('cancel during the import stops at the next pull and deletes the staging file', async () => {
    let installer;
    const env = setup({
      stream: {
        chunkSize: 128,
        onChunk: (piece, at) => { if (at > 256) installer.cancel('op1'); }
      }
    });
    installer = env.installer;
    await expect(installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'cancelled' });
    expect([...env.pool.files.keys()]).toEqual([]);
    expect(env.bridge.commits.filter((c) => Object.hasOwn(c.patch, 'localDb'))).toEqual([]);
  });

  it('cancel during the stored-byte check stops it before any commit', async () => {
    const env = setup();
    // Every clock read "costs" 200 ms, so every budget check yields a macrotask.
    let clock = 0;
    const installer = createInstaller({
      pool: env.pool,
      bridge: env.bridge,
      fetchImpl: async () => ({ status: 200, body: bodyStream(env.pointer.gz) }),
      random: () => 'aaaaaaaa',
      monotonicNow: () => { clock += 200; return clock; },
      verifyBatchBytes: 4096,
      // The worker serves `cancel` in the yield; cancel only once verifying.
      yieldToMacrotask: async () => {
        if (installer.operation()?.phase === 'verifying') installer.cancel('op1');
      }
    });
    await expect(installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'cancelled' });
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('cancel is REFUSED once the install is committing, and the commit still happens', async () => {
    const env = setup();
    let refusal = null;
    env.bridge.commit.mockImplementation(async ({ patch }) => {
      try {
        env.installer.cancel('op1');
      } catch (err) {
        refusal = err;
      }
      if (Object.hasOwn(patch, 'localDb')) env.bridge.current.localDb = patch.localDb;
      return { ok: true, current: env.bridge.current };
    });
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(refusal.message).toBe('Finishing install');
    expect(result.status).toBe('installed');
  });

  it('cancel of another operation id is refused', async () => {
    const env = setup({ stream: { chunkSize: 256 } });
    const running = env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(() => env.installer.cancel('other')).toThrow(/Another database operation/);
    await running;
    expect(() => env.installer.cancel('op1')).toThrow();
  });
});

describe('[P5 row7] update, profile switch and the commit point', () => {
  const update = (over = {}) => setup({ settings: { localDb: installed() }, ...over });

  it('an update commits the new record and retires the old file in that order', async () => {
    const env = update();
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('installed');
    expect(env.bridge.commits.map((c) => Object.keys(c.patch).sort())).toEqual([
      ['localDb', 'pendingDeletesAdd'], ['pendingDeletesRemove']
    ]);
    expect(env.bridge.commits[0].expectedLocalDb).toEqual(installed());
    expect(env.bridge.current.localDbPendingDeletes).toEqual([]);
    expect([...env.pool.files.keys()]).toEqual([result.record.file]);
    // The old file is closed before it is deleted, and never the other way round.
    const ops = env.pool.events.filter((e) => e.name === '/old.db').map((e) => e.op);
    expect(ops).toEqual(['unlink']);
  });

  // The same release, already installed: same profile, release, digest and fingerprint.
  const sameRelease = () => installed({ release: '2026.09.27.1', sha256Db: sha256Hex(dbBytes()) });

  it('installing the SAME release again is a no-op with no download', async () => {
    const env = setup({ settings: { localDb: sameRelease() } });
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('already-installed');
    expect(env.pool.importDb).not.toHaveBeenCalled();
    expect(env.bridge.commits).toEqual([]);
  });

  it('Repair downloads the same release into a NEW staging file and commits like an update', async () => {
    const env = setup({ settings: { localDb: sameRelease() } });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1', repair: true });
    expect(result.status).toBe('installed');
    expect(result.record.file).not.toBe('/old.db');
    expect(env.pool.importDb).toHaveBeenCalled();
    expect(env.pool.files.has('/old.db')).toBe(false);
  });

  it('a profile switch retires the other profile at the commit', async () => {
    const env = setup({ settings: { localDb: installed({ profile: 'full', file: '/full.db' }) } });
    env.pool.put('/full.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.record.profile).toBe('core');
    expect(env.bridge.commits[0].patch.pendingDeletesAdd).toEqual(['/full.db']);
    expect(env.pool.files.has('/full.db')).toBe(false);
  });

  it('a refused commit ("changed") leaves the old installation untouched', async () => {
    const env = update({ behavior: { answers: ['changed'] } });
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'settings' });
    expect(env.bridge.current.localDb).toEqual(installed());
    expect([...env.pool.files.keys()].filter((n) => n.startsWith('/stage-'))).toEqual([]);
    expect(env.installer.isGated()).toBe(false);
  });

  it('a stale generation and a failed write are refusals too', async () => {
    for (const reason of ['stale-generation', 'write-failed']) {
      const env = update({ behavior: { answers: [reason] } });
      await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
        .rejects.toMatchObject({ kind: 'settings' });
      expect(env.bridge.current.localDb).toEqual(installed());
    }
  });

  it('a LOST answer whose write DID happen continues the install (reread decides)', async () => {
    const env = update({ behavior: { answers: ['lost'] } });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('installed');
    expect(env.bridge.read).toHaveBeenCalledTimes(2);
    expect(env.pool.files.has('/old.db')).toBe(false);
  });

  it('a lost answer whose write did NOT happen is a refusal (the old record is still stored)', async () => {
    const env = update({ behavior: { answers: ['throw'] } });
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'settings' });
    expect(env.bridge.current.localDb).toEqual(installed());
  });

  it('a lost answer AND an unreadable reread keeps BOTH files and stops serving local queries', async () => {
    const env = update({ behavior: { answers: ['throw'], readFails: 0 } });
    env.bridge.read.mockImplementationOnce(async () => ({ ...env.bridge.current }));
    env.bridge.read.mockImplementationOnce(async () => { throw new Error('unreadable'); });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('recovery-unavailable');
    expect(env.installer.state()).toBe('recovery-unavailable');
    expect([...env.pool.files.keys()].sort()).toEqual(['/old.db', '/stage-core-2026.09.27.1-00000000.db']);
  });

  it('the retired file is CLOSED before it is deleted, and the active file is never deleted', async () => {
    const bytes = dbBytes(4096);
    const env = setup({ settings: { localDb: installed({ file: '/old.db', dbSize: bytes.length }) } });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    // Recovery opens the recorded file, so there is a live handle to close.
    await env.installer.recover();
    expect(env.pool.openNames()).toEqual(['/old.db']);

    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    const ops = env.pool.events.filter((e) => e.name === '/old.db').map((e) => e.op);
    expect(ops).toEqual(['open', 'close', 'unlink']);
    // The new file is the active one and stays open.
    expect(env.pool.openNames()).toEqual([result.record.file]);
    expect([...env.pool.files.keys()]).toEqual([result.record.file]);
  });

  it('the shared budget yields a macrotask in BOTH the import and the stored-byte check', async () => {
    const env = setup({ bytes: dbBytes(4096 * 8) });
    const seen = [];
    let clock = 0;
    const installer = createInstaller({
      pool: env.pool,
      bridge: env.bridge,
      fetchImpl: async () => ({ status: 200, body: bodyStream(env.pointer.gz, { chunkSize: 256 }) }),
      random: () => 'aaaaaaaa',
      monotonicNow: () => { clock += 40; return clock; },
      verifyBatchBytes: 4096,
      // The worker answers `status` and `cancel` in these macrotasks.
      yieldToMacrotask: async () => { seen.push(installer.operation().phase); }
    });
    const result = await installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('installed');
    expect(seen).toContain('downloading');
    expect(seen).toContain('verifying');
    // Never during the commit: the budget belongs to the bounded work units.
    expect(seen).not.toContain('committing');
  });

  it('no yield happens while the budget has not elapsed', async () => {
    const env = setup();
    let yields = 0;
    const installer = createInstaller({
      pool: env.pool,
      bridge: env.bridge,
      fetchImpl: async () => ({ status: 200, body: bodyStream(env.pointer.gz, { chunkSize: 256 }) }),
      random: () => 'aaaaaaaa',
      monotonicNow: () => 0, // time stands still
      yieldToMacrotask: async () => { yields += 1; }
    });
    await installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(yields).toBe(0);
  });

  // Review finding 10: the inactivity deadline covers the header wait too.
  it('headers that never arrive abort the install, and nothing is staged', async () => {
    const env = setup();
    const aborted = [];
    const installer = createInstaller({
      pool: env.pool,
      bridge: env.bridge,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted.push('fetch');
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
      random: () => 'aaaaaaaa',
      stallMs: 20
    });
    await expect(installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'network_stalled' });
    expect(aborted).toEqual(['fetch']);
    expect(env.pool.importDb).not.toHaveBeenCalled();
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('a cancel while the headers are still awaited settles as cancelled', async () => {
    const env = setup();
    let installer;
    const running = (async () => {
      installer = createInstaller({
        pool: env.pool,
        bridge: env.bridge,
        fetchImpl: (url, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => installer.cancel('op1'), 0);
        }),
        random: () => 'aaaaaaaa',
        stallMs: 60000
      });
      return installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    })();
    await expect(running).rejects.toMatchObject({ kind: 'cancelled' });
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('no bytes for the stall timeout aborts the download', async () => {
    const env = setup();
    const installer = createInstaller({
      pool: env.pool,
      bridge: env.bridge,
      fetchImpl: async () => ({ status: 200, body: new ReadableStream({ pull() { return new Promise(() => {}); } }) }),
      random: () => 'aaaaaaaa',
      stallMs: 20
    });
    await expect(installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'network_stalled' });
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  // Review-6 findings 1 and 2: the ORIGINAL response body is released (and
  // cancelled when unfinished) on every terminal path (HOUSE_RULES 12).
  describe('[P5 fix10] the response body is released on every exit', () => {
    /**
     * A response body that records whether it was cancelled. `stallAfter`
     * stops delivering after that many chunks (the read stays pending);
     * `errorAfter` makes the body itself fail after that many chunks.
     */
    const trackedBody = (bytes, { chunkSize = 64, stallAfter = Infinity, errorAfter = Infinity, onChunk } = {}) => {
      const state = { cancelled: false, closed: false, chunks: 0, total: Math.ceil(bytes.length / chunkSize) };
      let at = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (state.chunks >= errorAfter) {
            controller.error(new TypeError('connection reset'));
            return;
          }
          if (state.chunks >= stallAfter) {
            await new Promise(() => {});
          }
          if (at >= bytes.length) {
            state.closed = true;
            controller.close();
            return;
          }
          const piece = bytes.slice(at, at + chunkSize);
          at += piece.length;
          state.chunks += 1;
          if (onChunk) onChunk(state.chunks);
          controller.enqueue(piece);
        },
        cancel() { state.cancelled = true; }
      });
      return { body, state };
    };
    // Incompressible bytes: a gzip body far larger than what the pipe reads
    // ahead, so a failure really leaves it UNFINISHED.
    const noise = (n) => {
      const bytes = new Uint8Array(n);
      let x = 12345;
      for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        bytes[i] = x >>> 24;
      }
      return bytes;
    };
    const BIG = noise(256 * 1024);
    // Node's DecompressionStream reads its whole input ahead (a test-runtime
    // property; Chrome applies backpressure). So the body delivers 8 KiB and
    // then holds its next read open: it is UNFINISHED when the failure comes.
    const HELD = { chunkSize: 1024, stallAfter: 8 };
    const run = async ({
      status = 200, gz, body: bodyOpts = {}, importDb, stallMs = 60000, cancelAt, bytes
    } = {}) => {
      const env = setup(bytes ? { bytes } : {});
      if (importDb) env.pool.importDb = vi.fn(importDb);
      let installer;
      const tracked = trackedBody(gz ?? env.pointer.gz, {
        ...bodyOpts,
        onChunk: cancelAt ? (n) => { if (n === cancelAt) installer.cancel('op1'); } : undefined
      });
      installer = createInstaller({
        pool: env.pool,
        bridge: env.bridge,
        fetchImpl: vi.fn(async () => ({ status, body: tracked.body })),
        random: () => 'aaaaaaaa',
        stallMs,
        yieldToMacrotask: () => new Promise((resolve) => { setTimeout(resolve, 0); })
      });
      const outcome = await installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' })
        .then((value) => ({ value }), (error) => ({ error }));
      // Let any cancellation that is still travelling up the pipe arrive.
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      return { env, outcome, body: tracked.body, state: tracked.state };
    };

    it('success (EOF): installed, the body is unlocked and was not cancelled', async () => {
      const { outcome, body, state } = await run();
      expect(outcome.value).toMatchObject({ status: 'installed' });
      expect(body.locked).toBe(false);
      expect(state.cancelled).toBe(false);
    });

    it('a body error: network, the body is unlocked', async () => {
      const { outcome, body, env } = await run({ body: { errorAfter: 2, chunkSize: 32 } });
      expect(outcome.error).toMatchObject({ kind: 'network' });
      expect(body.locked).toBe(false);
      expect([...env.pool.files.keys()]).toEqual([]);
    });

    it('a user cancel: cancelled, the unfinished body is cancelled and unlocked', async () => {
      const { outcome, body, state } = await run({ bytes: BIG, body: HELD, cancelAt: 3 });
      expect(outcome.error).toMatchObject({ kind: 'cancelled' });
      expect(state.closed).toBe(false);
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it('a stall abort: network_stalled, the unfinished body is cancelled and unlocked', async () => {
      const { outcome, body, state } = await run({ body: { stallAfter: 2, chunkSize: 16 }, stallMs: 20 });
      expect(outcome.error).toMatchObject({ kind: 'network_stalled' });
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it('a decoder error: damaged, the unfinished body is cancelled and unlocked', async () => {
      const env = setup({ bytes: BIG });
      const gz = Uint8Array.from(env.pointer.gz);
      gz[0] ^= 0xff;
      const { outcome, body, state } = await run({ bytes: BIG, gz, body: HELD });
      expect(outcome.error).toMatchObject({ kind: 'damaged' });
      expect(state.closed).toBe(false);
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it('an importer error: storage, the unfinished body is cancelled and unlocked', async () => {
      const importDb = async (name, pull) => {
        await pull();
        throw new Error('disk full');
      };
      const { outcome, body, state } = await run({ bytes: BIG, body: HELD, importDb });
      expect(outcome.error).toMatchObject({ kind: 'storage' });
      expect(state.closed).toBe(false);
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it('a setup failure after the response: the body is cancelled and unlocked', async () => {
      const env = setup();
      const tracked = trackedBody(env.pointer.gz);
      const installer = createInstaller({
        pool: env.pool,
        bridge: env.bridge,
        fetchImpl: vi.fn(async () => ({ status: 200, body: tracked.body })),
        random: () => 'aaaaaaaa',
        decompressionStream: () => { throw new Error('no decoder'); }
      });
      await expect(installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' })).rejects.toBeTruthy();
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      expect(tracked.state.cancelled).toBe(true);
      expect(tracked.body.locked).toBe(false);
      expect(env.pool.importDb).not.toHaveBeenCalled();
    });

    it('a non-200 answer with an unfinished body: network, the body is cancelled, nothing is staged', async () => {
      const { outcome, body, state, env } = await run({ status: 503 });
      expect(outcome.error).toMatchObject({ kind: 'network' });
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
      expect(env.pool.importDb).not.toHaveBeenCalled();
      expect([...env.pool.files.keys()]).toEqual([]);
    });
  });

  it('a failed deletion of the retired file leaves it pending', async () => {
    const env = setup({
      settings: { localDb: installed() }, pool: { unlinkFails: new Set(['/old.db']) }
    });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.cleanupPending).toBe(true);
    expect(env.bridge.current.localDbPendingDeletes).toEqual(['/old.db']);
  });
});

describe('[P5 row7] uninstall', () => {
  it('commits first, then deletes; the settings go back to the online backend', async () => {
    const env = setup({ settings: { localDb: installed(), lookupBackend: 'local-db' } });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.uninstall({ operationId: 'op1' });
    expect(result).toEqual({ status: 'uninstalled', cleanupPending: false });
    expect(env.bridge.current.localDb).toBeNull();
    expect(env.bridge.current.lookupBackend).toBe('loc-api');
    expect(env.bridge.current.localDbPendingDeletes).toEqual([]);
    expect(env.pool.files.has('/old.db')).toBe(false);
    expect(env.installer.isGated()).toBe(false);
  });

  it('a refused commit keeps the installation and reopens the file', async () => {
    const env = setup({ settings: { localDb: installed() }, behavior: { answers: ['changed'] } });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    await expect(env.installer.uninstall({ operationId: 'op1' })).rejects.toMatchObject({ kind: 'settings' });
    expect(env.bridge.current.localDb).toEqual(installed());
    expect(env.pool.files.has('/old.db')).toBe(true);
    expect(env.installer.record()).toEqual(installed());
    expect(env.installer.isGated()).toBe(false);
  });

  it('a failed deletion is reported as "cleanup pending"', async () => {
    const env = setup({
      settings: { localDb: installed() }, pool: { unlinkFails: new Set(['/old.db']) }
    });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.uninstall({ operationId: 'op1' });
    expect(result.cleanupPending).toBe(true);
    expect(env.bridge.current.localDbPendingDeletes).toEqual(['/old.db']);
  });

  it('an uninstall while an install runs is refused', async () => {
    const env = setup({ stream: { chunkSize: 256 } });
    const running = env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    await expect(env.installer.uninstall({ operationId: 'op2' })).rejects.toMatchObject({ kind: 'busy' });
    await running;
  });

  it('an uninstall with nothing installed is a no-op', async () => {
    const env = setup();
    expect(await env.installer.uninstall({ operationId: 'op1' })).toEqual({ status: 'uninstalled' });
    expect(env.bridge.commits).toEqual([]);
  });
});

describe('[P5 row7] startup recovery (§3.4)', () => {
  const recovering = (localDb, pendingDeletes = []) => setup({
    settings: { localDb, localDbPendingDeletes: pendingDeletes }
  });

  it('opens and validates the RECORDED file, then deletes every other pool file', async () => {
    const bytes = dbBytes(4096 * 2);
    const record = installed({ file: '/active.db', dbSize: bytes.length });
    const env = recovering(record, ['/gone.db']);
    env.pool.put('/active.db', bytes, describeDb(bytes));
    env.pool.put('/stage-leftover.db', bytes, describeDb(bytes));
    const result = await env.installer.recover();
    expect(result.state).toBe('ready');
    expect(result.record).toEqual(record);
    expect([...env.pool.files.keys()]).toEqual(['/active.db']);
    // An absent pending entry counts as deleted and is cleared.
    expect(env.bridge.current.localDbPendingDeletes).toEqual([]);
  });

  it('unreadable settings keep ALL pool files and serve no local queries', async () => {
    const env = recovering(installed({ file: '/active.db' }));
    env.bridge.state.readFails = 1;
    env.pool.put('/active.db', dbBytes(4096), describeDb(dbBytes(4096)));
    env.pool.put('/stage-leftover.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.recover();
    expect(result.state).toBe('recovery-unavailable');
    expect([...env.pool.files.keys()].sort()).toEqual(['/active.db', '/stage-leftover.db']);
    expect(env.pool.unlink).not.toHaveBeenCalled();
  });

  it('a MISSING active file is repair-needed; another file is never promoted', async () => {
    const bytes = dbBytes(4096 * 2);
    const env = recovering(installed({ file: '/active.db', dbSize: bytes.length }));
    env.pool.put('/other.db', bytes, describeDb(bytes));
    const result = await env.installer.recover();
    expect(result.state).toBe('repair-needed');
    expect(result.record).toBeNull();
    expect(env.installer.record()).toBeNull();
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('an active file that no longer matches the INSTALLED RECORD is repair-needed', async () => {
    const bytes = dbBytes(4096 * 2);
    const env = recovering(installed({ file: '/active.db', dbSize: bytes.length + 4096 }));
    env.pool.put('/active.db', bytes, describeDb(bytes));
    expect((await env.installer.recover()).state).toBe('repair-needed');
    // The recorded file is NOT deleted by the cleanup.
    expect([...env.pool.files.keys()]).toEqual(['/active.db']);
  });

  it('nothing installed: the client is ready and every pool file is leftover', async () => {
    const env = recovering(null);
    env.pool.put('/stage-leftover.db', dbBytes(4096), describeDb(dbBytes(4096)));
    const result = await env.installer.recover();
    expect(result.state).toBe('ready');
    expect([...env.pool.files.keys()]).toEqual([]);
  });

  it('a pending delete that keeps failing stays pending', async () => {
    const env = setup({
      settings: { localDb: null, localDbPendingDeletes: ['/stuck.db'] },
      pool: { unlinkFails: new Set(['/stuck.db']) }
    });
    env.pool.put('/stuck.db', dbBytes(4096), describeDb(dbBytes(4096)));
    await env.installer.recover();
    expect(env.bridge.current.localDbPendingDeletes).toEqual(['/stuck.db']);
  });

  // Review finding 1 (HIGH): an unreadable RECORD is not a damaged DATABASE.
  it('an INVALID settings snapshot is recovery-unavailable with ZERO deletions', async () => {
    const bytes = dbBytes(4096);
    const broken = [
      {},
      { ...installed(), file: undefined },
      { ...installed(), file: '/a/../b.db' },
      { ...installed(), file: 'no-leading-slash.db' },
      { ...installed(), releaseCommit: 'not-hex' },
      { ...installed(), dbSize: 0 },
      { ...installed(), profile: 'tiny' },
      { ...installed(), sha256Db: 'short' }
    ];
    for (const record of broken) {
      const env = recovering(record);
      env.pool.put('/old.db', bytes, describeDb(bytes));
      env.pool.put('/stage-leftover.db', bytes, describeDb(bytes));
      const result = await env.installer.recover();
      expect(result.state, JSON.stringify(record)).toBe('recovery-unavailable');
      expect([...env.pool.files.keys()].sort()).toEqual(['/old.db', '/stage-leftover.db']);
      expect(env.pool.unlink).not.toHaveBeenCalled();
      expect(env.pool.open).not.toHaveBeenCalled();
    }
  });

  it('an invalid pending-delete list is unreadable settings too', async () => {
    for (const pending of ['not-an-array', ['../escape'], ['plain.db'], [42]]) {
      const env = setup({ settings: { localDb: null, localDbPendingDeletes: pending } });
      env.pool.put('/stage-leftover.db', dbBytes(4096), describeDb(dbBytes(4096)));
      expect((await env.installer.recover()).state, JSON.stringify(pending)).toBe('recovery-unavailable');
      expect(env.pool.unlink).not.toHaveBeenCalled();
    }
  });

  it('a pending entry that names the ACTIVE file is unreadable settings', async () => {
    const env = setup({ settings: { localDb: installed(), localDbPendingDeletes: ['/old.db'] } });
    env.pool.put('/old.db', dbBytes(4096), describeDb(dbBytes(4096)));
    expect((await env.installer.recover()).state).toBe('recovery-unavailable');
    expect(env.pool.files.has('/old.db')).toBe(true);
    expect(env.pool.unlink).not.toHaveBeenCalled();
  });

  // Review finding 2: handles are tracked until they are confirmed closed.
  it('a recovery whose validation fails closes the handle it just opened', async () => {
    const bytes = dbBytes(4096 * 2);
    const env = recovering(installed({ file: '/old.db', dbSize: bytes.length + 4096 }));
    env.pool.put('/old.db', bytes, describeDb(bytes));
    expect((await env.installer.recover()).state).toBe('repair-needed');
    const ops = env.pool.events.filter((e) => e.name === '/old.db').map((e) => e.op);
    expect(ops).toEqual(['open', 'close']);
    expect(env.pool.openNames()).toEqual([]);
    // The recorded file is kept, even in repair-needed.
    expect(env.pool.files.has('/old.db')).toBe(true);
  });

  it('a file whose handle refuses to close is never unlinked by the cleanup', async () => {
    const bytes = dbBytes(4096);
    const env = setup({ settings: { localDb: installed({ file: '/old.db', dbSize: bytes.length }) } });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    env.pool.failClose.add('/old.db');
    await env.installer.recover();

    // Uninstall must close the active handle first; the close fails.
    const result = await env.installer.uninstall({ operationId: 'op1' });
    expect(result).toEqual({ status: 'uninstalled', cleanupPending: true });
    expect(env.pool.files.has('/old.db')).toBe(true);
    expect(env.bridge.current.localDbPendingDeletes).toEqual(['/old.db']);
  });

  it('an uninstall whose rollback cannot reopen the database is repair-needed, not ready', async () => {
    const bytes = dbBytes(4096);
    const env = setup({
      settings: { localDb: installed({ file: '/old.db', dbSize: bytes.length }) }, behavior: { answers: ['changed'] }
    });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    await env.installer.recover();
    env.pool.faults.open = new Error('cannot reopen');
    await expect(env.installer.uninstall({ operationId: 'op1' })).rejects.toMatchObject({ kind: 'settings' });
    expect(env.installer.state()).toBe('repair-needed');
    expect(env.installer.handle()).toBeNull();
    expect(env.bridge.current.localDb).toEqual(installed({ file: '/old.db', dbSize: bytes.length }));
    expect(env.pool.files.has('/old.db')).toBe(true);
  });

  it('an UNRESOLVED commit retains the staging handle and deletes nothing', async () => {
    const bytes = dbBytes(4096);
    const env = setup({ settings: { localDb: installed({ file: '/old.db', dbSize: bytes.length }) } });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    env.bridge.read.mockImplementationOnce(async () => ({ ...env.bridge.current, valid: true }));
    env.bridge.state.answers = ['throw'];
    env.bridge.read.mockImplementationOnce(async () => { throw new Error('unreadable'); });
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    expect(result.status).toBe('recovery-unavailable');
    expect([...env.pool.files.keys()].sort()).toEqual(['/old.db', '/stage-core-2026.09.27.1-00000000.db']);
    // The staging handle is still open and is therefore protected from cleanup.
    expect(env.pool.openNames()).toContain('/stage-core-2026.09.27.1-00000000.db');
  });

  /**
   * N2: after an unresolved commit the NEW file is recorded in the settings
   * while its handle is still open. Every later deletion path must refuse it;
   * the guard lives in `unlink()`, so no caller can bypass it.
   */
  const withRetainedNewFile = async () => {
    const bytes = dbBytes(4096);
    const env = setup({ settings: { localDb: installed({ file: '/old.db', dbSize: bytes.length }) } });
    env.pool.put('/old.db', bytes, describeDb(bytes));
    // The commit's WRITE happens; only its answer is lost, and the reread fails.
    env.bridge.state.answers = ['lost'];
    env.bridge.read.mockImplementationOnce(async () => ({ ...env.bridge.current, valid: true, invalidReason: null }));
    env.bridge.read.mockImplementationOnce(async () => { throw new Error('unreadable'); });
    const result = await env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' });
    const staged = '/stage-core-2026.09.27.1-00000000.db';
    expect(result.status).toBe('recovery-unavailable');
    // The settings now name the staged file, whose handle is still open.
    expect(env.bridge.current.localDb.file).toBe(staged);
    expect(env.pool.openNames()).toContain(staged);
    env.pool.unlink.mockClear();
    return { env, staged, bytes };
  };

  it('an unresolved commit followed by an UNINSTALL never unlinks the retained file', async () => {
    const { env, staged } = await withRetainedNewFile();
    const result = await env.installer.uninstall({ operationId: 'op2' });
    expect(result).toEqual({ status: 'uninstalled', cleanupPending: true });
    // No underlying deletion of the still-open file was even attempted.
    expect(env.pool.unlink.mock.calls.map((c) => c[0])).not.toContain(staged);
    expect(env.pool.files.has(staged)).toBe(true);
    // It stays pending, so a fresh worker's recovery deletes it later.
    expect(env.bridge.current.localDbPendingDeletes).toContain(staged);
  });

  it('an unresolved commit followed by an UPDATE never unlinks the retained file', async () => {
    const { env, staged } = await withRetainedNewFile();
    const next = { ...env.pointer, release: '2026.09.28.1' };
    const result = await env.installer.install({ pointer: next, profile: PROFILE, operationId: 'op2' });
    expect(result.status).toBe('installed');
    expect(env.pool.unlink.mock.calls.map((c) => c[0])).not.toContain(staged);
    expect(env.pool.files.has(staged)).toBe(true);
    expect(result.cleanupPending).toBe(true);
    expect(env.bridge.current.localDbPendingDeletes).toContain(staged);
  });

  it('a retained file keeps its pending entry through a recovery in the SAME worker', async () => {
    const { env, staged } = await withRetainedNewFile();
    await env.installer.recover({ operationId: 'op3' });
    expect(env.pool.unlink.mock.calls.map((c) => c[0])).not.toContain(staged);
    expect(env.pool.files.has(staged)).toBe(true);
  });

  it('recovery is one mutation: an install during it is refused', async () => {
    const env = recovering(null);
    let release;
    env.bridge.read.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ...env.bridge.current }); }));
    const running = env.installer.recover();
    await expect(env.installer.install({ pointer: env.pointer, profile: PROFILE, operationId: 'op1' }))
      .rejects.toMatchObject({ kind: 'busy' });
    release();
    await running;
  });
});
