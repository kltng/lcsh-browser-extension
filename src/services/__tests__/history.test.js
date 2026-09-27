import { describe, it, expect, vi } from 'vitest';
import { renderHtml } from '../../../test/render';
import {
  buildHistoryEntry, rebuildV2, rebuildEntry, saveHistoryEntry, deleteHistoryEntry, clearHistory, loadHistory, onHistoryChanged,
  adaptLegacyEntry, legacyMarcCopyText, runViewOf, serializedBytes, HISTORY_KEY, LEGACY_HEADER, LEGACY_MARC_LABEL, LEGACY_COPY_PREFIX,
  MAX_ENTRIES, MAX_TOTAL_BYTES, MAX_ENTRY_BYTES
} from '../history';
import { V2EntryView, LegacyEntryView } from '../../components/ConversationHistory';
import { fakes, flushEvents, gate } from '../../../test/setup';
import { KEY } from '../../../test/fixtures';
import { builtRun, V110_ENTRY, P3_ENTRY, C } from '../../../test/pipelineFixtures';

const BIB = {
  title: '日本電影人物志', author: '', abstract: 'Film people.', tableOfContents: '', notes: '',
  images: [{ data: 'data:image/png;base64,AAAA', name: 'cover.png', type: 'image/png', size: 4 }]
};
/** A built run whose input snapshot is `input` (the history source of bibliographic info). */
const runWith = (input) => ({ ...builtRun(), input });
const entry = (title = 'T') => buildHistoryEntry({ run: runWith({ ...BIB, title }) });
const stored = () => fakes.storage.data.get(HISTORY_KEY) || [];

/** Two fake pages: two separate module instances sharing the fake storage and the fake lock manager. */
const twoPages = async () => {
  vi.resetModules();
  const a = await import('../history');
  vi.resetModules();
  const b = await import('../history');
  return [a, b];
};

describe('[P4 row13] history: locked read-modify-write', () => {
  it('two fake pages saving at once: no lost update', async () => {
    const [pageA, pageB] = await twoPages();
    expect(pageA.saveHistoryEntry).not.toBe(pageB.saveHistoryEntry);
    await Promise.all([pageA.saveHistoryEntry(entry('A')), pageB.saveHistoryEntry(entry('B')), pageA.saveHistoryEntry(entry('C'))]);
    expect(stored().map((e) => e.bibliographicInfo.title).sort()).toEqual(['A', 'B', 'C']);
    expect(fakes.locks.log.filter((l) => l === 'acquire:lcsh-history')).toHaveLength(3);
    expect(fakes.locks.stats.maxConcurrent).toBe(1);
  });

  it('a delete in one page and a save in another: the deleted entry is not resurrected', async () => {
    const [pageA, pageB] = await twoPages();
    const e1 = entry('one');
    const e2 = entry('two');
    fakes.storage.seed({ [HISTORY_KEY]: [e1, e2] });
    await Promise.all([pageA.deleteHistoryEntry(e1.id), pageB.saveHistoryEntry(entry('three'))]);
    expect(stored().map((e) => e.bibliographicInfo.title)).toEqual(['two', 'three']);
  });

  it('every operation reads the current array INSIDE the lock', async () => {
    const hold = gate();
    const held = navigator.locks.request('lcsh-history', { mode: 'exclusive' }, () => hold.promise);
    const saving = saveHistoryEntry(entry('late'));
    fakes.storage.seed({ [HISTORY_KEY]: [V110_ENTRY] });
    hold.open();
    await held;
    await saving;
    expect(stored().map((e) => e.id)).toEqual([V110_ENTRY.id, expect.any(String)]);
  });

  it('an awaited save failure rejects, and the previous history stays as it was', async () => {
    fakes.storage.seed({ [HISTORY_KEY]: [V110_ENTRY] });
    fakes.storage.failNext('set', new Error('QUOTA_BYTES quota exceeded'));
    await expect(saveHistoryEntry(entry())).rejects.toMatchObject({ name: 'HistoryError', kind: 'write_failed' });
    expect(stored()).toEqual([V110_ENTRY]);
  });

  it('ids come from crypto.randomUUID(); save resolves with the stored list; clear and load', async () => {
    const e = entry();
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await saveHistoryEntry(e);
    expect(list.map((x) => x.id)).toEqual([e.id]);
    expect(await loadHistory()).toEqual(list);
    expect(await clearHistory()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('onChanged refreshes the list in other tabs', async () => {
    const seen = [];
    const off = onHistoryChanged((entries) => seen.push(entries.map((x) => x.bibliographicInfo.title)));
    await saveHistoryEntry(entry('X'));
    await flushEvents();
    expect(seen).toEqual([['X']]);
    off();
    await deleteHistoryEntry(stored()[0].id);
    await flushEvents();
    expect(seen).toHaveLength(1);
  });
});

describe('[P4 row13] history: size policy (product policy)', () => {
  it('an entry over 256 KiB is refused with a local message; nothing is written', async () => {
    const big = buildHistoryEntry({ run: runWith({ ...BIB, abstract: 'x'.repeat(MAX_ENTRY_BYTES) }) });
    await expect(saveHistoryEntry(big)).rejects.toMatchObject({ kind: 'too_large', message: expect.stringContaining('256 KiB') });
    expect(fakes.storage.calls.set).toHaveLength(0);
  });

  it('at most 25 entries: the oldest is evicted in the SAME write', async () => {
    const old = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ ...V110_ENTRY, id: i }));
    fakes.storage.seed({ [HISTORY_KEY]: old });
    const e = entry('newest');
    await saveHistoryEntry(e);
    expect(fakes.storage.calls.set).toHaveLength(1);
    expect(stored()).toHaveLength(25);
    expect(stored()[0].id).toBe(1);
    expect(stored().at(-1).id).toBe(e.id);
  });

  it('at most 6 MiB serialized: the oldest entries are evicted', async () => {
    const heavy = (id) => ({ ...V110_ENTRY, id, bibliographicInfo: { ...V110_ENTRY.bibliographicInfo, abstract: 'y'.repeat(260 * 1024) } });
    fakes.storage.seed({ [HISTORY_KEY]: Array.from({ length: 24 }, (_, i) => heavy(i)) });
    await saveHistoryEntry(entry());
    expect(serializedBytes(stored())).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(stored()[0].id).toBe(1);
    expect(stored()).toHaveLength(24);
  });
});

describe('[P4 row13] history: the allowlist', () => {
  it('images are stripped from a COPY (the live form data is not mutated)', () => {
    const bib = structuredClone(BIB);
    const e = buildHistoryEntry({ run: runWith(bib) });
    expect(e.bibliographicInfo.images).toEqual([{ name: 'cover.png', type: 'image/png', size: 4 }]);
    expect(bib.images[0].data).toBe('data:image/png;base64,AAAA');
  });

  it('no key or config fields survive, at any depth', () => {
    const run = builtRun();
    const poisoned = structuredClone(run);
    poisoned.apiKey = KEY;
    poisoned.run.snapshots.suggest.apiKey = KEY;
    poisoned.suggest.suggestions[0].apiKey = KEY;
    poisoned.lookup.results.s1.candidates[0].apiKey = KEY;
    poisoned.lookup.results.s1.raw = { key: KEY };
    poisoned.recommendations[0].marc.apiKey = KEY;
    poisoned.recommendations[0].selections[0].cfg = { apiKey: KEY };
    poisoned.select.additional[0].apiKey = KEY;
    poisoned.input = { ...BIB, apiKey: KEY, cfg: { apiKey: KEY } };
    const e = buildHistoryEntry({ run: poisoned });
    const text = JSON.stringify(e);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('data:image');
    expect(text).not.toMatch(/apiKey|baseURL|"cfg"/);
    expect(Object.keys(e)).toEqual(['v', 'id', 'timestamp', 'bibliographicInfo', 'subjectAnalysis', 'suggestMode', 'suggestions',
      'lookup', 'selectMode', 'selections', 'recommendations', 'provenance']);
    expect(e.provenance).toEqual({ suggest: { providerId: 'deepseek', model: 'deepseek-flash' }, select: { providerId: 'gemini', model: 'gemini-2.5-flash' } });
  });

  it('on load, nested objects are rebuilt field by field; an omitted candidate source comes from lookup.backend', () => {
    const e = entry();
    const raw = structuredClone(e);
    delete raw.lookup.results[0].candidates[0].source;
    raw.lookup.results[0].candidates[0].evil = KEY;
    raw.recommendations[0].marc.subfields.push(['x', 5], 'junk');
    const rebuilt = rebuildEntry(raw);
    expect(rebuilt.lookup.results[0].candidates[0].source).toBe('loc-api');
    expect(JSON.stringify(rebuilt)).not.toContain(KEY);
    expect(rebuilt.recommendations[0].marc.subfields).toEqual(e.recommendations[0].marc.subfields);
    expect(rebuildV2(rebuilt)).toEqual(rebuilt);
    expect(rebuildEntry(V110_ENTRY)).toBe(V110_ENTRY);
  });
});

describe('[P4 row13] history: re-render and legacy entries', () => {
  it('steps 2–4 re-render read-only from a v2 entry', () => {
    const e = entry();
    const view = runViewOf(e);
    expect(view.results.s4.outcome).toBe('no-results');
    const html = renderHtml(V2EntryView, { entry: e });
    expect(html).toContain('Japanese film people.');
    expect(html).toContain('Japanese cinema');
    expect(html).toContain('No match returned by this search');
    expect(html).toContain('Lookup failed: Could not reach id.loc.gov');
    expect(html).toContain('650 _0 $a Motion pictures $z Japan $x History');
    expect(html).toContain('LC ID: sh2008108026');
    expect(html).toContain('Suggestions: deepseek (deepseek-flash) · Selection: gemini (gemini-2.5-flash)');
    expect(html).not.toContain('Use this heading');
    expect(html).not.toContain('Retry lookup');
  });

  it('the legacy adapter: header, the unverified MARC label, and the UNVERIFIED copy prefix', () => {
    const legacy = adaptLegacyEntry(V110_ENTRY);
    expect(legacy.items[0]).toMatchObject({ heading: 'Cats', marc: '150 _0 $a Cats\n650 _0 $a Cats', similarity: 90 });
    expect(legacyMarcCopyText(legacy.items[0].marc)).toBe(`${LEGACY_COPY_PREFIX}150 _0 $a Cats\n${LEGACY_COPY_PREFIX}650 _0 $a Cats`);
    expect(LEGACY_COPY_PREFIX).toBe('UNVERIFIED (older version): ');
    const html = renderHtml(LegacyEntryView, { entry: V110_ENTRY, onCopy: vi.fn() });
    expect(html).toContain(LEGACY_HEADER);
    expect(LEGACY_HEADER).toBe('Saved by an older version. Its MARC was written by an AI model and was not checked.');
    expect(html).toContain(LEGACY_MARC_LABEL);
    expect(LEGACY_MARC_LABEL).toBe('Unverified AI-written MARC (older version)');
    expect(html).toContain('Text from the older version (not checked): Main topic (✓ Verified by API)');
    // The stored original is not rewritten.
    expect(V110_ENTRY.marcRecords.Cats).toBe('150 _0 $a Cats\n650 _0 $a Cats');
  });

  it('the P3 entry shape: provenance fields are shown when present', () => {
    const html = renderHtml(LegacyEntryView, { entry: P3_ENTRY, onCopy: vi.fn() });
    expect(html).toContain('Suggestions: deepseek (deepseek-flash)');
    expect(html).not.toContain('MARC: ');
    expect(adaptLegacyEntry(P3_ENTRY).suggestionProvenance).toEqual({ providerId: 'deepseek', model: 'deepseek-flash' });
  });

  it('a saved v2 entry keeps its recommendations and selections exactly', async () => {
    const e = entry();
    await saveHistoryEntry(e);
    const [loaded] = await loadHistory();
    expect(loaded.recommendations.map((r) => r.cid)).toEqual([C.mpjh.cid, C.japanN.cid, C.actors.cid]);
    expect(loaded.selections.find((s) => s.suggestionId === 's6')).toMatchObject({ method: 'manual', noneReason: 'manual-none' });
    expect(loaded).toEqual(e);
  });
});
