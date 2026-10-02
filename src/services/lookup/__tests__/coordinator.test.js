import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createCoordinator, effectiveBackend, isLocalAuthority, LOCAL_DB_ERROR } from '../coordinator';
import { getLookupBackend, fallbackNotice, FALLBACK_NOTICES } from '../index';
import { createScheduler, createRunCache, LookupError } from '../scheduler';
import { outcomeOf } from '../locApi';
import { EVIDENCE, mockLoc, fastSchedulerOptions } from '../../../../test/locFixtures';
import { openFixture } from '../../../../test/localDbFixtures';
import { builtRun } from '../../../../test/pipelineFixtures';
import { buildHistoryEntry, saveHistoryEntry, loadHistory } from '../../history';
import { viaNote } from '../../../components/pipelineText';

const IDENTITY = {
  core: { profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/lcsh-core.db' },
  full: { profile: 'full', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/lcsh-full.db' }
};

const fixtures = {};
beforeAll(async () => {
  fixtures.core = await openFixture('core');
  fixtures.full = await openFixture('full');
});
afterAll(() => {
  fixtures.core?.close();
  fixtures.full?.close();
});

/**
 * A local backend over a real fixture database, with the identity fence of
 * §6.5 and optional failure injection per named query.
 */
const localOf = (profile, { fail = {}, active = IDENTITY[profile], delay = {} } = {}) => {
  const calls = [];
  // The identity the client would report right now; a test can change it
  // between lookups (review finding 8).
  const live = { value: IDENTITY[profile] };
  const query = vi.fn(async (name, args) => {
    calls.push(name);
    if (args.signal?.aborted) throw new LookupError('cancelled');
    // The worker compares ALL FOUR identity fields.
    if (['profile', 'release', 'releaseCommit', 'file'].some((f) => args.identity?.[f] !== active[f])) {
      const err = new Error('The local database changed');
      err.kind = 'db_generation_changed';
      throw err;
    }
    if (fail[name]) throw fail[name];
    if (delay[name]) await delay[name];
    return fixtures[profile].query(name, args);
  });
  return { live, installation: () => live.value, query, calls };
};

/** A local backend over fixed rows, with a fixed installation. */
const staticLocal = (profile, query) => ({ installation: () => IDENTITY[profile], query });

const backend = (local, scheduler = createScheduler(fastSchedulerOptions)) =>
  createCoordinator({ scheduler, cache: createRunCache(), local });

const cids = (raw) => raw.candidates.map((c) => `${c.cid} ${c.matchClass} ${c.via}`);
const locKeys = (raw) => raw.requests.filter((r) => !r.startsWith('local:'));
const localKeys = (raw) => raw.requests.filter((r) => r.startsWith('local:'));
/** The local requests of one authority, in order (parts of a stage interleave). */
const forAuthority = (raw, authority) => localKeys(raw).filter((r) => r.endsWith(`:${authority}`));

describe('[P5 row5] routing: which backend holds which authority', () => {
  it('no installation → every authority online', () => {
    expect(isLocalAuthority(null, 'lcsh')).toBe(false);
    expect(effectiveBackend(null, ['lcsh', 'lcnaf'])).toBe('loc-api');
  });

  it('full holds every authority; core holds everything but names', () => {
    for (const a of ['lcsh', 'lcgft', 'lcnaf']) expect(isLocalAuthority('full', a)).toBe(true);
    expect(isLocalAuthority('core', 'lcsh')).toBe(true);
    expect(isLocalAuthority('core', 'lcgft')).toBe(true);
    expect(isLocalAuthority('core', 'lcnaf')).toBe(false);
  });

  it('the effective backend of a lookup follows its route', () => {
    expect(effectiveBackend('full', ['lcnaf', 'lcsh'])).toBe('local-db');
    expect(effectiveBackend('core', ['lcsh'])).toBe('local-db');
    expect(effectiveBackend('core', ['lcnaf', 'lcsh'])).toBe('mixed');
    expect(effectiveBackend('core', ['lcsh', 'lcnaf', 'lcgft'])).toBe('mixed');
  });
});

describe('[P5 row5] loc-api: the P4 request sequences are unchanged', () => {
  it('a simple topical stops on exact-full after stage 1', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const raw = await backend(null).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Cats"']);
    expect(raw.requests).toEqual(['https://id.loc.gov/authorities/subjects/suggest2?q=Cats&count=10&searchtype=leftanchored']);
    expect(cids(raw)).toEqual(['lcsh:sh85021262 exact-full undefined']);
    expect(raw.provenance).toEqual({ backend: 'loc-api', profile: null, release: null, releaseCommit: null, file: null });
    expect(raw.replacementNotes).toEqual([]);
  });

  it('a name runs S1, S2, S3 on the first routed authority and then S4 on lcnaf', async () => {
    const loc = mockLoc({
      'lcnaf keyword "Kurosawa, Akira Criticism and interpretation"': [EVIDENCE.japanSubdivision],
      'lcnaf keyword "Kurosawa, Akira"': [EVIDENCE.kurosawa]
    });
    const raw = await backend(null).lookup({ id: 's1', heading: 'Kurosawa, Akira--Criticism and interpretation', kind: 'name' });
    expect(loc.keys()).toEqual([
      'lcnaf leftanchored "Kurosawa, Akira--Criticism and interpretation"',
      'lcsh leftanchored "Kurosawa, Akira--Criticism and interpretation"',
      'lcnaf leftanchored "Kurosawa, Akira"',
      'lcsh leftanchored "Kurosawa, Akira"',
      'lcnaf keyword "Kurosawa, Akira Criticism and interpretation"',
      'lcnaf keyword "Kurosawa, Akira"'
    ]);
    expect(cids(raw)).toEqual(['lcnaf:n79091264 prefix-main undefined']);
  });

  it('an exact-main after stage 2 skips stage 3, so stage 4 never follows', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Kyoto (Japan)"': [EVIDENCE.kyotoName] });
    const raw = await backend(null).lookup({ id: 's1', heading: 'Kyoto (Japan)--Intellectual life', kind: 'geographic' });
    expect(loc.keys()).toEqual([
      'lcsh leftanchored "Kyoto (Japan)--Intellectual life"',
      'lcnaf leftanchored "Kyoto (Japan)--Intellectual life"',
      'lcsh leftanchored "Kyoto (Japan)"',
      'lcnaf leftanchored "Kyoto (Japan)"'
    ]);
    expect(cids(raw)).toEqual(['lcnaf:n80024170 exact-main undefined']);
  });

  it('getLookupBackend without an installation builds the online coordinator', () => {
    mockLoc({});
    expect(getLookupBackend({ lookupBackend: 'loc-api' }).id).toBe('loc-api');
    expect(getLookupBackend({ lookupBackend: 'local-db', localDb: null }).id).toBe('loc-api');
    expect(getLookupBackend({ lookupBackend: 'local-db', localDb: { profile: 'core' } }, { client: null }).id).toBe('loc-api');
  });
});

describe('[P5 row5] local-db full: every authority is answered locally', () => {
  it('Q1 then Q2 per authority; an exact-full stops after stage 1', async () => {
    const loc = mockLoc({});
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(loc.fetch).not.toHaveBeenCalled();
    expect(raw.requests).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh']);
    expect(cids(raw)).toEqual(['lcsh:sh85021262 exact-full label']);
    expect(raw.provenance).toEqual({ backend: 'local-db', ...IDENTITY.full });
    expect(raw.failures).toEqual([]);
  });

  it('a name is answered locally, and its LCNAF row has no MARC key', async () => {
    const loc = mockLoc({});
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Beijing da xue', kind: 'name' });
    expect(loc.fetch).not.toHaveBeenCalled();
    expect(forAuthority(raw, 'lcnaf')).toEqual(['local:Q1:lcnaf', 'local:Q2:lcnaf']);
    expect(forAuthority(raw, 'lcsh')).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh']);
    expect(cids(raw)).toEqual(['lcnaf:n80030740 exact-full label']);
    expect(raw.candidates[0].marcKey).toBeNull();
    expect(raw.candidates[0].source).toBe('local-db');
  });

  it('a variant match (Q2) is a candidate whose class comes from its own preferred label', async () => {
    mockLoc({});
    const raw = await backend(localOf('full')).lookup({ id: 's1', heading: '北京大学', kind: 'name' });
    expect(cids(raw)).toEqual(['lcnaf:n80030740 keyword variant']);
    expect(raw.candidates[0].label).toBe('Beijing da xue');
  });

  it('stage 3 runs the FTS on the first routed authority only', async () => {
    mockLoc({});
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Felis', kind: 'topical' });
    expect(raw.requests).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh', 'local:Q3a:lcsh', 'local:Q3b:lcsh']);
    // "Felis" is only in a VARIANT label of Cats, so the hit came from Q3b
    // (P6 fix 11: it was mislabeled `label` before).
    expect(cids(raw)).toEqual(['lcsh:sh85021262 keyword variant']);
  });

  it('stage 4 runs on LCNAF when stage 3 succeeded with no accepted candidate and the kind is a name', async () => {
    mockLoc({});
    const raw = await backend(localOf('full')).lookup({ id: 's1', heading: 'Yamashita--Zzznothing', kind: 'name' });
    expect(localKeys(raw)).toContain('local:Q3a:lcnaf');
    // Stage 3 is on lcnaf (first routed), stage 4 on lcnaf again with the main heading.
    expect(localKeys(raw).filter((r) => r.startsWith('local:Q3a'))).toEqual(['local:Q3a:lcnaf', 'local:Q3a:lcnaf']);
  });

  it('stage 4 does not run for a topical kind, nor after a failed stage 3', async () => {
    mockLoc({});
    const topical = await backend(localOf('full')).lookup({ id: 's1', heading: 'Zzznothing', kind: 'topical' });
    expect(localKeys(topical)).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh', 'local:Q3a:lcsh', 'local:Q3b:lcsh']);

    const broken = localOf('full', { fail: { Q3a: new Error('x') } });
    const name = await backend(broken).lookup({ id: 's1', heading: 'Zzznothing', kind: 'name' });
    expect(name.failures).toEqual([LOCAL_DB_ERROR]);
    expect(localKeys(name).filter((r) => r.startsWith('local:Q3'))).toEqual(['local:Q3a:lcnaf', 'local:Q3b:lcnaf']);
  });
});

describe('[P5 row5] local-db core: mixed routing', () => {
  it('lcsh and lcgft go local, lcnaf goes to LOC', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Beijing da xue"': [EVIDENCE.harvard] });
    const local = localOf('core');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Beijing da xue', kind: 'name' });
    // lcnaf is the first routed authority, so stages 3 and 4 are online too;
    // stage 4 repeats stage 3's URL and is served from the run cache.
    expect(loc.keys()).toEqual(['lcnaf leftanchored "Beijing da xue"', 'lcnaf keyword "Beijing da xue"']);
    expect(locKeys(raw)).toHaveLength(3);
    expect(local.calls).toEqual(['Q1', 'Q2']);
    expect(forAuthority(raw, 'lcsh')).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh']);
    expect(raw.provenance).toEqual({ backend: 'mixed', ...IDENTITY.core });
    expect(cids(raw)).toEqual(['lcnaf:n78096930 keyword undefined']);
  });

  it('a genre lookup is fully local with core (lcgft and lcsh are both held)', async () => {
    const loc = mockLoc({});
    const raw = await backend(localOf('core')).lookup({ id: 's1', heading: 'Gravity anomaly maps', kind: 'genre' });
    expect(loc.fetch).not.toHaveBeenCalled();
    expect(raw.provenance.backend).toBe('local-db');
    expect(cids(raw)).toEqual(['lcgft:gf2010025067 exact-full label']);
  });

  it('the pooled stop condition sees both backends: a local exact-full stops the online stage too', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Cats"': [EVIDENCE.kurosawa] });
    const raw = await backend(localOf('core')).lookup({ id: 's1', heading: 'Cats', kind: 'unknown' });
    // Stage 1 runs on all three routed authorities before the stop check.
    expect(loc.keys()).toEqual(['lcnaf leftanchored "Cats"']);
    expect(raw.candidates.map((c) => c.cid)).toEqual(['lcsh:sh85021262', 'lcnaf:n79091264']);
    expect(raw.candidates[0].matchClass).toBe('exact-full');
  });
});

describe('[P5 row5] deprecated rows, replacements and notes', () => {
  it('a deprecated hit is rejected, adds its Q4 hop, and unresolved targets become notes', async () => {
    mockLoc({});
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Child concentration camp inmates', kind: 'topical' });
    // Q1 hits the deprecated row (rejected) and Q4 follows it; the same row
    // comes back from stage 3's FTS and is rejected again, without a new hop.
    expect(local.calls).toEqual(['Q1', 'Q4', 'Q2', 'Q3a', 'Q3b']);
    expect(raw.rejectedHits).toBe(2);
    expect(raw.candidates).toEqual([]);
    expect(raw.replacementNotes.map((n) => `${n.targetLocalId} ${n.reason}`))
      .toEqual(['sh2021004026 not-in-database', 'sh2021004027 not-in-database']);
    expect(raw.replacementNotes[0].fromLabel).toBe('Child concentration camp inmates');
    expect(raw.requests).toContain('local:Q4:lcsh');
  });

  it('a replacement that exists becomes a candidate classed on its OWN label', async () => {
    mockLoc({});
    const rows = {
      Q1: [{ id: 1, uri: 'sh00000273', authority: 'lcsh', label: 'Old heading', deprecated: 1, marc_key: null }],
      Q2: [],
      Q4: [{
        target_authority: 'lcsh', target_uri: 'sh2021004026',
        id: 2, uri: 'sh2021004026', authority: 'lcsh', label: 'Old heading', deprecated: 0, marc_key: '150  $aOld heading'
      }]
    };
    const local = staticLocal('full', async (name) => rows[name] || []);
    const raw = await backend(local).lookup({ id: 's1', heading: 'Old heading', kind: 'topical' });
    expect(cids(raw)).toEqual(['lcsh:sh2021004026 exact-full replacement']);
    expect(raw.candidates[0].replacementFrom).toEqual([{ authority: 'lcsh', localId: 'sh00000273', label: 'Old heading' }]);
    expect(raw.replacementNotes).toEqual([]);
    // The exact-full replacement stops the search after stage 1.
    expect(raw.requests).toEqual(['local:Q1:lcsh', 'local:Q4:lcsh', 'local:Q2:lcsh']);
  });

  it('the dedupe merges the replacementFrom entries of duplicates into the surviving candidate', async () => {
    mockLoc({});
    const target = (label) => ({
      target_authority: 'lcsh', target_uri: 'sh999',
      id: 3, uri: 'sh999', authority: 'lcsh', label, deprecated: 0, marc_key: null
    });
    const local = staticLocal('full', async (name) => {
      if (name === 'Q1') {
        return [
          { id: 1, uri: 'shA', authority: 'lcsh', label: 'Old A', deprecated: 1, marc_key: null },
          { id: 2, uri: 'shB', authority: 'lcsh', label: 'Old A', deprecated: 1, marc_key: null }
        ];
      }
      if (name === 'Q4') return [target('New heading')];
      return [];
    });
    const raw = await backend(local).lookup({ id: 's1', heading: 'Old A', kind: 'topical' });
    expect(raw.candidates).toHaveLength(1);
    expect(raw.candidates[0].replacementFrom).toEqual([
      { authority: 'lcsh', localId: 'shA', label: 'Old A' },
      { authority: 'lcsh', localId: 'shB', label: 'Old A' }
    ]);
  });
});

describe('[P5 row5] failures, outcomes, cancellation and the identity fence', () => {
  it('a failed local part adds the local_db kind and keeps the candidates of the parts that finished', async () => {
    mockLoc({});
    const local = localOf('full', { fail: { Q3b: new Error('disk') } });
    // Stage 3 runs on lcgft: Q3a finds "Gravity anomaly maps", then Q3b fails.
    const raw = await backend(local).lookup({ id: 's1', heading: 'Gravity anomaly', kind: 'genre' });
    expect(local.calls).toEqual(['Q1', 'Q1', 'Q2', 'Q2', 'Q3a', 'Q3b']);
    expect(raw.failures).toEqual([LOCAL_DB_ERROR]);
    expect(raw.candidates.map((c) => c.cid)).toEqual(['lcgft:gf2010025067']);
    expect(outcomeOf(raw)).toEqual({ outcome: 'partial', errorKind: LOCAL_DB_ERROR });
  });

  it('every local part failing with no candidate is `failed` with local_db', async () => {
    mockLoc({});
    const local = localOf('full', { fail: { Q1: new Error('a'), Q2: new Error('b'), Q3a: new Error('c'), Q3b: new Error('d') } });
    const raw = await backend(local).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(raw.failures).toEqual([LOCAL_DB_ERROR, LOCAL_DB_ERROR, LOCAL_DB_ERROR, LOCAL_DB_ERROR]);
    expect(outcomeOf(raw)).toEqual({ outcome: 'failed', errorKind: LOCAL_DB_ERROR });
  });

  it('a query for an identity that is no longer active fails that part, never returns rows', async () => {
    mockLoc({});
    const local = localOf('full', { active: { file: '/another.db' } });
    const raw = await backend(local).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(raw.candidates).toEqual([]);
    expect(raw.failures.every((f) => f === LOCAL_DB_ERROR)).toBe(true);
    expect(outcomeOf(raw).outcome).toBe('failed');
  });

  it('offline with an LOC part required: partial when local found something, failed when not', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const found = await backend(localOf('core')).lookup({ id: 's1', heading: 'Cats', kind: 'unknown' });
    expect(found.failures).toContain('network');
    expect(outcomeOf(found)).toEqual({ outcome: 'partial', errorKind: 'network' });

    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const nothing = await backend(localOf('core')).lookup({ id: 's1', heading: 'Zzznothing', kind: 'name' });
    expect(outcomeOf(nothing)).toEqual({ outcome: 'failed', errorKind: 'network' });
  });

  it('a stage legitimately skipped by the stop rule is not a failure', async () => {
    mockLoc({});
    const raw = await backend(localOf('full')).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(raw.failures).toEqual([]);
    expect(outcomeOf(raw)).toEqual({ outcome: 'found', errorKind: null });
  });

  it('cancellation settles at once, marks the result incomplete and commits nothing later', async () => {
    mockLoc({});
    const controller = new AbortController();
    const local = localOf('full');
    const original = local.query;
    local.query = async (name, args) => {
      if (name === 'Q2') controller.abort();
      return original(name, args);
    };
    const raw = await backend(local).lookup({ id: 's1', heading: 'Zzznothing', kind: 'topical', signal: controller.signal }, { signal: controller.signal });
    expect(raw.incomplete).toBe(true);
    expect(localKeys(raw)).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh']);
    expect(outcomeOf({ ...raw, incompleteKind: 'timeout' }).errorKind).toBe('timeout');
  });

  it('an already aborted signal stops after the first stage', async () => {
    mockLoc({});
    const controller = new AbortController();
    controller.abort();
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: 'Zzznothing', kind: 'unknown' }, { signal: controller.signal });
    expect(raw.incomplete).toBe(true);
    expect(raw.failures.every((f) => f === 'cancelled')).toBe(true);
  });

  it('a heading that must not be searched makes no query at all', async () => {
    mockLoc({});
    const local = localOf('full');
    const raw = await backend(local).lookup({ id: 's1', heading: '--History', kind: 'topical' });
    expect(local.calls).toEqual([]);
    expect(raw.requests).toEqual([]);
    expect(raw.provenance.backend).toBe('local-db');
  });
});

describe('[P5 row5] ranking keeps the original authority, stage and row indices', () => {
  it('an exact hit from the second routed authority beats ten weak hits from the first', async () => {
    mockLoc({});
    const weak = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i, uri: `sh90${i}`, authority: 'lcsh', label: `Zzz other ${i}`, deprecated: 0, marc_key: null
    }));
    const local = staticLocal('full', async (name, args) => {
      if (name === 'Q1' && args.authorities[0] === 'lcsh') return weak;
      if (name === 'Q1' && args.authorities[0] === 'lcnaf') {
        return [{ id: 1, uri: 'n1', authority: 'lcnaf', label: 'Japan', deprecated: 0, marc_key: '151  $aJapan' }];
      }
      return [];
    });
    const raw = await backend(local).lookup({ id: 's1', heading: 'Japan', kind: 'geographic' }, { limit: 4 });
    expect(raw.candidates.map((c) => c.cid)).toEqual(['lcnaf:n1', 'lcsh:sh900', 'lcsh:sh901', 'lcsh:sh902']);
    expect(raw.candidates[0].matchClass).toBe('exact-full');
  });
});

// Review finding 8: the identity is read at every lookup ATTEMPT.
describe('[P5 fix8] the installation identity is taken per lookup attempt', () => {
  it('a Retry after a repair uses the NEW file, not the one frozen at backend creation', async () => {
    mockLoc({});
    const local = localOf('full');
    const coordinator = backend(local);
    expect((await coordinator.lookup({ id: 's1', heading: 'Cats', kind: 'topical' })).provenance.file)
      .toBe(IDENTITY.full.file);

    // The database was repaired: the client now reports a new file, and only
    // that one answers.
    const repaired = { ...IDENTITY.full, file: '/lcsh-full-2.db', release: '2026.09.28.1' };
    local.live.value = repaired;
    const original = local.query;
    local.query = async (name, args) => {
      if (args.identity.file !== repaired.file) {
        const err = new Error('changed');
        err.kind = 'db_generation_changed';
        throw err;
      }
      return fixtures.full.query(name, args);
    };
    const retry = await coordinator.lookup({ id: 's1', heading: 'Cats', kind: 'topical' }, { bypassCache: true });
    expect(retry.provenance.file).toBe('/lcsh-full-2.db');
    expect(retry.provenance.release).toBe('2026.09.28.1');
    expect(retry.candidates.map((c) => c.cid)).toEqual(['lcsh:sh85021262']);
    expect(retry.failures).toEqual([]);
    expect(original).toBeTypeOf('function');
  });

  it('the snapshot stays IMMUTABLE for all queries of one attempt', async () => {
    mockLoc({});
    const local = localOf('full');
    const seen = [];
    const original = local.query;
    local.query = async (name, args) => {
      seen.push(args.identity);
      // The installation changes while this lookup is still running.
      local.live.value = { ...IDENTITY.full, file: '/changed-midway.db' };
      return original(name, args);
    };
    await backend(local).lookup({ id: 's1', heading: 'Zzznothing', kind: 'topical' });
    expect(seen.length).toBeGreaterThan(1);
    for (const identity of seen) expect(identity.file).toBe(IDENTITY.full.file);
  });

  it('an installation that disappeared makes the attempt route online, with online provenance', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const local = localOf('full');
    local.live.value = null;
    const raw = await backend(local).lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(local.calls).toEqual([]);
    expect(loc.keys()).toEqual(['lcsh leftanchored "Cats"']);
    expect(raw.provenance).toEqual({ backend: 'loc-api', profile: null, release: null, releaseCommit: null, file: null });
  });

  it('a profile change between attempts changes the routing of the next attempt', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Beijing da xue"': [EVIDENCE.harvard] });
    const local = localOf('full');
    const coordinator = backend(local);
    const full = await coordinator.lookup({ id: 's1', heading: 'Beijing da xue', kind: 'name' });
    expect(full.provenance.backend).toBe('local-db');
    expect(loc.fetch).not.toHaveBeenCalled();

    local.live.value = { ...IDENTITY.core };
    const core = await coordinator.lookup({ id: 's2', heading: 'Beijing da xue', kind: 'name' });
    expect(core.provenance.backend).toBe('mixed');
    expect(loc.keys()).toContain('lcnaf leftanchored "Beijing da xue"');
  });
});

describe('[P5 row5] the fallback notice is visible, never silent', () => {
  it('names the reason the online backend is used although local-db is selected', () => {
    expect(fallbackNotice({ lookupBackend: 'loc-api' }, null)).toBeNull();
    expect(fallbackNotice({ lookupBackend: 'local-db', localDb: null }, null)).toBe(FALLBACK_NOTICES['not-installed']);
    expect(fallbackNotice({ lookupBackend: 'local-db', localDb: { profile: 'core' } }, null))
      .toBe(FALLBACK_NOTICES['other-tab']);
    for (const state of ['repair-needed', 'recovery-unavailable', 'worker-failed']) {
      expect(fallbackNotice({ lookupBackend: 'local-db', localDb: { profile: 'core' } }, { state: () => state }))
        .toBe(FALLBACK_NOTICES[state]);
    }
    expect(fallbackNotice({ lookupBackend: 'local-db', localDb: { profile: 'core' } }, { state: () => 'ready' })).toBeNull();
  });
});

// Correctness review (Phase 6) finding 1: a keyword hit found ONLY through a
// variant label (Q3b) is `via: 'variant'` (SPEC-P5 §5, §8, §9).
describe('[P6 fix11] local FTS keeps where a row was found', () => {
  const row = (id, uri, label) => ({ id, uri, authority: 'lcsh', label, deprecated: 0, marc_key: `150  $a${label}` });
  const BOTH = row(1, 'sh85021262', 'Cats');
  const VARIANT_ONLY = row(2, 'sh85007901', 'Felidae');
  const LABEL_ONLY = row(3, 'sh85021263', 'Cats in art');
  const rows = { Q1: [], Q2: [], Q3a: [BOTH, LABEL_ONLY], Q3b: [BOTH, VARIANT_ONLY] };
  const lookup = () => backend(staticLocal('full', async (name) => (rows[name] || []).map((r) => ({ ...r }))))
    .lookup({ id: 's1', heading: 'Felis catus', kind: 'topical' });

  it('Q3a only → label; Q3b only → variant; found by both → label', async () => {
    mockLoc({});
    const raw = await lookup();
    expect(raw.requests).toEqual(['local:Q1:lcsh', 'local:Q2:lcsh', 'local:Q3a:lcsh', 'local:Q3b:lcsh']);
    const viaOf = Object.fromEntries(raw.candidates.map((c) => [c.localId, c.via]));
    expect(viaOf).toEqual({ sh85021262: 'label', sh85021263: 'label', sh85007901: 'variant' });
  });

  it('the variant provenance survives the Matches note and a history save and reload', async () => {
    mockLoc({});
    const raw = await lookup();
    const variant = raw.candidates.find((c) => c.localId === 'sh85007901');
    expect(viaNote(variant)).toBe('matched a variant name');
    expect(viaNote(raw.candidates.find((c) => c.localId === 'sh85021262'))).toBeFalsy();

    const run = builtRun();
    const results = { ...run.lookup.results, s1: { ...run.lookup.results.s1, candidates: raw.candidates } };
    const entry = buildHistoryEntry({ run: { ...run, lookup: { ...run.lookup, results } }, id: 'e-via', timestamp: '2026-10-01T00:00:00.000Z' });
    await saveHistoryEntry(entry);
    const [stored] = await loadHistory();
    const saved = stored.lookup.results.find((r) => r.suggestionId === 's1').candidates;
    expect(Object.fromEntries(saved.map((c) => [c.localId, c.via])))
      .toEqual({ sh85021262: 'label', sh85021263: 'label', sh85007901: 'variant' });
  });
});
