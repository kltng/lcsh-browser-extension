import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openFixture, goldenShape } from '../../../../test/localDbFixtures';
import { buildMatch } from '../sql';
import { normalizeLabel } from '../../lookup/normalize';
import { createLocalQueries } from '../../lookup/localDb';
import GOLDEN from '../__fixtures__/golden.json';
import SELECTION from '../__fixtures__/golden_fixture_selection.json';

const BY_ID = new Map(GOLDEN.entries.map((e) => [e.id, e]));
const fixtures = {};

beforeAll(async () => {
  fixtures.core = await openFixture('core');
  fixtures.full = await openFixture('full');
});
afterAll(() => {
  fixtures.core?.close();
  fixtures.full?.close();
});

/** Run one golden entry against a fixture profile through the query layer. */
const runGolden = async (entry, profile) => {
  const fixture = fixtures[profile];
  const queries = createLocalQueries(fixture.query);
  if (entry.query === 'Q1') return goldenShape(await queries.exact(entry.text, entry.authorities));
  if (entry.query === 'Q2') return goldenShape(await queries.variant(entry.text, entry.authorities));
  if (entry.query === 'Q3a') {
    const match = buildMatch(entry.text);
    return match === null ? [] : goldenShape(await fixture.query('Q3a', { text: match, authorities: entry.authorities }));
  }
  if (entry.query === 'Q3b') {
    const match = buildMatch(entry.text);
    return match === null ? [] : goldenShape(await fixture.query('Q3b', { text: match, authorities: entry.authorities }));
  }
  const [authority, uri] = entry.record;
  const [row] = await fixture.rows('SELECT id FROM auth WHERE authority = ? AND uri = ?', [authority, uri]);
  expect(row, `${entry.id}: the record must exist in the ${profile} fixture`).toBeTruthy();
  const rows = await queries.replacements(row.id, authority);
  return rows.map((r) => ({
    authority: r.authority, uri: r.uri, label: r.label, deprecated: r.deprecated, marc_key: r.marc_key ?? null
  }));
};

describe('[P5 row3] the selected builder goldens through the query layer', () => {
  for (const profile of ['core', 'full']) {
    const ids = SELECTION.selected[profile];

    it(`${profile}: the selection names real goldens that apply to this profile`, () => {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const entry = BY_ID.get(id);
        expect(entry, id).toBeTruthy();
        expect(entry.profiles, id).toContain(profile);
        expect(Object.hasOwn(entry.expected, profile), id).toBe(true);
      }
    });

    for (const id of SELECTION.selected[profile]) {
      it(`${profile}: ${id}`, async () => {
        const entry = BY_ID.get(id);
        const actual = await runGolden(entry, profile);
        expect(actual).toEqual(entry.expected[profile]);
        if (entry.match === 'empty') expect(actual).toEqual([]);
      });
    }
  }

  it('the goldens were generated from the same SCHEMA_QUERIES revision as sql.js', async () => {
    const { default: pinned } = await import('../__fixtures__/schema_queries.json');
    expect(GOLDEN.schema_queries_sha256).toBe(pinned.schema_queries_sha256);
    expect(SELECTION.selected.core.length + SELECTION.selected.full.length).toBe(27);
  });

  it('the fixture databases carry the schema the installer requires', async () => {
    for (const profile of ['core', 'full']) {
      const meta = Object.fromEntries((await fixtures[profile].rows('SELECT key, value FROM db_meta'))
        .map((r) => [r.key, r.value]));
      expect(meta.profile).toBe(profile);
      expect(meta.schema_version).toBe('2');
      expect(meta.normalize_version).toBe('NORMALIZE_V1');
      expect(meta.lh_format).toBe('LH1');
    }
  });

  it('every stored label_normalized equals the extension NORMALIZE_V1 of its label', async () => {
    for (const profile of ['core', 'full']) {
      for (const table of ['auth', 'alt_label']) {
        const rows = await fixtures[profile].rows(`SELECT label, label_normalized FROM ${table}`);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(normalizeLabel(row.label), `${profile}/${table}: ${row.label}`).toBe(row.label_normalized);
      }
    }
  });
});
