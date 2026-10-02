/**
 * P6 fix 15, item 1: the stored-key registry is READY only after the stored
 * keys have loaded once, refreshes apply in order, and a failed refresh keeps
 * the last good set and is logged with local text only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { watchStoredKeys, documentKeys, resetKeyRegistry } from '../keyGuard';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A watcher whose reads are answered by the test, in any order. */
const watcher = () => {
  const reads = [];
  let changed = null;
  const stop = watchStoredKeys({
    readStoredApiKeys: () => {
      const d = deferred();
      reads.push(d);
      return d.promise;
    },
    onSettingsChanged: (cb) => {
      changed = cb;
      return () => {};
    }
  });
  return { reads, change: () => changed({ 'provider:openai': {} }), stop };
};

beforeEach(() => resetKeyRegistry());

describe('[P6 fix15] stored-key refreshes', () => {
  it('two refreshes resolving OUT OF ORDER: the newer set wins', async () => {
    const w = watcher();
    w.change();
    expect(w.reads).toHaveLength(2);
    // The newer read answers first, the older one late.
    w.reads[1].resolve(['sk-newer-key-0000002']);
    await tick();
    w.reads[0].resolve(['sk-older-key-0000001']);
    await tick();
    expect(documentKeys()).toEqual(['sk-newer-key-0000002']);
    w.stop();
  });

  it('a failed refresh keeps the last good set and logs local text only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = watcher();
    w.reads[0].resolve(['sk-good-key-00000001']);
    await tick();
    w.change();
    w.reads[1].reject(new Error('storage said sk-secret-detail'));
    await tick();
    expect(documentKeys()).toEqual(['sk-good-key-00000001']);
    expect(error).toHaveBeenCalled();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('sk-secret-detail');
    expect(logged).not.toContain('sk-good-key');
    w.stop();
  });
});
