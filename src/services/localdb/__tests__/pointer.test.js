import { describe, it, expect, vi } from 'vitest';
import {
  validatePointer, fetchPointer, parseRelease, compareReleases, expectedPath, changesUrl, createUpdateChecker,
  PointerError, POINTER_URL, SUPPORTED_FINGERPRINTS, UNSUPPORTED_MESSAGE, UPDATE_CHECK_INTERVAL_MS
} from '../pointer';

import { getSettings, localDbUpdateCheck } from '../../settings';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const INSTALLED = {
  profile: 'core', release: '2026.09.26.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db',
  dbSize: 4096, sha256Db: 'b'.repeat(64), compatFingerprint: 'FP', installedAt: '2026-09-26T00:00:00.000Z'
};
const RELEASE = '2026.09.27.1';
const FINGERPRINT = SUPPORTED_FINGERPRINTS[0];

const profile = (name, over = {}) => ({
  gz_size: 65000000,
  db_size: 215000000,
  sha256_gz: 'a'.repeat(64),
  sha256_db: 'b'.repeat(64),
  url_pinned: `https://huggingface.co${expectedPath(COMMIT, RELEASE, name)}`,
  ...over
});

const pointer = (over = {}) => ({
  pointer_version: 1,
  schema_version: 2,
  normalize_version: 'NORMALIZE_V1',
  compat_fingerprint: FINGERPRINT,
  release: RELEASE,
  release_commit: COMMIT,
  profiles: { core: profile('core'), full: profile('full') },
  ...over
});

const withProfile = (name, over) => pointer({
  profiles: { core: profile('core'), full: profile('full'), [name]: profile(name, over) }
});

const rejects = (json, kind = 'invalid_output') => {
  expect(() => validatePointer(json)).toThrow(PointerError);
  try {
    validatePointer(json);
  } catch (err) {
    expect(err.kind).toBe(kind);
  }
};

describe('[P5 row6] pointer validation: every field', () => {
  it('accepts a well-formed pointer and returns only what the installer uses', () => {
    const value = validatePointer(pointer());
    expect(value.release).toBe(RELEASE);
    expect(value.releaseCommit).toBe(COMMIT);
    expect(value.compatFingerprint).toBe(FINGERPRINT);
    expect(Object.keys(value.profiles)).toEqual(['core', 'full']);
    expect(value.profiles.core).toEqual({
      gzSize: 65000000, dbSize: 215000000, sha256Gz: 'a'.repeat(64), sha256Db: 'b'.repeat(64),
      url: `https://huggingface.co${expectedPath(COMMIT, RELEASE, 'core')}`, file: 'lcsh-core.db.gz'
    });
    // The manifest and the index files are never read.
    expect(JSON.stringify(value)).not.toContain('manifest');
  });

  it('an unsupported version or fingerprint asks for an extension update', () => {
    expect(UNSUPPORTED_MESSAGE).toBe('A newer database format is available; update the extension to use it.');
    rejects(pointer({ pointer_version: 2 }), 'unsupported');
    rejects(pointer({ pointer_version: '1' }), 'unsupported');
    rejects(pointer({ schema_version: 3 }), 'unsupported');
    rejects(pointer({ schema_version: '2' }), 'unsupported');
    rejects(pointer({ normalize_version: 'NORMALIZE_V2' }), 'unsupported');
    rejects(pointer({ compat_fingerprint: `${FINGERPRINT}x` }), 'unsupported');
    rejects(pointer({ compat_fingerprint: 123 }));
  });

  it('the release must be a real dated release with a safe sequence number', () => {
    expect(parseRelease(RELEASE)).toEqual([2026, 9, 27, 1]);
    expect(parseRelease('2026.02.30.1')).toBeNull();
    expect(parseRelease('2025.02.29.1')).toBeNull();
    expect(parseRelease('2024.02.29.1')).toEqual([2024, 2, 29, 1]);
    expect(parseRelease('2026.09.27.0')).toBeNull();
    expect(parseRelease('2026.9.27.1')).toBeNull();
    expect(parseRelease('2026.09.27.01')).toBeNull();
    expect(parseRelease('2026.09.27.99999999999999999999')).toBeNull();
    expect(parseRelease(20260927)).toBeNull();
    for (const bad of ['2026.02.30.1', '2026.9.27.1', 'latest', '', null, 1]) rejects(pointer({ release: bad }));
  });

  it('releases compare as four numbers, not as strings', () => {
    expect(compareReleases('2026.09.27.2', '2026.09.27.10')).toBeLessThan(0);
    expect(compareReleases('2026.09.27.1', '2026.10.01.1')).toBeLessThan(0);
    expect(compareReleases('2026.09.27.1', '2026.09.27.1')).toBe(0);
    expect(compareReleases('2027.01.01.1', '2026.12.31.9')).toBeGreaterThan(0);
    expect(() => compareReleases('2026.09.27.1', 'x')).toThrow(PointerError);
  });

  it('the release commit must be 40 lowercase hex', () => {
    for (const bad of [COMMIT.toUpperCase(), COMMIT.slice(0, 39), `${COMMIT}0`, 'main', '', null]) {
      rejects(pointer({ release_commit: bad }));
    }
  });

  it('both profiles are required, with positive safe-integer sizes', () => {
    rejects(pointer({ profiles: { core: profile('core') } }));
    rejects(pointer({ profiles: null }));
    rejects(pointer({ profiles: [profile('core'), profile('full')] }));
    for (const bad of [0, -1, 1.5, '65000000', Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, null]) {
      rejects(withProfile('core', { gz_size: bad }));
      rejects(withProfile('core', { db_size: bad }));
    }
  });

  it('both digests must be 64 lowercase hex', () => {
    for (const bad of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`, '', null, 1]) {
      rejects(withProfile('full', { sha256_gz: bad }));
      rejects(withProfile('full', { sha256_db: bad }));
    }
  });
});

describe('[P5 row6] URL canonicalization attacks', () => {
  const bad = (url) => rejects(withProfile('core', { url_pinned: url }));
  const good = `https://huggingface.co${expectedPath(COMMIT, RELEASE, 'core')}`;

  it('accepts only the exact pinned path', () => {
    expect(validatePointer(withProfile('core', { url_pinned: good })).profiles.core.url).toBe(good);
  });

  it('accepts a spelling that PARSES to exactly the same pathname', () => {
    const dotted = good.replace('/releases/', '/x/../releases/');
    expect(new URL(dotted).pathname).toBe(expectedPath(COMMIT, RELEASE, 'core'));
    expect(validatePointer(withProfile('core', { url_pinned: dotted })).profiles.core.url).toBe(dotted);
  });

  it('rejects dot segments that leave the pinned path', () => {
    bad(good.replace('/releases/', '/releases/../../'));
    bad(`${good}/../lcsh-full.db.gz`);
    bad(good.replace(`/resolve/${COMMIT}/`, `/resolve/${COMMIT}/../main/`));
  });

  it('rejects encoded separators and any other profile, release or commit', () => {
    bad(good.replace('/releases/', '%2Freleases%2F'));
    bad(good.replace('lcsh-core', 'lcsh-full'));
    bad(good.replace(RELEASE, '2026.09.26.1'));
    bad(good.replace(COMMIT, 'main'));
    bad(good.replace('/datasets/kltng/lcsh-db-lite/', '/datasets/evil/lcsh-db-lite/'));
  });

  it('rejects another host, another scheme, credentials, a port, a query and a fragment', () => {
    bad(good.replace('huggingface.co', 'huggingface.co.evil.test'));
    bad(good.replace('huggingface.co', 'cdn-lfs.huggingface.co'));
    bad(good.replace('https://', 'http://'));
    bad(good.replace('https://', 'https://user:pw@'));
    bad(good.replace('https://huggingface.co', 'https://huggingface.co:8443'));
    bad(`${good}?download=true`);
    bad(`${good}#frag`);
    bad('not a url');
    bad(null);
  });

  it('the CHANGES.md link is built from the same release and commit', () => {
    expect(changesUrl({ release: RELEASE, releaseCommit: COMMIT }))
      .toBe(`https://huggingface.co/datasets/kltng/lcsh-db-lite/blob/${COMMIT}/releases/${RELEASE}/CHANGES.md`);
  });
});

describe('[P5 row6] fetching the pointer', () => {
  const okResponse = (body) => ({ status: 200, text: async () => JSON.stringify(body) });

  it('uses the fixed options, requires HTTP 200 and validates the body', async () => {
    const fetchImpl = vi.fn(async () => okResponse(pointer()));
    const value = await fetchPointer({ fetchImpl });
    expect(value.release).toBe(RELEASE);
    expect(fetchImpl).toHaveBeenCalledWith(POINTER_URL, expect.objectContaining({
      method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    }));
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(POINTER_URL).toBe('https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/main/latest.json');
  });

  it('a non-200 status is a server failure; a body that is not JSON is invalid_output', async () => {
    await expect(fetchPointer({ fetchImpl: async () => ({ status: 404, text: async () => '' }) }))
      .rejects.toMatchObject({ kind: 'server' });
    await expect(fetchPointer({ fetchImpl: async () => ({ status: 200, text: async () => '<html>' }) }))
      .rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('a network error is `network`, and the timeout aborts the request', async () => {
    await expect(fetchPointer({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }))
      .rejects.toMatchObject({ kind: 'network' });

    const fetchImpl = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    await expect(fetchPointer({ fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('the caller signal cancels the fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      controller.abort();
    }));
    await expect(fetchPointer({ fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(PointerError);
  });

  it('an error message never carries response text', async () => {
    const secret = 'SECRET-BODY-TEXT';
    const fetchImpl = async () => ({ status: 500, text: async () => secret });
    await expect(fetchPointer({ fetchImpl })).rejects.toSatisfy((err) => !JSON.stringify(err.message).includes(secret));
  });
});

// Review finding 13: the throttle governs only the AUTOMATIC check, and the
// validated pointer outlives any single Settings mount.
describe('[P5 fix13] the document-owned update checker', () => {
  const checkerOf = ({ stored = null, fetchImpl, now = () => 1790000000000 } = {}) => {
    const written = [];
    let last = stored;
    return {
      written,
      checker: createUpdateChecker({
        fetchPointerImpl: fetchImpl || (async () => validatePointer(pointer())),
        readCheck: async () => last,
        writeCheck: async (value) => {
          last = value;
          written.push(value);
        },
        now
      })
    };
  };

  it('the automatic check runs at most once per 24 h', async () => {
    const fetchImpl = vi.fn(async () => validatePointer(pointer()));
    const fresh = checkerOf({ stored: { lastCheckedAt: 1790000000000 - 1000, latestSeen: RELEASE }, fetchImpl });
    await fresh.checker.checkOnOpen(null);
    expect(fetchImpl).not.toHaveBeenCalled();

    const stale = checkerOf({ stored: { lastCheckedAt: 1000, latestSeen: RELEASE }, fetchImpl });
    // P6 fix 11: the automatic check needs an installed database.
    await stale.checker.checkOnOpen(INSTALLED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stale.written[0]).toEqual({ lastCheckedAt: 1790000000000, latestSeen: RELEASE });
  });

  // Security review (Phase 6) finding 3: with NO database installed, nothing
  // contacts Hugging Face until the user starts an install or asks to check.
  describe('[P6 fix11] no automatic check without an installed database', () => {
    it('fresh settings, page open: no pointer fetch and no throttle write', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('no network in tests'); });
      // The app's own wiring: the default fetcher and the stored throttle.
      const checker = createUpdateChecker({
        readCheck: () => localDbUpdateCheck(),
        writeCheck: (value) => localDbUpdateCheck(value)
      });
      const settings = await getSettings();
      expect(settings.localDb).toBeNull();
      await checker.checkOnOpen(settings.localDb);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(await localDbUpdateCheck()).toBeNull();
      expect(checker.pointer()).toBeNull();
    });

    it('an installed database: the 24 h check still runs', async () => {
      const fetchImpl = vi.fn(async () => validatePointer(pointer()));
      const { checker, written } = checkerOf({ stored: null, fetchImpl });
      await checker.checkOnOpen(INSTALLED);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(written).toHaveLength(1);
      // And it stays throttled for 24 h.
      await checker.checkOnOpen(INSTALLED);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('the install confirmation and "Check for a new release" still fetch with nothing installed', async () => {
      const fetchImpl = vi.fn(async () => validatePointer(pointer()));
      const { checker } = checkerOf({ stored: null, fetchImpl });
      await checker.checkOnOpen(null);
      expect(fetchImpl).not.toHaveBeenCalled();
      // Both user actions call refresh() (LocalDbPanel `ask`, `onCheckUpdate`).
      expect((await checker.refresh(null)).release).toBe(RELEASE);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  it('a manual refresh is ALWAYS allowed, even right after an automatic check', async () => {
    const fetchImpl = vi.fn(async () => validatePointer(pointer()));
    const { checker } = checkerOf({ stored: { lastCheckedAt: 1790000000000, latestSeen: RELEASE }, fetchImpl });
    await checker.checkOnOpen(null);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checker.pointer()).toBeNull();
    const value = await checker.refresh(null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(value.release).toBe(RELEASE);
    expect(checker.pointer().release).toBe(RELEASE);
  });

  it('a newer release raises the banner with its CHANGES.md link; an equal one does not', async () => {
    const { checker } = checkerOf();
    await checker.refresh({ release: '2026.09.26.1' });
    expect(checker.update()).toEqual({ release: RELEASE, changesUrl: changesUrl({ release: RELEASE, releaseCommit: COMMIT }) });
    await checker.refresh({ release: RELEASE });
    expect(checker.update()).toBeNull();
  });

  it('a failed check keeps the last good pointer and reports the reason', async () => {
    let fail = false;
    const { checker } = checkerOf({
      fetchImpl: async () => {
        if (fail) throw new PointerError('network');
        return validatePointer(pointer());
      }
    });
    await checker.refresh(null);
    fail = true;
    await checker.refresh(null);
    expect(checker.pointer().release).toBe(RELEASE);
    expect(checker.error()).toBe('Could not reach huggingface.co. Check your connection.');
  });

  it('a subscriber gets the snapshot immediately and on every change', async () => {
    const { checker } = checkerOf();
    const seen = [];
    const stop = checker.subscribe((value) => seen.push(value));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ pointer: null, error: null, update: null });
    await checker.refresh(null);
    expect(seen).toHaveLength(2);
    expect(seen[1].pointer.release).toBe(RELEASE);
    stop();
    await checker.refresh(null);
    expect(seen).toHaveLength(2);
  });
});

describe('[P5 row6] the pointer error never leaks response text', () => {
  it('a server body is not part of the message', async () => {
    const secret = 'SECRET-BODY-TEXT';
    const fetchImpl = async () => ({ status: 500, text: async () => secret });
    await expect(fetchPointer({ fetchImpl })).rejects.toSatisfy((err) => !JSON.stringify(err.message).includes(secret));
  });
});
