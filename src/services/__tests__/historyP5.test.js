import { describe, it, expect } from 'vitest';
import {
  buildHistoryEntry, rebuildV2, rebuildEntry, saveHistoryEntry, loadHistory, derivedBackend, runViewOf
} from '../history';
import { csvRows, recommendationsCsv, copyAllText, marcTextOf, CSV_COLUMNS } from '../pipeline/exports';
import { ONLINE_PROVENANCE } from '../pipeline/types';
import { selectionsOf } from '../pipeline/run';
import { builtRun, RESULTS, C } from '../../../test/pipelineFixtures';

const IDENTITY = { profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db' };
const localProv = (backend = 'local-db') => ({ backend, ...IDENTITY });

const runWith = (perSuggestion) => {
  const run = builtRun();
  const results = { ...run.lookup.results };
  for (const [id, patch] of Object.entries(perSuggestion)) results[id] = { ...results[id], ...patch };
  return { ...run, lookup: { ...run.lookup, results } };
};

describe('[P5 row11] the entry-level backend is DERIVED from the results', () => {
  it('one backend when they all agree, else mixed', () => {
    expect(derivedBackend([])).toBe('loc-api');
    expect(derivedBackend([{ provenance: localProv() }, { provenance: localProv() }])).toBe('local-db');
    expect(derivedBackend([{ provenance: localProv() }, { provenance: ONLINE_PROVENANCE }])).toBe('mixed');
    expect(derivedBackend([{ provenance: localProv('mixed') }])).toBe('mixed');
    // A result with no provenance at all counts as online.
    expect(derivedBackend([{}, {}])).toBe('loc-api');
  });

  it('history never reads the current installation, only the saved results', () => {
    const entry = buildHistoryEntry({ run: runWith({ s1: { provenance: localProv() } }) });
    expect(entry.lookup.backend).toBe('mixed');
    const allLocal = buildHistoryEntry({
      run: runWith(Object.fromEntries(Object.keys(RESULTS).map((id) => [id, { provenance: localProv() }])))
    });
    expect(allLocal.lookup.backend).toBe('local-db');
    expect(buildHistoryEntry({ run: builtRun() }).lookup.backend).toBe('loc-api');
  });
});

describe('[P5 row11] a provenance round trip through storage', () => {
  it('a saved entry keeps every §9 field and survives reload', async () => {
    const run = runWith({
      s1: {
        provenance: localProv(),
        replacementNotes: [{
          fromAuthority: 'lcsh', fromLocalId: 'sh0', fromLabel: 'Old heading',
          targetAuthority: 'lcsh', targetLocalId: 'sh9', reason: 'not-in-database'
        }],
        candidates: [
          { ...C.mpjh, source: 'local-db', via: 'replacement', replacementFrom: [{ authority: 'lcsh', localId: 'sh0', label: 'Old heading' }] },
          { ...C.mp, source: 'local-db', via: 'variant' }
        ]
      }
    });
    const entry = buildHistoryEntry({ run, id: 'e1', timestamp: '2026-09-27T10:00:00.000Z' });
    entry.recommendations[0].marcKeySource = 'loc-api';
    await saveHistoryEntry(entry);
    const [stored] = await loadHistory();
    const s1 = stored.lookup.results.find((r) => r.suggestionId === 's1');
    expect(s1.provenance).toEqual(localProv());
    expect(s1.replacementNotes[0].fromLabel).toBe('Old heading');
    expect(s1.candidates.map((c) => c.via)).toEqual(['replacement', 'variant']);
    expect(s1.candidates[0].replacementFrom).toEqual([{ authority: 'lcsh', localId: 'sh0', label: 'Old heading' }]);
    expect(s1.candidates.every((c) => c.source === 'local-db')).toBe(true);
    expect(stored.recommendations[0].marcKeySource).toBe('loc-api');
    expect(stored.lookup.backend).toBe('mixed');
    // The read-only re-render view carries the results unchanged.
    expect(runViewOf(stored).results.s1.provenance).toEqual(localProv());
  });

  it('an unknown reason or a malformed note is normalized, never spread through', () => {
    const entry = rebuildV2({
      v: 2,
      lookup: {
        results: [{
          suggestionId: 's1', outcome: 'found',
          provenance: { backend: 'local-db', profile: 'core', release: 7, releaseCommit: null, file: '/x', evil: 1 },
          replacementNotes: [{ reason: 'made-up', fromLabel: 'X', evil: 1 }, 'not an object'],
          candidates: [{ cid: 'lcsh:sh1', authority: 'lcsh', localId: 'sh1', label: 'Cats', via: 'guess', evil: 1 }]
        }]
      }
    });
    const [result] = entry.lookup.results;
    expect(result.provenance).toEqual({ backend: 'local-db', profile: 'core', release: null, releaseCommit: null, file: '/x' });
    expect(result.replacementNotes[0].reason).toBe('not-in-database');
    expect(Object.hasOwn(result.replacementNotes[0], 'evil')).toBe(false);
    expect(Object.hasOwn(result.candidates[0], 'via')).toBe(false);
    expect(Object.hasOwn(result.candidates[0], 'evil')).toBe(false);
  });

  it('a legacy entry is still shown as stored', () => {
    const legacy = { id: 1, timestamp: 't', finalRecommendations: [] };
    expect(rebuildEntry(legacy)).toBe(legacy);
  });
});

describe('[P5 row11] the CSV marc_reason column', () => {
  const recOf = (marc, over = {}) => ({
    cid: 'lcnaf:n1', label: 'Name', authority: 'lcnaf', localId: 'n1',
    uri: 'http://id.loc.gov/authorities/names/n1', source: 'local-db',
    selections: [{ suggestionId: 's1', method: 'manual', confidence: null, lexicalSimilarity: 90 }],
    marc, ...over
  });

  it('is empty when the MARC field is available and holds the reason otherwise', () => {
    expect(CSV_COLUMNS.indexOf('marc_reason')).toBe(CSV_COLUMNS.indexOf('marc_status') + 1);
    const available = recOf({ status: 'from-authority', tag: '600', ind1: '1', ind2: '0', subfields: [['a', 'Name']], text: '600 10 $a Name', reason: null });
    const offline = recOf({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'MARC not available offline' });
    const [, availableRow, offlineRow] = csvRows([available, { ...offline, cid: 'lcnaf:n2', localId: 'n2' }], []);
    expect(availableRow[CSV_COLUMNS.indexOf('marc_reason')]).toBe('');
    expect(offlineRow[CSV_COLUMNS.indexOf('marc_reason')]).toBe('MARC not available offline');
    expect(offlineRow[CSV_COLUMNS.indexOf('source')]).toBe('local-db');
  });

  it('a reason with a comma or a leading formula character stays guarded and quoted', () => {
    const rec = recOf({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: '=Name MARC-key lookup failed, again' });
    const csv = recommendationsCsv([rec], []);
    expect(csv).toContain('"\'=Name MARC-key lookup failed, again"');
    expect(csv.endsWith('\r\n') || csv.includes('\r\n')).toBe(true);
  });

  it('Copy all already prints the reason', () => {
    const rec = recOf({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'MARC not available offline' });
    expect(copyAllText([rec], [])).toContain('Name | n1 | MARC not available offline');
  });

  // Live finding (lead): no "MARC not available (MARC not available offline)".
  it('the export text says "MARC not available offline" exactly ONCE; other reasons keep the bracketed form; the stored reason is unchanged', () => {
    const offline = recOf({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'MARC not available offline' });
    expect(marcTextOf(offline)).toBe('MARC not available offline');
    const copy = copyAllText([offline], []);
    expect(copy.split('MARC not available').length - 1).toBe(1);
    expect(copy).toContain('Name | n1 | MARC not available offline');
    // CSV: the marc_reason column carries the stored reason, once.
    const [, row] = csvRows([offline], []);
    expect(row[CSV_COLUMNS.indexOf('marc_reason')]).toBe('MARC not available offline');
    expect(row.join('|').split('MARC not available').length - 1).toBe(1);
    // The record itself still holds the same reason value (saved history stays compatible).
    expect(offline.marc.reason).toBe('MARC not available offline');

    for (const reason of ['no key', 'Name MARC-key lookup failed', 'unsupported tag']) {
      const other = recOf({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason });
      expect(marcTextOf(other)).toBe(`MARC not available (${reason})`);
    }
  });

  it('the run\'s own recommendations export with their reasons', () => {
    const run = builtRun();
    const rows = csvRows(run.recommendations, selectionsOf(run));
    for (const row of rows.slice(1)) {
      const status = row[CSV_COLUMNS.indexOf('marc_status')];
      const reason = row[CSV_COLUMNS.indexOf('marc_reason')];
      expect(status === 'from-authority' ? reason === '' : reason !== '').toBe(true);
    }
  });
});
