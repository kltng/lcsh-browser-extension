import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installRemoveEntryGuard, isGuardInstalled, acquirePool, isContention, RecursiveRemovalRefused, AcquireError, POOL_NAME
} from '../guard';
import { createRealPool } from '../worker';
import { createFakeOpfs, createFakeInitializer, OPAQUE_DIR, ROOT_DIR } from '../../../../test/opfsFakes';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A minimal fake global with a directory-handle class whose removeEntry is a spy. */
const fakeScope = () => {
  const original = vi.fn(function removeEntry() { return Promise.resolve('removed'); });
  class FileSystemDirectoryHandle {}
  FileSystemDirectoryHandle.prototype.removeEntry = original;
  return { scope: { FileSystemDirectoryHandle }, original };
};

describe('[P5 row13] the recursive-removal guard (§3.2 rule 1)', () => {
  it('REFUSES a recursive removal and never reaches the original', () => {
    const { scope, original } = fakeScope();
    installRemoveEntryGuard(scope);
    const dir = new scope.FileSystemDirectoryHandle();
    expect(() => dir.removeEntry('.opaque', { recursive: true })).toThrow(RecursiveRemovalRefused);
    // Any truthy `recursive` is a recursive removal.
    expect(() => dir.removeEntry('.opaque', { recursive: 1 })).toThrow(RecursiveRemovalRefused);
    expect(original).not.toHaveBeenCalled();
  });

  it('forwards every other call UNCHANGED: same receiver, same arguments, same result', async () => {
    const { scope, original } = fakeScope();
    installRemoveEntryGuard(scope);
    const dir = new scope.FileSystemDirectoryHandle();
    const options = { recursive: false };
    const result = dir.removeEntry('slot-1', options);
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.contexts[0]).toBe(dir);
    expect(original.mock.calls[0]).toEqual(['slot-1', options]);
    expect(original.mock.calls[0][1]).toBe(options);
    expect(await result).toBe('removed');

    dir.removeEntry('slot-2');
    expect(original.mock.calls[1]).toEqual(['slot-2']);
    expect(original.mock.contexts[1]).toBe(dir);
  });

  it('is verified after installation and is never wrapped twice', () => {
    const { scope } = fakeScope();
    expect(isGuardInstalled(scope)).toBe(false);
    installRemoveEntryGuard(scope);
    const guard = scope.FileSystemDirectoryHandle.prototype.removeEntry;
    expect(isGuardInstalled(scope)).toBe(true);
    installRemoveEntryGuard(scope);
    expect(scope.FileSystemDirectoryHandle.prototype.removeEntry).toBe(guard);
  });

  it('a guard that cannot be installed ABORTS the acquisition before the initializer runs', async () => {
    const installSahPool = vi.fn();
    // No directory handles at all.
    await expect(acquirePool({ scope: {}, installSahPool })).rejects.toMatchObject({ kind: 'db_guard_failed' });
    // A prototype that refuses the replacement.
    class FileSystemDirectoryHandle {}
    FileSystemDirectoryHandle.prototype.removeEntry = () => Promise.resolve();
    Object.freeze(FileSystemDirectoryHandle.prototype);
    await expect(acquirePool({ scope: { FileSystemDirectoryHandle }, installSahPool }))
      .rejects.toMatchObject({ kind: 'db_guard_failed' });
    expect(installSahPool).not.toHaveBeenCalled();
  });

  it('the production pool builder installs the guard BEFORE it even loads the engine', async () => {
    const { scope } = fakeScope();
    const order = [];
    const initModule = vi.fn(async () => {
      order.push(isGuardInstalled(scope) ? 'engine-with-guard' : 'engine-WITHOUT-guard');
      return {
        installOpfsSAHPoolVfs: async (options) => {
          order.push(`init:${options.name}:clearOnInit=${options.clearOnInit}`);
          return { getFileNames: () => [] };
        }
      };
    });
    await createRealPool({ scope, initModule });
    expect(order).toEqual(['engine-with-guard', `init:${POOL_NAME}:clearOnInit=false`]);

    const broken = vi.fn();
    await expect(createRealPool({ scope: {}, initModule: broken })).rejects.toMatchObject({ kind: 'db_guard_failed' });
    expect(broken).not.toHaveBeenCalled();
  });

  it('acquires with clearOnInit:false and classifies ONLY contention as retryable', async () => {
    const { scope } = fakeScope();
    const seen = [];
    await acquirePool({ scope, installSahPool: async (options) => { seen.push(options); return {}; } });
    expect(seen).toEqual([{ name: POOL_NAME, clearOnInit: false }]);

    const busy = new DOMException('Access Handles cannot be created if there is another open one', 'NoModificationAllowedError');
    expect(isContention(busy)).toBe(true);
    expect(isContention(new DOMException('x', 'NotFoundError'))).toBe(false);
    expect(isContention(new Error('Missing required OPFS APIs.'))).toBe(false);
    await expect(acquirePool({ scope, installSahPool: async () => { throw busy; } }))
      .rejects.toMatchObject({ kind: 'db_contention' });
    await expect(acquirePool({ scope, installSahPool: async () => { throw new Error('other'); } }))
      .rejects.toMatchObject({ kind: 'db_init_failed' });
    expect(new AcquireError('db_contention', 'x').kind).toBe('db_contention');
  });
});

describe('[P5 row13] an init failure under contention leaves every pool file in place', () => {
  it('WITHOUT the guard, the pinned failure path deletes the whole pool (the hazard is real)', async () => {
    const opfs = createFakeOpfs(['slot-a', 'slot-b', 'slot-c']);
    opfs.hold('slot-a', 'old-worker');
    const w = opfs.workerScope('w1');
    await expect(createFakeInitializer(w)({ name: POOL_NAME })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    expect([...opfs.files.keys()]).toEqual([]);
  });

  it('WITH the guard, the same failure deletes NOTHING and still reports contention', async () => {
    const opfs = createFakeOpfs(['slot-a', 'slot-b', 'slot-c']);
    opfs.hold('slot-a', 'old-worker');
    const w = opfs.workerScope('w1');
    await expect(acquirePool({ scope: w.scope, installSahPool: createFakeInitializer(w) }))
      .rejects.toMatchObject({ kind: 'db_contention' });
    expect([...opfs.files.keys()].sort()).toEqual(['slot-a', 'slot-b', 'slot-c']);
    expect(opfs.rootPresent()).toBe(true);
    // The library's cleanup DID run and try to delete the pool recursively...
    expect(w.attempts).toEqual(['removeVfs']);
    // ...but the guard refused before the storage ever saw the call.
    expect(opfs.log.filter((e) => e.options?.recursive)).toEqual([]);
    expect(opfs.log.filter((e) => e.name === OPAQUE_DIR || e.name === ROOT_DIR)).toEqual([]);
  });

  it('the guard is per worker: installing it in one worker does not change another', () => {
    const opfs = createFakeOpfs(['slot-a']);
    const w1 = opfs.workerScope('w1');
    const w2 = opfs.workerScope('w2');
    installRemoveEntryGuard(w1.scope);
    expect(isGuardInstalled(w1.scope)).toBe(true);
    expect(isGuardInstalled(w2.scope)).toBe(false);
  });
});

/**
 * HOUSE_RULES 16: the guard exists because of specific lines of the PINNED
 * library. If an upgrade changes them, this test fails so the decision is
 * re-made deliberately, never silently. Reads node_modules; modifies nothing.
 */
describe('[P5 row13] the pinned library still has the destructive cleanup the guard answers', () => {
  const source = fs.readFileSync(
    path.join(HERE, '..', '..', '..', '..', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'index.mjs'), 'utf8'
  );
  const pkg = JSON.parse(fs.readFileSync(
    path.join(HERE, '..', '..', '..', '..', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'package.json'), 'utf8'
  ));

  it('is the pinned version', () => {
    expect(pkg.version).toBe('3.53.4-build1');
  });

  it('removeVfs() removes the pool directories recursively and swallows its own errors', () => {
    const removeVfs = source.slice(source.indexOf('async removeVfs() {'), source.indexOf('async removeVfs() {') + 900);
    expect(removeVfs).toContain('removeEntry(OPAQUE_DIR_NAME, { recursive: true })');
    expect(removeVfs).toContain('removeEntry(this.#dhVfsRoot.name, { recursive: true })');
    expect(removeVfs).toContain('removeVfs() failed with no recovery strategy');
  });

  it('every initialization failure runs removeVfs(), and the original error still propagates', () => {
    expect(source).toContain('await thePool.removeVfs().catch(() => {});');
    const init = source.slice(source.indexOf('await thePool.removeVfs().catch(() => {});'), source.indexOf('await thePool.removeVfs().catch(() => {});') + 80);
    expect(init).toContain('throw e;');
  });

  it('handle acquisition is a fail-fast Promise.all, and a failed init is cached', () => {
    expect(source).toContain('return Promise.all(files.map(async ([name, h]) => {');
    expect(source).toContain('const ah = await h.createSyncAccessHandle();');
    expect(source).toContain('return initPromises[vfsName] = Promise.reject(err);');
  });

  it('clearOnInit defaults to false, and we pass it explicitly anyway', () => {
    expect(source).toMatch(/clearOnInit: false/);
  });
});
