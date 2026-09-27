import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mapRow, isMappable, uriOf, replacementsOf, replacementNote, createLocalQueries, SEGMENT, BACKEND_ID
} from '../localDb';
import { openFixture } from '../../../../test/localDbFixtures';

const row = (over = {}) => ({
  id: 1, uri: 'sh85021262', authority: 'lcsh', label: 'Cats', label_normalized: 'cats',
  deprecated: 0, marc_key: '150 0$aCats', scope_note: null, ...over
});

describe('[P5 row4] the ONE row → Candidate mapper', () => {
  it('maps an auth row to the P4 Candidate shape plus source, via and no rdfTypes', () => {
    expect(mapRow(row(), { via: 'label' })).toEqual({
      cid: 'lcsh:sh85021262',
      authority: 'lcsh',
      localId: 'sh85021262',
      uri: 'http://id.loc.gov/authorities/subjects/sh85021262',
      label: 'Cats',
      marcKey: '150 0$aCats',
      rdfTypes: [],
      matchClass: 'keyword',
      source: 'local-db',
      via: 'label'
    });
    expect(BACKEND_ID).toBe('local-db');
  });

  it('builds the URI from the authority segment map', () => {
    expect(SEGMENT).toEqual({ lcsh: 'subjects', lcgft: 'genreForms', lcnaf: 'names' });
    expect(uriOf('lcnaf', 'n79091264')).toBe('http://id.loc.gov/authorities/names/n79091264');
    expect(uriOf('lcgft', 'gf2011026089')).toBe('http://id.loc.gov/authorities/genreForms/gf2011026089');
    expect(mapRow(row({ authority: 'lcgft', uri: 'gf2011026089' }), { via: 'label' }).uri)
      .toBe('http://id.loc.gov/authorities/genreForms/gf2011026089');
  });

  it('REJECTS a deprecated row', () => {
    expect(mapRow(row({ deprecated: 1 }), { via: 'label' })).toBeNull();
    expect(isMappable(row({ deprecated: 1 }))).toBe(false);
  });

  it('REJECTS a row whose marc_key starts with 18 (a subdivision record)', () => {
    for (const key of ['180  $xHistory', '181  $zJapan', '185  $vBiography']) {
      expect(mapRow(row({ marc_key: key }), { via: 'label' }), key).toBeNull();
    }
    // 150 and 151 are kept; only the 18X family is a subdivision.
    expect(mapRow(row({ marc_key: '151 0$aJapan$xHistory' }), { via: 'label' })).not.toBeNull();
  });

  it('REJECTS malformed rows and unknown authorities and vias', () => {
    expect(mapRow(null, { via: 'label' })).toBeNull();
    expect(mapRow(row({ authority: 'viaf' }), { via: 'label' })).toBeNull();
    expect(mapRow(row({ label: '' }), { via: 'label' })).toBeNull();
    expect(mapRow(row({ uri: '' }), { via: 'label' })).toBeNull();
    expect(mapRow(row(), { via: 'guess' })).toBeNull();
    expect(mapRow(row(), {})).toBeNull();
  });

  it('a missing or empty marc_key becomes null', () => {
    expect(mapRow(row({ marc_key: null }), { via: 'label' }).marcKey).toBeNull();
    expect(mapRow(row({ marc_key: '' }), { via: 'label' }).marcKey).toBeNull();
  });

  it('via variant explains the match; replacementFrom appears only for via replacement', () => {
    expect(mapRow(row(), { via: 'variant' }).via).toBe('variant');
    expect(Object.hasOwn(mapRow(row(), { via: 'variant' }), 'replacementFrom')).toBe(false);
    const from = [{ authority: 'lcsh', localId: 'sh00000273', label: 'Child concentration camp inmates' }];
    const replacement = mapRow(row(), { via: 'replacement', replacementFrom: from });
    expect(replacement.via).toBe('replacement');
    expect(replacement.replacementFrom).toEqual(from);
    // The mapper copies, so a later change of the source list cannot reach it.
    from[0].label = 'changed';
    expect(replacement.replacementFrom[0].label).toBe('Child concentration camp inmates');
  });
});

describe('[P5 row4] replacements of a deprecated row (§6.2, one hop)', () => {
  const deprecated = row({ id: 9, uri: 'sh00000273', label: 'Child concentration camp inmates', deprecated: 1, marc_key: null });
  const hop = (over) => ({
    target_authority: 'lcsh', target_uri: 'sh2021004026',
    id: null, uri: null, authority: null, label: null, label_normalized: null, deprecated: null, marc_key: null,
    scope_note: null, ...over
  });

  it('a target in this database becomes a candidate with via replacement and replacementFrom', () => {
    const { candidates, notes, rejected } = replacementsOf(deprecated, [hop({
      id: 20, uri: 'sh2021004026', authority: 'lcsh', label: 'Child concentration camp survivors', deprecated: 0,
      marc_key: '150  $aChild concentration camp survivors'
    })]);
    expect(notes).toEqual([]);
    expect(rejected).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].cid).toBe('lcsh:sh2021004026');
    expect(candidates[0].via).toBe('replacement');
    expect(candidates[0].label).toBe('Child concentration camp survivors');
    expect(candidates[0].replacementFrom).toEqual([
      { authority: 'lcsh', localId: 'sh00000273', label: 'Child concentration camp inmates' }
    ]);
  });

  it('a target that is not in this profile becomes a not-in-database note, not a candidate', () => {
    const { candidates, notes } = replacementsOf(deprecated, [hop({ target_authority: 'lcnaf', target_uri: 'n2010012846' })]);
    expect(candidates).toEqual([]);
    expect(notes).toEqual([{
      fromAuthority: 'lcsh', fromLocalId: 'sh00000273', fromLabel: 'Child concentration camp inmates',
      targetAuthority: 'lcnaf', targetLocalId: 'n2010012846', reason: 'not-in-database'
    }]);
  });

  it('a deprecated target becomes a deprecated-target note; there is no second hop', () => {
    const { candidates, notes } = replacementsOf(deprecated, [hop({
      id: 21, uri: 'sh2021004026', authority: 'lcsh', label: 'Also old', deprecated: 1
    })]);
    expect(candidates).toEqual([]);
    expect(notes[0].reason).toBe('deprecated-target');
  });

  it('an 18X target is rejected by the mapper, not turned into a note', () => {
    const { candidates, notes, rejected } = replacementsOf(deprecated, [hop({
      id: 22, uri: 'sh2021004026', authority: 'lcsh', label: 'Sub', deprecated: 0, marc_key: '180  $xSub'
    })]);
    expect(candidates).toEqual([]);
    expect(notes).toEqual([]);
    expect(rejected).toBe(1);
  });

  it('several hops give several results, in the query order', () => {
    const { candidates, notes } = replacementsOf(deprecated, [
      hop({ target_uri: 'sh2021004026', id: 20, uri: 'sh2021004026', authority: 'lcsh', label: 'A', deprecated: 0 }),
      hop({ target_uri: 'sh2021004027' })
    ]);
    expect(candidates.map((c) => c.cid)).toEqual(['lcsh:sh2021004026']);
    expect(notes.map((n) => n.targetLocalId)).toEqual(['sh2021004027']);
  });

  it('replacementNote keeps the deprecated record it came from', () => {
    expect(replacementNote(deprecated, { target_authority: 'lcgft', target_uri: 'gf1' }, 'not-in-database'))
      .toEqual({
        fromAuthority: 'lcsh', fromLocalId: 'sh00000273', fromLabel: 'Child concentration camp inmates',
        targetAuthority: 'lcgft', targetLocalId: 'gf1', reason: 'not-in-database'
      });
  });
});

describe('[P5 row4] the query layer over the real fixture databases', () => {
  const fixtures = {};
  beforeAll(async () => {
    fixtures.core = await openFixture('core');
    fixtures.full = await openFixture('full');
  });
  afterAll(() => {
    fixtures.core?.close();
    fixtures.full?.close();
  });

  it('Q1 normalizes its text: dashes, case and trailing periods reach the same record', async () => {
    const queries = createLocalQueries(fixtures.core.query);
    for (const text of ['Cats', 'cats', 'CATS.', '  Cats  ']) {
      const rows = await queries.exact(text, ['lcsh']);
      expect(rows.map((r) => r.uri), text).toEqual(['sh85021262']);
    }
    const dashed = await queries.exact('Ballet – Equipment and supplies', ['lcsh']);
    expect(dashed.map((r) => r.uri)).toEqual(['sh85011277']);
  });

  it('Q2 finds a record through a variant label', async () => {
    const queries = createLocalQueries(fixtures.core.query);
    expect((await queries.variant('Felis catus', ['lcsh'])).map((r) => r.uri)).toEqual(['sh85021262']);
    // One record, even when several of its variants would match separately.
    expect(await queries.variant('Cats', ['lcsh'])).toEqual([]);
  });

  it('Q3a + Q3b list preferred hits first, then the variant hits not already listed', async () => {
    const queries = createLocalQueries(fixtures.core.query);
    const { rows, ran, errors } = await queries.fts('Cats', ['lcsh']);
    expect(ran).toBe(true);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.uri)).toEqual(['sh85021262']);

    const variantOnly = await queries.fts('Felis', ['lcsh']);
    expect(variantOnly.rows.map((r) => r.uri)).toEqual(['sh85021262']);
  });

  it('Q3 does not run at all when the text has no token', async () => {
    const seen = [];
    const queries = createLocalQueries((name) => {
      seen.push(name);
      return Promise.resolve([]);
    });
    const result = await queries.fts(' -- . ', ['lcsh']);
    expect(result).toEqual({ rows: [], ran: false, errors: [] });
    expect(seen).toEqual([]);
  });

  it('a failing Q3b keeps the Q3a rows and reports the error (§6.4 separate accumulation)', async () => {
    const boom = new Error('gone');
    const queries = createLocalQueries((name) => (
      name === 'Q3a' ? Promise.resolve([{ id: 1, uri: 'sh1' }]) : Promise.reject(boom)
    ));
    const result = await queries.fts('cats', ['lcsh']);
    expect(result.rows.map((r) => r.uri)).toEqual(['sh1']);
    expect(result.ran).toBe(false);
    expect(result.errors).toEqual([boom]);
  });

  it('Q4 of a deprecated record whose targets are not in this profile returns unjoined rows', async () => {
    const queries = createLocalQueries(fixtures.core.query);
    const [deprecatedRow] = await fixtures.core.rows('SELECT * FROM auth WHERE uri = ?', ['sh00000273']);
    const rows = await queries.replacements(deprecatedRow.id, 'lcsh');
    expect(rows.map((r) => r.target_uri)).toEqual(['sh2021004026', 'sh2021004027']);
    const { candidates, notes } = replacementsOf(deprecatedRow, rows);
    expect(candidates).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual(['not-in-database', 'not-in-database']);
    expect(notes[0].fromLabel).toBe('Child concentration camp inmates');
  });

  it('core holds no names; full answers the same name query', async () => {
    expect(await createLocalQueries(fixtures.core.query).exact('Beijing da xue', ['lcnaf'])).toEqual([]);
    const full = await createLocalQueries(fixtures.full.query).exact('Beijing da xue', ['lcnaf']);
    expect(full.map((r) => r.uri)).toEqual(['n80030740']);
    expect(mapRow(full[0], { via: 'label' }).marcKey).toBeNull();
  });
});
