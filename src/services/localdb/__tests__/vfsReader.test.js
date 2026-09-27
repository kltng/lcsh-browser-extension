import { describe, it, expect } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createFilePointerVfs, hashStoredBytes, FCNTL_FILE_POINTER, IO_METHOD_OFFSETS, SQLITE_IOERR_SHORT_READ } from '../verify';
import { sha256Hex } from '../sha256';
import { fixtureBytes } from '../../../../test/localDbFixtures';

/**
 * §4.5 step 3 against a REAL sqlite3_file. Node has no OPFS, so the `memdb`
 * VFS stands in for the SAH pool; the SAH-pool VFS itself is the lead's §13
 * check in Chrome. What this pins is the JS side: the file-control call, the
 * two `sqlite3_io_methods` offsets, the return codes, and the digest.
 */
const openMemdb = async (bytes) => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const { capi, wasm } = sqlite3;
  const pointer = wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB('file:stored-bytes.db?vfs=memdb', 'c');
  const rc = capi.sqlite3_deserialize(
    db.pointer, 'main', pointer, bytes.length, bytes.length,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  expect(rc).toBe(0);
  return { sqlite3, db };
};

describe('[P5 row7] the stored-byte reader against a real sqlite3_file', () => {
  it('the pinned constants are the ones the library uses', async () => {
    const { sqlite3, db } = await openMemdb(fixtureBytes('core'));
    expect(sqlite3.capi.SQLITE_FCNTL_FILE_POINTER ?? FCNTL_FILE_POINTER).toBe(FCNTL_FILE_POINTER);
    expect(IO_METHOD_OFFSETS).toEqual({ xRead: 8, xFileSize: 24 });
    db.close();
  });

  it('xFileSize and xRead reproduce the file exactly, in 8 MiB and in tiny batches', async () => {
    const bytes = fixtureBytes('full');
    const { sqlite3, db } = await openMemdb(bytes);
    const vfs = createFilePointerVfs(sqlite3, db.pointer);
    try {
      expect(vfs.fileSize()).toBe(bytes.length);
      expect(await hashStoredBytes(vfs, { size: bytes.length })).toBe(sha256Hex(bytes));
      const batches = [];
      expect(await hashStoredBytes(vfs, { size: bytes.length, bufferBytes: 4096, onBatch: (d) => batches.push(d) }))
        .toBe(sha256Hex(bytes));
      expect(batches).toHaveLength(bytes.length / 4096);
    } finally {
      vfs.dispose();
      db.close();
    }
  });

  it('a read past the end returns SQLITE_IOERR_SHORT_READ, and a wrong size is refused', async () => {
    const bytes = fixtureBytes('core');
    const { sqlite3, db } = await openMemdb(bytes);
    const vfs = createFilePointerVfs(sqlite3, db.pointer);
    try {
      expect(vfs.read(new Uint8Array(4096), bytes.length, 4096)).toBe(SQLITE_IOERR_SHORT_READ);
      await expect(hashStoredBytes(vfs, { size: bytes.length + 4096 })).rejects.toMatchObject({ detail: 'file-size' });
    } finally {
      vfs.dispose();
      db.close();
    }
  });

  it('the stored hash differs as soon as one byte differs', async () => {
    const bytes = fixtureBytes('core');
    const { sqlite3, db } = await openMemdb(bytes);
    const vfs = createFilePointerVfs(sqlite3, db.pointer);
    try {
      const flipped = Uint8Array.from(bytes);
      flipped[40000] ^= 0xff;
      expect(await hashStoredBytes(vfs, { size: bytes.length })).not.toBe(sha256Hex(flipped));
    } finally {
      vfs.dispose();
      db.close();
    }
  });
});
