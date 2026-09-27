import { describe, it, expect } from 'vitest';
import { createLocApiBackend, rankCandidates, matchClassOf, outcomeOf, ROUTING, buildSearchUrl } from '../locApi';
import { getLookupBackend } from '../index';
import { createScheduler, createRunCache } from '../scheduler';
import { toSearch } from '../searchText';
import { response } from '../../../../test/setup';
import { hit, EVIDENCE, mockLoc, fastSchedulerOptions } from '../../../../test/locFixtures';

const backendOf = () => createLocApiBackend({ scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache() });
const cids = (raw) => raw.candidates.map((c) => `${c.cid} ${c.matchClass}`);

describe('[P4 row5] locApi stages: exact request lists', () => {
  it('a simple topical: S1 on LCSH, exact-full, early stop', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Cats"']);
    expect(cids(raw)).toEqual(['lcsh:sh85021262 exact-full']);
    expect(loc.fetch.mock.calls[0][0]).toBe('https://id.loc.gov/authorities/subjects/suggest2?q=Cats&count=10&searchtype=leftanchored');
  });

  it('Kyoto (Japan)--Intellectual life--21st century (geographic): S1 nothing, S2 finds n80024170 as exact-main; LCSH 181 hits rejected; no S3', async () => {
    const loc = mockLoc({
      'lcsh leftanchored "Kyoto (Japan)"': [EVIDENCE.kyotoSubdivision],
      'lcnaf leftanchored "Kyoto (Japan)"': [EVIDENCE.kyotoName]
    });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Kyoto (Japan)--Intellectual life--21st century', kind: 'geographic' });
    expect(loc.keys()).toEqual([
      'lcsh leftanchored "Kyoto (Japan)--Intellectual life--21st century"',
      'lcnaf leftanchored "Kyoto (Japan)--Intellectual life--21st century"',
      'lcsh leftanchored "Kyoto (Japan)"',
      'lcnaf leftanchored "Kyoto (Japan)"'
    ]);
    expect(cids(raw)).toEqual(['lcnaf:n80024170 exact-main']);
    expect(raw.rejectedHits).toBe(1);
  });

  it('Japan--History (geographic): S1 exact-full sh85069426 on both routed authorities, then stop', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Japan--History"': [EVIDENCE.japanHistory] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Japan -- History', kind: 'geographic' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Japan--History"', 'lcnaf leftanchored "Japan--History"']);
    expect(cids(raw)).toEqual(['lcsh:sh85069426 exact-full']);
  });

  it('a name: S1, S2 (lcnaf, lcsh), S3 keyword on lcnaf with no accepted hit, then S4 keyword main on lcnaf', async () => {
    const loc = mockLoc({
      'lcnaf keyword "Kurosawa, Akira Criticism and interpretation"': [EVIDENCE.japanSubdivision],
      'lcnaf keyword "Kurosawa, Akira"': [EVIDENCE.kurosawa]
    });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Kurosawa, Akira--Criticism and interpretation', kind: 'name' });
    expect(loc.keys()).toEqual([
      'lcnaf leftanchored "Kurosawa, Akira--Criticism and interpretation"',
      'lcsh leftanchored "Kurosawa, Akira--Criticism and interpretation"',
      'lcnaf leftanchored "Kurosawa, Akira"',
      'lcsh leftanchored "Kurosawa, Akira"',
      'lcnaf keyword "Kurosawa, Akira Criticism and interpretation"',
      'lcnaf keyword "Kurosawa, Akira"'
    ]);
    expect(cids(raw)).toEqual(['lcnaf:n79091264 prefix-main']);
  });

  it('unknown: S1 on lcsh, lcnaf and lcgft; an exact-full stops the search', async () => {
    const loc = mockLoc({ 'lcgft leftanchored "Biographical films"': [EVIDENCE.biographicalFilms] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Biographical films', kind: 'unknown' });
    expect(loc.keys()).toEqual([
      'lcsh leftanchored "Biographical films"', 'lcnaf leftanchored "Biographical films"', 'lcgft leftanchored "Biographical films"'
    ]);
    expect(cids(raw)).toEqual(['lcgft:gf2011026089 exact-full']);
  });

  it('unknown with nothing anywhere: S3 keyword on lcsh, then S4 keyword main on lcnaf', async () => {
    const loc = mockLoc();
    const raw = await backendOf().lookup({ id: 's1', heading: 'Zzyzx--Maps', kind: 'unknown' });
    expect(loc.keys()).toEqual([
      'lcsh leftanchored "Zzyzx--Maps"', 'lcnaf leftanchored "Zzyzx--Maps"', 'lcgft leftanchored "Zzyzx--Maps"',
      'lcsh leftanchored "Zzyzx"', 'lcnaf leftanchored "Zzyzx"', 'lcgft leftanchored "Zzyzx"',
      'lcsh keyword "Zzyzx Maps"', 'lcnaf keyword "Zzyzx"'
    ]);
    expect(raw.candidates).toEqual([]);
  });

  it('early stop on exact-full after S1: no S2 even when main ≠ full', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Motion pictures--Japan--History"': [EVIDENCE.motionPicturesJapanHistory] });
    await backendOf().lookup({ id: 's1', heading: 'Motion pictures--Japan--History', kind: 'topical' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Motion pictures--Japan--History"']);
  });

  it('an exact-main in S2 skips S3, and S4 never follows a skipped S3 (name)', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Harvard University"': [EVIDENCE.harvard] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Harvard University--Students', kind: 'name' });
    expect(loc.keys()).toEqual([
      'lcnaf leftanchored "Harvard University--Students"', 'lcsh leftanchored "Harvard University--Students"',
      'lcnaf leftanchored "Harvard University"', 'lcsh leftanchored "Harvard University"'
    ]);
    expect(cids(raw)).toEqual(['lcnaf:n78096930 exact-main']);
  });

  it('S4 does not run when S3 failed, nor when S3 returned an accepted candidate, nor for topical', async () => {
    let loc = mockLoc({ 'lcnaf keyword "Nobody"': response({}, { status: 500 }) });
    await backendOf().lookup({ id: 's1', heading: 'Nobody', kind: 'name' });
    expect(loc.keys().at(-1)).toBe('lcnaf keyword "Nobody"');
    loc = mockLoc({ 'lcnaf keyword "Kurosawa"': [EVIDENCE.kurosawa] });
    await backendOf().lookup({ id: 's1', heading: 'Kurosawa', kind: 'name' });
    expect(loc.keys().filter((k) => k.includes('keyword'))).toEqual(['lcnaf keyword "Kurosawa"']);
    loc = mockLoc();
    await backendOf().lookup({ id: 's1', heading: 'Nothing here', kind: 'topical' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Nothing here"', 'lcsh keyword "Nothing here"']);
  });

  it('all routed requests of a stage complete before the stop check (a slow LCNAF answer is still pooled)', async () => {
    const loc = mockLoc({
      'lcsh leftanchored "Japan"': [EVIDENCE.japanHistory],
      'lcnaf leftanchored "Japan"': () => new Promise((resolve) => setTimeout(() => resolve(response({ hits: [EVIDENCE.japanName] })), 20))
    });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Japan', kind: 'geographic' });
    expect(loc.keys()).toEqual(['lcsh leftanchored "Japan"', 'lcnaf leftanchored "Japan"']);
    expect(cids(raw)).toEqual(['lcnaf:n78089021 exact-full', 'lcsh:sh85069426 prefix-full']);
  });

  it('the per-run cache: a repeated lookup makes no request; Retry lookup bypasses completed entries', async () => {
    const loc = mockLoc({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] });
    const backend = backendOf();
    const first = await backend.lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    // Same URL (the trailing period is removed before the search): answered from the cache.
    const again = await backend.lookup({ id: 's2', heading: 'Cats.', kind: 'topical' });
    expect(loc.fetch).toHaveBeenCalledTimes(1);
    expect(cids(again)).toEqual(cids(first));
    await backend.lookup({ id: 's1', heading: 'Cats', kind: 'topical' }, { bypassCache: true });
    expect(loc.fetch).toHaveBeenCalledTimes(2);
    // A new run gets a new backend and a new cache.
    await backendOf().lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(loc.fetch).toHaveBeenCalledTimes(3);
  });

  it('the routing table and the backend factory', () => {
    expect(ROUTING).toEqual({
      topical: ['lcsh'], geographic: ['lcsh', 'lcnaf'], name: ['lcnaf', 'lcsh'], genre: ['lcgft', 'lcsh'], unknown: ['lcsh', 'lcnaf', 'lcgft']
    });
    expect(buildSearchUrl('lcgft', 'a b', 'keyword')).toBe('https://id.loc.gov/authorities/genreForms/suggest2?q=a+b&count=10&searchtype=keyword');
    expect(getLookupBackend({ lookupBackend: 'loc-api' }).id).toBe('loc-api');
    expect(getLookupBackend({}).id).toBe('loc-api');
    expect(() => getLookupBackend({ lookupBackend: 'local-db' })).toThrow();
  });
});

describe('[P4 row6] ranking', () => {
  it('rank before limit: an exact hit from the 2nd authority survives 10 weak hits from the 1st', async () => {
    const weak = Array.from({ length: 10 }, (_, i) => hit('lcsh', `sh900000${i}`, `Japan--Weak ${i}`));
    mockLoc({ 'lcsh leftanchored "Japan"': weak, 'lcnaf leftanchored "Japan"': [EVIDENCE.japanName] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Japan', kind: 'geographic' }, { limit: 10 });
    expect(raw.candidates).toHaveLength(10);
    expect(raw.candidates[0]).toMatchObject({ cid: 'lcnaf:n78089021', matchClass: 'exact-full' });
    expect(raw.candidates.slice(1).every((c) => c.authority === 'lcsh' && c.matchClass === 'prefix-full')).toBe(true);
    expect(raw.candidates.at(-1).cid).toBe('lcsh:sh9000008');
  });

  it('the Nano limit (4) cuts after ranking', async () => {
    const weak = Array.from({ length: 6 }, (_, i) => hit('lcsh', `sh900000${i}`, `Japan--Weak ${i}`));
    mockLoc({ 'lcsh leftanchored "Japan"': weak, 'lcnaf leftanchored "Japan"': [EVIDENCE.japanName] });
    const raw = await backendOf().lookup({ id: 's1', heading: 'Japan', kind: 'geographic' }, { limit: 4 });
    expect(raw.candidates.map((c) => c.cid)).toEqual(['lcnaf:n78089021', 'lcsh:sh9000000', 'lcsh:sh9000001', 'lcsh:sh9000002']);
  });

  it('dedupe by cid keeps one entry with the best class and the earliest position', () => {
    const search = toSearch('Motion pictures--Japan--Biography');
    const a = { cid: 'lcsh:sh1', authority: 'lcsh', localId: 'sh1', label: 'Motion pictures', rdfTypes: [] };
    const b = { cid: 'lcsh:sh2', authority: 'lcsh', localId: 'sh2', label: 'Motion pictures--Japan', rdfTypes: [] };
    const c = { cid: 'lcsh:sh3', authority: 'lcsh', localId: 'sh3', label: 'Films', rdfTypes: [] };
    const ranked = rankCandidates([
      { candidate: c, authIndex: 0, stage: 1, hitIndex: 0 },
      { candidate: b, authIndex: 0, stage: 1, hitIndex: 1 },
      { candidate: a, authIndex: 0, stage: 2, hitIndex: 0 },
      { candidate: b, authIndex: 0, stage: 2, hitIndex: 1 },
      { candidate: c, authIndex: 0, stage: 3, hitIndex: 0 }
    ], search, 10);
    expect(ranked.map((x) => `${x.cid} ${x.matchClass}`)).toEqual(['lcsh:sh1 exact-main', 'lcsh:sh2 prefix-main', 'lcsh:sh3 keyword']);
  });

  it('sort keys: class, then routing position, then stage, then hit order', () => {
    const search = toSearch('Cats');
    const mk = (id, authority, label) => ({ cid: `${authority}:${id}`, authority, localId: id, label, rdfTypes: [] });
    const ranked = rankCandidates([
      { candidate: mk('sh3', 'lcsh', 'Cats--Behavior'), authIndex: 0, stage: 2, hitIndex: 0 },
      { candidate: mk('n2', 'lcnaf', 'Cats (Musical group)'), authIndex: 1, stage: 1, hitIndex: 0 },
      { candidate: mk('sh2', 'lcsh', 'Cats--Anatomy'), authIndex: 0, stage: 1, hitIndex: 1 },
      { candidate: mk('sh1', 'lcsh', 'Cats in art'), authIndex: 0, stage: 1, hitIndex: 0 },
      { candidate: mk('n1', 'lcnaf', 'Cats'), authIndex: 1, stage: 1, hitIndex: 1 }
    ], search, 10);
    expect(ranked.map((x) => x.cid)).toEqual(['lcnaf:n1', 'lcsh:sh1', 'lcsh:sh2', 'lcsh:sh3', 'lcnaf:n2']);
  });

  it('match classes (first matching rule)', () => {
    const s = toSearch('Motion pictures--Japan');
    expect(matchClassOf('Motion pictures -- Japan.', s)).toBe('exact-full');
    expect(matchClassOf('MOTION PICTURES', s)).toBe('exact-main');
    expect(matchClassOf('Motion pictures--Japan--History', s)).toBe('prefix-full');
    expect(matchClassOf('Motion pictures--Italy', s)).toBe('prefix-main');
    expect(matchClassOf('Cinema', s)).toBe('keyword');
    expect(matchClassOf('Cats', toSearch('Cats'))).toBe('exact-full');
  });
});

describe('[P4 row7] outcomes', () => {
  const lookupWith = async (routes, heading, kind) => {
    mockLoc(routes);
    const raw = await backendOf().lookup({ id: 's1', heading, kind });
    return { ...outcomeOf(raw), n: raw.candidates.length };
  };

  it('found: candidates and no failed request', async () => {
    expect(await lookupWith({ 'lcsh leftanchored "Cats"': [EVIDENCE.cats] }, 'Cats', 'topical'))
      .toEqual({ outcome: 'found', errorKind: null, n: 1 });
  });

  it('partial: candidates and a failed request', async () => {
    expect(await lookupWith({
      'lcsh leftanchored "Japan"': [hit('lcsh', 'sh1', 'Japan--Weak')],
      'lcnaf leftanchored "Japan"': response({}, { status: 500 })
    }, 'Japan', 'geographic')).toEqual({ outcome: 'partial', errorKind: 'server', n: 1 });
  });

  it('no-results: no candidates and every request succeeded', async () => {
    expect(await lookupWith({}, 'Qqq', 'topical')).toEqual({ outcome: 'no-results', errorKind: null, n: 0 });
  });

  it.each([
    ['server', () => response({}, { status: 502 })],
    ['invalid_output', () => response('not json')],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['rate_limit', () => response({}, { status: 429, headers: { 'Retry-After': '60' } })]
  ])('failed with errorKind %s', async (kind, answer) => {
    mockLoc();
    globalThis.fetch.mockImplementation(async () => answer());
    const raw = await backendOf().lookup({ id: 's1', heading: 'Qqq', kind: 'topical' });
    expect(outcomeOf(raw)).toEqual({ outcome: 'failed', errorKind: kind });
  });

  it('an incomplete lookup is partial/failed with the given kind', () => {
    expect(outcomeOf({ candidates: [{}], failures: [], incomplete: true, incompleteKind: 'timeout' })).toEqual({ outcome: 'partial', errorKind: 'timeout' });
    expect(outcomeOf({ candidates: [], failures: ['cancelled'], incomplete: true, incompleteKind: 'timeout' })).toEqual({ outcome: 'failed', errorKind: 'timeout' });
  });
});
