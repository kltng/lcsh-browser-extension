import { describe, it, expect, vi } from 'vitest';
import { runLookupStep } from '../lookupStep';
import { makeLookupResult, ONLINE_PROVENANCE } from '../types';
import { createCoordinator } from '../../lookup/coordinator';
import { rankCandidates } from '../../lookup/locApi';
import { createScheduler, createRunCache } from '../../lookup/scheduler';
import { buildHistoryEntry, rebuildV2, rebuildEntry } from '../../history';
import { createWorkflow } from '../workflow';
import { toSearch } from '../../lookup/searchText';
import { mockLoc, fastSchedulerOptions } from '../../../../test/locFixtures';
import { SUGGESTIONS, RESULTS, builtRun } from '../../../../test/pipelineFixtures';
import { yieldTicks, gate } from '../../../../test/setup';

const IDENTITY = {
  profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db'
};

const row = (over = {}) => ({
  id: 1, uri: 'sh1', authority: 'lcsh', label: 'Cats', label_normalized: 'cats', deprecated: 0,
  marc_key: '150 0$aCats', scope_note: null, ...over
});

const localOf = (rows) => ({
  installation: () => IDENTITY,
  query: vi.fn(async (name) => {
    const answer = rows[name];
    if (answer instanceof Error) throw answer;
    return answer || [];
  })
});

const backendOf = (local) => createCoordinator({
  scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache(), local
});

describe('[P5 row10b] provenance and notes travel with the result', () => {
  it('the factory keeps both fields and defaults them to an online lookup', () => {
    const result = makeLookupResult({ suggestionId: 's1', outcome: 'found' });
    expect(result.provenance).toEqual(ONLINE_PROVENANCE);
    expect(result.replacementNotes).toEqual([]);

    const withLocal = makeLookupResult({
      suggestionId: 's1', outcome: 'found', provenance: { backend: 'local-db', ...IDENTITY },
      replacementNotes: [{ reason: 'not-in-database' }]
    });
    expect(withLocal.provenance).toEqual({ backend: 'local-db', ...IDENTITY });
    expect(withLocal.replacementNotes).toHaveLength(1);
    // An unknown backend falls back to the online default.
    expect(makeLookupResult({ suggestionId: 's1', outcome: 'found', provenance: { backend: 'guess' } }).provenance.backend)
      .toBe('loc-api');
  });

  it('runLookupStep carries them from the backend into the LookupResult', async () => {
    mockLoc({});
    const local = localOf({
      Q1: [row({ deprecated: 1, marc_key: null, label: 'Old cats' })],
      Q4: [{ target_authority: 'lcsh', target_uri: 'sh999', uri: null, authority: null, label: null, deprecated: null, marc_key: null }]
    });
    const { results } = await runLookupStep({
      backend: backendOf(local), suggestions: [{ id: 's1', heading: 'Old cats', kind: 'topical' }]
    });
    expect(results[0].provenance).toEqual({ backend: 'local-db', ...IDENTITY });
    expect(results[0].replacementNotes).toEqual([{
      fromAuthority: 'lcsh', fromLocalId: 'sh1', fromLabel: 'Old cats',
      targetAuthority: 'lcsh', targetLocalId: 'sh999', reason: 'not-in-database'
    }]);
  });

  it('they survive the history build and rebuild, and old entries get the online defaults', () => {
    const run = builtRun();
    const local = {
      ...RESULTS.s1,
      provenance: { backend: 'mixed', ...IDENTITY },
      replacementNotes: [{
        fromAuthority: 'lcsh', fromLocalId: 'sh0', fromLabel: 'Old', targetAuthority: 'lcnaf',
        targetLocalId: 'n1', reason: 'deprecated-target'
      }],
      candidates: [{
        ...RESULTS.s1.candidates[0], source: 'local-db', via: 'replacement',
        replacementFrom: [{ authority: 'lcsh', localId: 'sh0', label: 'Old' }]
      }]
    };
    const entry = buildHistoryEntry({
      run: { ...run, lookup: { ...run.lookup, results: { ...run.lookup.results, s1: local } } }
    });
    const saved = entry.lookup.results.find((r) => r.suggestionId === 's1');
    expect(saved.provenance).toEqual({ backend: 'mixed', ...IDENTITY });
    expect(saved.replacementNotes[0].reason).toBe('deprecated-target');
    expect(saved.candidates[0].via).toBe('replacement');
    expect(saved.candidates[0].replacementFrom).toEqual([{ authority: 'lcsh', localId: 'sh0', label: 'Old' }]);
    expect(saved.candidates[0].source).toBe('local-db');

    // A round trip through storage changes nothing.
    const again = rebuildV2(JSON.parse(JSON.stringify(entry)));
    expect(again.lookup.results.find((r) => r.suggestionId === 's1')).toEqual(saved);

    // Every other result of this entry is online.
    const online = again.lookup.results.find((r) => r.suggestionId === 's3');
    expect(online.provenance).toEqual(ONLINE_PROVENANCE);
    expect(online.replacementNotes).toEqual([]);
  });

  it('a pre-P5 v2 entry defaults to online provenance and empty notes', () => {
    const old = {
      v: 2, id: 'x', timestamp: 't', bibliographicInfo: {}, suggestions: [],
      lookup: { backend: 'loc-api', results: [{ suggestionId: 's1', outcome: 'found', candidates: [{ cid: 'lcsh:sh1', authority: 'lcsh', localId: 'sh1', label: 'Cats' }] }] },
      selections: [], recommendations: [], provenance: {}
    };
    const rebuilt = rebuildEntry(old);
    expect(rebuilt.lookup.results[0].provenance).toEqual(ONLINE_PROVENANCE);
    expect(rebuilt.lookup.results[0].replacementNotes).toEqual([]);
    expect(rebuilt.lookup.results[0].candidates[0].source).toBe('loc-api');
    expect(rebuilt.lookup.results[0].candidates[0].via).toBeUndefined();
    expect(rebuilt.lookup.backend).toBe('loc-api');
  });
});

describe('[P5 row10b] the dedupe merges replacementFrom', () => {
  it('two pool entries for one cid keep the best class and every unique source heading', () => {
    const search = toSearch('Cats');
    const base = { cid: 'lcsh:sh1', label: 'Cats', rdfTypes: [], source: 'local-db' };
    const ranked = rankCandidates([
      { candidate: { ...base, via: 'replacement', replacementFrom: [{ authority: 'lcsh', localId: 'shA', label: 'A' }] }, authIndex: 0, stage: 1, hitIndex: 0 },
      { candidate: { ...base, via: 'replacement', replacementFrom: [{ authority: 'lcsh', localId: 'shB', label: 'B' }] }, authIndex: 0, stage: 1, hitIndex: 1 },
      { candidate: { ...base, via: 'replacement', replacementFrom: [{ authority: 'lcsh', localId: 'shA', label: 'A' }] }, authIndex: 0, stage: 2, hitIndex: 0 }
    ], search, 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matchClass).toBe('exact-full');
    expect(ranked[0].replacementFrom).toEqual([
      { authority: 'lcsh', localId: 'shA', label: 'A' },
      { authority: 'lcsh', localId: 'shB', label: 'B' }
    ]);
  });

  it('a candidate that was never a replacement keeps no replacementFrom', () => {
    const ranked = rankCandidates([
      { candidate: { cid: 'lcsh:sh1', label: 'Cats', rdfTypes: [], source: 'local-db', via: 'label' }, authIndex: 0, stage: 1, hitIndex: 0 }
    ], toSearch('Cats'), 10);
    expect(Object.hasOwn(ranked[0], 'replacementFrom')).toBe(false);
  });
});

describe('[P5 row10b] a failing later sub-query never discards accepted candidates', () => {
  it('Q3b fails after Q3a succeeded: the Q3a candidates stay, the failure is reported', async () => {
    mockLoc({});
    const local = localOf({
      Q1: [], Q2: [], Q3a: [row({ label: 'Cats and dogs' })], Q3b: new Error('gone')
    });
    const { results } = await runLookupStep({
      backend: backendOf(local), suggestions: [{ id: 's1', heading: 'Cats zzz', kind: 'topical' }]
    });
    expect(results[0].outcome).toBe('partial');
    expect(results[0].errorKind).toBe('local_db');
    expect(results[0].candidates.map((c) => c.cid)).toEqual(['lcsh:sh1']);
  });

  it('Q2 fails after Q1 succeeded: the Q1 candidate stays', async () => {
    mockLoc({});
    const local = localOf({ Q1: [row()], Q2: new Error('gone') });
    const { results } = await runLookupStep({
      backend: backendOf(local), suggestions: [{ id: 's1', heading: 'Cats', kind: 'topical' }]
    });
    expect(results[0].candidates.map((c) => c.cid)).toEqual(['lcsh:sh1']);
    expect(results[0].outcome).toBe('partial');
  });
});

describe('[P5 row10] the name-key operation is invalidated by a changed choice', () => {
  it('a choice change during the operation rejects its result', async () => {
    mockLoc({});
    const released = gate();
    const workflow = createWorkflow({
      loadConfig: async () => ({ cfg: { providerId: 'x', model: 'm' }, settings: {} }),
      scheduler: createScheduler(fastSchedulerOptions),
      resolveNameKeysImpl: async ({ targets }) => {
        await released.promise;
        return new Map(targets.map((t) => [t.cid, { marcKey: `1001 $a${t.label}` }]));
      }
    });
    const nameCandidate = {
      cid: 'lcnaf:n1', authority: 'lcnaf', localId: 'n1', uri: 'http://id.loc.gov/authorities/names/n1',
      label: 'Name', marcKey: null, rdfTypes: [], matchClass: 'exact-full', source: 'local-db', via: 'label'
    };
    const other = { ...nameCandidate, cid: 'lcnaf:n2', localId: 'n2', label: 'Other', uri: 'http://id.loc.gov/authorities/names/n2' };
    const run = builtRun();
    workflow.replaceState({
      ...run,
      suggest: { ...run.suggest, suggestions: [SUGGESTIONS[0]] },
      lookup: {
        results: { s1: { ...RESULTS.s1, candidates: [nameCandidate, other], provenance: { backend: 'local-db', ...IDENTITY }, replacementNotes: [] } },
        revisions: { s1: 1 },
        pending: {}
      },
      select: { ...run.select, choices: {}, additional: [], manual: { s1: { cid: 'lcnaf:n1' } } }
    });
    workflow.build();
    await yieldTicks(3);
    expect(workflow.getState().nameKeys.pending).toBe(true);

    // The cataloger picks a different heading while the keys are being fetched.
    workflow.choose('s1', 'lcnaf:n2');
    released.open();
    await yieldTicks(8);
    const { nameKeys, recommendations } = workflow.getState();
    // The first operation's answer is rejected; only the new choice is resolved.
    expect(nameKeys.keys['lcnaf:n1']).toBeUndefined();
    expect(nameKeys.keys['lcnaf:n2']).toBe('1001 $aOther');
    expect(recommendations.map((r) => r.cid)).toEqual(['lcnaf:n2']);
    expect(recommendations[0].marc.status).toBe('from-authority');
    expect(recommendations[0].marcKeySource).toBe('loc-api');
  });
});
