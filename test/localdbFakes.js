/**
 * Fakes for the local-database install protocol (SPEC-P5 §12 row 7): the
 * SAH pool and its importer, the settings bridge, the download stream and the
 * VFS reader. No OPFS, no worker, no network.
 */
import { vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { SQLITE_OK } from '../src/services/localdb/verify';

/** The gzip bytes of a payload (a real gzip stream, so DecompressionStream is real too). */
export const gzip = (bytes) => new Uint8Array(gzipSync(Buffer.from(bytes)));

/**
 * A readable stream of `bytes`, cut into `chunkSize` pieces, with optional
 * leading chunk sizes and a stall hook.
 * @param {Uint8Array} bytes - Body
 * @param {{chunkSize?:number, leading?:number[], onChunk?:Function}} [opts] - Shape of the stream
 * @returns {ReadableStream}
 */
export const bodyStream = (bytes, { chunkSize = 1 << 16, leading = [], onChunk } = {}) => {
  const sizes = [...leading];
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const size = Math.min(sizes.shift() ?? chunkSize, bytes.length - at);
      const piece = bytes.slice(at, at + size);
      at += size;
      if (onChunk) await onChunk(piece, at);
      controller.enqueue(piece);
    }
  });
};

/**
 * A fake pool. `describe(name, bytes)` supplies what an opened handle reports.
 * @param {{describe?:Function, shortWrite?:number, unlinkFails?:Set<string>}} [opts] - Behavior
 * @returns {object}
 */
export const createFakePool = ({
  describe, shortWrite = 0, unlinkFails = new Set(), failClose = new Set(), corruptStored = false
} = {}) => {
  const files = new Map();
  const events = [];
  const openHandles = new Set();
  const faults = { read: null, fileSize: null, open: null };

  const describeDefault = (name, bytes) => ({
    meta: {
      profile: 'core', schema_version: '2', normalize_version: 'NORMALIZE_V1', lh_format: 'LH1',
      compat_fingerprint: 'FP'
    },
    objects: [
      { name: 'db_meta', type: 'table' }, { name: 'auth', type: 'table' }, { name: 'alt_label', type: 'table' },
      { name: 'hierarchy', type: 'table' }, { name: 'auth_fts', type: 'table' }, { name: 'alt_label_fts', type: 'table' },
      { name: 'auth_fts_data', type: 'table' }, { name: 'idx_alt_label_norm', type: 'index' }
    ],
    pages: { pageSize: 4096, pageCount: Math.ceil(bytes.length / 4096) }
  });

  const pool = {
    files,
    events,
    faults,
    /** Names whose handle refuses to close (the file must then be kept). */
    failClose,
    /** Files that are currently open (a deletion of one of them is a bug). */
    openNames: () => [...openHandles].map((h) => h.name),
    put(name, bytes, info) {
      files.set(name, { bytes, info: info || (describe || describeDefault)(name, bytes) });
    },
    listFiles: vi.fn(async () => [...files.keys()]),
    importDb: vi.fn(async (name, pull) => {
      const parts = [];
      const chunkSizes = [];
      for (;;) {
        const chunk = await pull();
        if (chunk === undefined) break;
        chunkSizes.push(chunk.length);
        parts.push(chunk);
      }
      let total = parts.reduce((n, p) => n + p.length, 0);
      const merged = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        merged.set(part, at);
        at += part.length;
      }
      // `shortWrite` models the importer ignoring a short write: the stream was
      // complete, the stored copy is not.
      let stored = shortWrite > 0 ? merged.subarray(0, Math.max(0, merged.length - shortWrite)) : merged;
      // `corruptStored` models the harder case: the stored copy has EXACTLY the
      // right length but different bytes, so only the stored-byte digest of
      // §4.5 step 3 can catch it (the stream hashes and `xFileSize` cannot).
      if (corruptStored && stored.length > 0) {
        stored = Uint8Array.from(stored);
        const at = Math.floor(stored.length / 2);
        stored[at] ^= 0xff;
      }
      events.push({ op: 'import', name, chunkSizes });
      pool.put(name, stored, (describe || describeDefault)(name, merged));
    }),
    unlink: vi.fn(async (name) => {
      if (unlinkFails.has(name)) throw new Error('unlink failed');
      if (openHandles.size > 0 && pool.openNames().includes(name)) throw new Error('deleted an open file');
      events.push({ op: 'unlink', name, existed: files.has(name) });
      files.delete(name);
      return true;
    }),
    open: vi.fn(async (name) => {
      if (faults.open) throw faults.open;
      const entry = files.get(name);
      if (!entry) throw new Error('no such file');
      const handle = {
        name,
        meta: async () => entry.info.meta,
        objects: async () => entry.info.objects,
        pages: async () => entry.info.pages,
        vfs: async () => ({
          fileSize: async () => (faults.fileSize === null ? entry.bytes.length : faults.fileSize),
          read: async (buffer, offset, length) => {
            if (faults.read !== null) return faults.read;
            if (offset + length > entry.bytes.length) return 522;
            buffer.set(entry.bytes.subarray(offset, offset + length));
            return SQLITE_OK;
          }
        }),
        close: vi.fn(async () => {
          events.push({ op: 'close', name });
          if (failClose.has(name)) throw new Error('close failed');
          openHandles.delete(handle);
        })
      };
      openHandles.add(handle);
      events.push({ op: 'open', name });
      return handle;
    })
  };
  return pool;
};

/**
 * A fake settings bridge with the §3.3 semantics the installer depends on.
 * @param {{settings?:object, behavior?:object}} [opts] - Start settings and per-call behavior
 * @returns {object}
 */
export const createFakeBridge = ({ settings = {}, behavior = {} } = {}) => {
  const current = {
    lookupBackend: 'local-db', localDb: null, localDbPendingDeletes: [], ...settings
  };
  const commits = [];
  const state = {
    /** Queue of answers: 'ok' | 'changed' | 'stale-generation' | 'write-failed' | 'throw' | 'lost' | 'write-then-throw' */
    answers: [],
    readFails: 0,
    ...behavior
  };

  const apply = (patch) => {
    if (Object.hasOwn(patch, 'localDb')) current.localDb = patch.localDb;
    if (Object.hasOwn(patch, 'lookupBackend')) current.lookupBackend = patch.lookupBackend;
    const pending = new Set(current.localDbPendingDeletes);
    for (const name of patch.pendingDeletesAdd || []) pending.add(name);
    for (const name of patch.pendingDeletesRemove || []) pending.delete(name);
    current.localDbPendingDeletes = [...pending];
  };

  return {
    current,
    commits,
    state,
    read: vi.fn(async () => {
      if (state.readFails > 0) {
        state.readFails -= 1;
        throw new Error('settings unreadable');
      }
      return JSON.parse(JSON.stringify(current));
    }),
    commit: vi.fn(async ({ operationId, expectedLocalDb, patch }) => {
      commits.push({ operationId, expectedLocalDb, patch: JSON.parse(JSON.stringify(patch)) });
      const answer = state.answers.shift() || 'ok';
      if (answer === 'throw') throw new Error('bridge failed');
      if (answer === 'lost') {
        // The write happened; the answer never arrives.
        apply(patch);
        throw new Error('no answer');
      }
      if (answer !== 'ok') return { ok: false, reason: answer, current: JSON.parse(JSON.stringify(current)) };
      apply(patch);
      return { ok: true, current: JSON.parse(JSON.stringify(current)) };
    })
  };
};

/** A pointer-shaped object for one profile, with matching digests. */
export const pointerFor = ({ profile, bytes, release = '2026.09.27.1', fingerprint = 'FP', sha256Hex }) => {
  const gz = gzip(bytes);
  return {
    release,
    releaseCommit: 'a'.repeat(40),
    compatFingerprint: fingerprint,
    profiles: {
      [profile]: {
        gzSize: gz.length,
        dbSize: bytes.length,
        sha256Gz: sha256Hex(gz),
        sha256Db: sha256Hex(bytes),
        url: `https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/${'a'.repeat(40)}/releases/${release}/lcsh-${profile}.db.gz`,
        file: `lcsh-${profile}.db.gz`
      }
    },
    gz
  };
};
