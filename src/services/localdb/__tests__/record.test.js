import { describe, it, expect } from 'vitest';
import { isPoolFileName, isValidRecord, validateLocalDbSnapshot } from '../record';
import { readLocalDbSettings, commitLocalDb, getSettings } from '../../settings';
import { fakes } from '../../../../test/setup';

const RECORD = {
  profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db',
  dbSize: 4096, sha256Db: 'b'.repeat(64), compatFingerprint: '2|NORMALIZE_V1|LH1|x', installedAt: '2026-09-27T00:00:00.000Z'
};

describe('[P5 fix1] canonical pool file names', () => {
  it('accepts exactly the spelling the pool reports', () => {
    for (const name of ['/db-1.db', '/stage-core-2026.09.27.1-aabbccdd.db', '/a', '/A_1.b']) {
      expect(isPoolFileName(name), name).toBe(true);
    }
  });

  it('rejects anything SQLite would normalize differently, or that is not a name at all', () => {
    for (const name of [
      'db-1.db', '//db-1.db', '/a/b.db', '/./db.db', '/a/../b.db', '/..', '/../db.db', '/', '',
      '/-leading-dash', null, undefined, 42, {}, '/db 1.db', '/db\n.db'
    ]) {
      expect(isPoolFileName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('[P5 fix1] a COMPLETE installed record', () => {
  it('accepts the record the installer writes', () => {
    expect(isValidRecord(RECORD)).toBe(true);
  });

  it('rejects a partial or wrongly typed record — the case that used to delete everything', () => {
    expect(isValidRecord({})).toBe(false);
    expect(isValidRecord(null)).toBe(false);
    expect(isValidRecord([])).toBe(false);
    expect(isValidRecord('x')).toBe(false);
    for (const [field, value] of [
      ['profile', 'tiny'], ['profile', undefined],
      ['release', ''], ['release', 3],
      ['releaseCommit', 'A'.repeat(40)], ['releaseCommit', 'a'.repeat(39)],
      ['file', 'db-1.db'], ['file', undefined],
      ['dbSize', 0], ['dbSize', -1], ['dbSize', 1.5], ['dbSize', '4096'],
      ['sha256Db', 'b'.repeat(63)], ['sha256Db', null],
      ['compatFingerprint', ''], ['installedAt', '']
    ]) {
      expect(isValidRecord({ ...RECORD, [field]: value }), `${field}=${String(value)}`).toBe(false);
    }
  });
});

describe('[P5 fix1] the whole snapshot', () => {
  const snapshot = (over = {}) => ({ lookupBackend: 'local-db', localDb: null, localDbPendingDeletes: [], ...over });

  it('accepts a clean snapshot, installed or not', () => {
    expect(validateLocalDbSnapshot(snapshot())).toEqual({ valid: true, reason: null });
    expect(validateLocalDbSnapshot(snapshot({ localDb: RECORD }))).toEqual({ valid: true, reason: null });
    expect(validateLocalDbSnapshot(snapshot({ localDbPendingDeletes: ['/old.db'] })).valid).toBe(true);
  });

  it('rejects a bad record, a bad pending list, and a pending entry that names the active file', () => {
    expect(validateLocalDbSnapshot(snapshot({ localDb: {} }))).toEqual({ valid: false, reason: 'record' });
    expect(validateLocalDbSnapshot(snapshot({ localDbPendingDeletes: 'x' }))).toEqual({ valid: false, reason: 'pending' });
    expect(validateLocalDbSnapshot(snapshot({ localDbPendingDeletes: ['bad'] }))).toEqual({ valid: false, reason: 'pending-name' });
    expect(validateLocalDbSnapshot(snapshot({ localDb: RECORD, localDbPendingDeletes: ['/db-1.db'] })))
      .toEqual({ valid: false, reason: 'pending-active' });
    expect(validateLocalDbSnapshot(null)).toEqual({ valid: false, reason: 'snapshot' });
    expect(validateLocalDbSnapshot([])).toEqual({ valid: false, reason: 'snapshot' });
  });
});

describe('[P5 fix1] settings.js reports validity without repairing anything', () => {
  it('a clean snapshot is valid, and the raw values are returned', async () => {
    fakes.storage.seed({ lookupBackend: 'local-db', localDb: RECORD, localDbPendingDeletes: ['/old.db'] });
    const read = await readLocalDbSettings();
    expect(read).toEqual({
      lookupBackend: 'local-db', localDb: RECORD, localDbPendingDeletes: ['/old.db'],
      valid: true, invalidReason: null
    });
  });

  it('an invalid record is reported, NOT silently repaired or dropped by the bridge read', async () => {
    fakes.storage.seed({ lookupBackend: 'local-db', localDb: { profile: 'core' } });
    const read = await readLocalDbSettings();
    expect(read.valid).toBe(false);
    expect(read.invalidReason).toBe('record');
    // The raw value is still there: nothing is rewritten behind the user's back.
    expect(read.localDb).toEqual({ profile: 'core' });
  });

  it('getSettings never hands an invalid record to the lookup or the UI', async () => {
    fakes.storage.seed({ lookupBackend: 'local-db', localDb: { profile: 'core' } });
    const settings = await getSettings();
    expect(settings.localDb).toBeNull();
    expect(settings.localDbInvalid).toBe(true);

    fakes.storage.seed({ localDb: RECORD });
    const good = await getSettings();
    expect(good.localDb).toEqual(RECORD);
    expect(good.localDbInvalid).toBe(false);
  });

  it('a commit still writes through the allowlist and the structural compare', async () => {
    expect(await commitLocalDb({ expectedLocalDb: null, patch: { localDb: RECORD } })).toMatchObject({ ok: true });
    expect((await readLocalDbSettings()).valid).toBe(true);
  });
});
