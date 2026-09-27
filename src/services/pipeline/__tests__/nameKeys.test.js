import { describe, it, expect, vi } from 'vitest';
import {
  needsNameKey, nameKeyTargets, readNameAnswer, resolveNameKeys, applyNameKeys, mergeNameKeys, emptyNameKeyState,
  NAME_KEY_DEADLINE_MS
} from '../nameKeys';
import { NAME_KEY_REASONS } from '../types';
import { beginNameKeys } from '../run';
import { createLocRequester, buildSearchUrl } from '../../lookup/locApi';
import { createScheduler, createRunCache } from '../../lookup/scheduler';
import { mockLoc, fastSchedulerOptions, hit } from '../../../../test/locFixtures';

const KURO_URI = 'http://id.loc.gov/authorities/names/n79091264';
const KURO_KEY = '1001 $aKurosawa, Akira,$d1910-1998';

const localName = (over = {}) => ({
  cid: 'lcnaf:n79091264', authority: 'lcnaf', localId: 'n79091264', uri: KURO_URI,
  label: 'Kurosawa, Akira, 1910-1998', source: 'local-db', marcKey: null,
  marc: { status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'no key' },
  selections: [{ suggestionId: 's1', method: 'manual', confidence: null, lexicalSimilarity: 90 }],
  ...over
});

const requesterOf = () => createLocRequester({
  scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache()
});

describe('[P5 row10] scope: which candidates need a key', () => {
  it('only local LCNAF rows with no key', () => {
    expect(needsNameKey(localName())).toBe(true);
    expect(needsNameKey({ ...localName(), source: 'loc-api' })).toBe(false);
    expect(needsNameKey({ ...localName(), authority: 'lcsh' })).toBe(false);
    expect(needsNameKey({ ...localName(), marcKey: '1001 $aX' })).toBe(false);
    expect(needsNameKey(null)).toBe(false);
  });

  it('targets are the DISTINCT cids, in order', () => {
    const other = localName({ cid: 'lcnaf:n2', localId: 'n2', uri: 'http://id.loc.gov/authorities/names/n2' });
    expect(nameKeyTargets([localName(), other, localName()]).map((t) => t.cid)).toEqual(['lcnaf:n79091264', 'lcnaf:n2']);
    expect(nameKeyTargets([{ ...localName(), source: 'loc-api' }])).toEqual([]);
  });
});

describe('[P5 row10] every §7 result case', () => {
  const targets = [{ cid: 'lcnaf:n79091264', label: 'Kurosawa, Akira, 1910-1998', uri: KURO_URI }];

  it('a matching hit with a key attaches it', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Kurosawa, Akira, 1910-1998"': [hit('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', { marcKey: KURO_KEY })] });
    const resolved = await resolveNameKeys({ targets, requester: requesterOf() });
    expect(resolved.get('lcnaf:n79091264')).toEqual({ marcKey: KURO_KEY });
    // The request is P4's bounded leftanchored count.
    expect(loc.fetch.mock.calls[0][0]).toBe(buildSearchUrl('lcnaf', 'Kurosawa, Akira, 1910-1998', 'leftanchored'));
  });

  it('offline makes NO request at all', async () => {
    const loc = mockLoc({});
    const resolved = await resolveNameKeys({ targets, requester: requesterOf(), isOnline: () => false });
    expect(resolved.get('lcnaf:n79091264')).toEqual({ reason: NAME_KEY_REASONS.offline });
    expect(NAME_KEY_REASONS.offline).toBe('MARC not available offline');
    expect(loc.fetch).not.toHaveBeenCalled();
  });

  it('a failed request reports the kind', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const resolved = await resolveNameKeys({ targets, requester: requesterOf() });
    expect(resolved.get('lcnaf:n79091264')).toEqual({ reason: NAME_KEY_REASONS.failed, errorKind: 'network' });
  });

  it('no hit with the candidate URI is "No matching name returned by this search"', async () => {
    mockLoc({ 'lcnaf leftanchored "Kurosawa, Akira, 1910-1998"': [hit('lcnaf', 'n99999999', 'Kurosawa, Akiro', { marcKey: '1001 $aKurosawa, Akiro' })] });
    const resolved = await resolveNameKeys({ targets, requester: requesterOf() });
    expect(resolved.get('lcnaf:n79091264')).toEqual({ reason: NAME_KEY_REASONS['no-match'] });
  });

  it('several matching hits with DIFFERENT keys choose nothing', () => {
    const answer = {
      ok: true,
      candidates: [
        { uri: KURO_URI, marcKey: KURO_KEY },
        { uri: KURO_URI, marcKey: '1001 $aKurosawa, Akira' }
      ]
    };
    expect(readNameAnswer(answer, { uri: KURO_URI })).toEqual({ reason: NAME_KEY_REASONS.failed });
  });

  it('several matching hits with the SAME key are not a conflict', () => {
    const answer = { ok: true, candidates: [{ uri: KURO_URI, marcKey: KURO_KEY }, { uri: KURO_URI, marcKey: KURO_KEY }] };
    expect(readNameAnswer(answer, { uri: KURO_URI })).toEqual({ marcKey: KURO_KEY });
  });

  it('a matching hit with no key keeps the existing "no key" reason', async () => {
    mockLoc({ 'lcnaf leftanchored "Kurosawa, Akira, 1910-1998"': [hit('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998')] });
    const resolved = await resolveNameKeys({ targets, requester: requesterOf() });
    expect(resolved.get('lcnaf:n79091264')).toEqual({ reason: 'no key' });
  });

  it('the run cache is used, and Retry bypasses it for the unresolved cids only', async () => {
    const loc = mockLoc({ 'lcnaf leftanchored "Kurosawa, Akira, 1910-1998"': [hit('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', { marcKey: KURO_KEY })] });
    const requester = requesterOf();
    await resolveNameKeys({ targets, requester });
    await resolveNameKeys({ targets, requester });
    expect(loc.fetch).toHaveBeenCalledTimes(1);
    await resolveNameKeys({ targets, requester, bypassCids: new Set(['lcnaf:n79091264']) });
    expect(loc.fetch).toHaveBeenCalledTimes(2);
    await resolveNameKeys({ targets, requester, bypassCids: new Set(['lcnaf:other']) });
    expect(loc.fetch).toHaveBeenCalledTimes(2);
  });

  it('ONE deadline covers the whole operation', async () => {
    const seen = [];
    await resolveNameKeys({
      targets: [],
      requester: requesterOf(),
      setTimeoutImpl: (fn, ms) => {
        seen.push(ms);
        return 0;
      }
    });
    expect(seen).toEqual([]); // no targets → no deadline started
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const promise = resolveNameKeys({ targets, requester: requesterOf(), deadlineMs: 10 });
    await expect(promise).resolves.toBeInstanceOf(Map);
    expect((await promise).get('lcnaf:n79091264').reason).toBe(NAME_KEY_REASONS.failed);
    expect(NAME_KEY_DEADLINE_MS).toBe(120000);
  });

  it('the caller signal cancels the whole operation', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = resolveNameKeys({ targets, requester: requesterOf(), signal: controller.signal });
    controller.abort();
    const resolved = await promise;
    expect(resolved.get('lcnaf:n79091264').reason).toBe(NAME_KEY_REASONS.failed);
  });
});

describe('[P5 row10] applying the keys', () => {
  it('a resolved key builds the MARC field from a COPY; label and identity are unchanged', () => {
    const state = mergeNameKeys(emptyNameKeyState(), new Map([['lcnaf:n79091264', { marcKey: KURO_KEY }]]));
    const [rec] = applyNameKeys([localName()], state);
    expect(rec.marc.status).toBe('from-authority');
    expect(rec.marc.text).toBe('600 10 $a Kurosawa, Akira, $d 1910-1998');
    expect(rec.marcKeySource).toBe('loc-api');
    expect(rec.label).toBe('Kurosawa, Akira, 1910-1998');
    expect(rec.cid).toBe('lcnaf:n79091264');
    // The resolved key stays on the copy, so this name is no longer unresolved
    // and a Retry never asks for it again (review finding 7).
    expect(rec.marcKey).toBe(KURO_KEY);
    expect(needsNameKey(rec)).toBe(false);
  });

  it('a REUSED key is re-checked against the CURRENT label, so a changed label never inherits it', () => {
    const state = mergeNameKeys(emptyNameKeyState(), new Map([['lcnaf:n79091264', { marcKey: KURO_KEY }]]));
    const [rec] = applyNameKeys([localName({ label: 'Kurosawa, Akira' })], state);
    expect(rec.marc.status).toBe('unavailable');
    expect(rec.marc.reason).toBe('key does not match label');
  });

  it('a reason replaces the MARC reason and leaves the recommendation in place', () => {
    const state = mergeNameKeys(emptyNameKeyState(), new Map([['lcnaf:n79091264', { reason: NAME_KEY_REASONS.offline }]]));
    const [rec] = applyNameKeys([localName()], state);
    expect(rec.marc.status).toBe('unavailable');
    expect(rec.marc.reason).toBe('MARC not available offline');
    expect(rec.cid).toBe('lcnaf:n79091264');
  });

  it('a later success clears the earlier reason', () => {
    const state = emptyNameKeyState();
    mergeNameKeys(state, new Map([['lcnaf:n79091264', { reason: NAME_KEY_REASONS.failed }]]));
    mergeNameKeys(state, new Map([['lcnaf:n79091264', { marcKey: KURO_KEY }]]));
    expect(state.reasons.has('lcnaf:n79091264')).toBe(false);
    expect(applyNameKeys([localName()], state)[0].marc.status).toBe('from-authority');
  });

  it('recommendations that do not need a key are untouched', () => {
    const online = { ...localName(), source: 'loc-api' };
    expect(applyNameKeys([online], emptyNameKeyState())[0]).toBe(online);
  });
});

// Review finding 7: Retry asks only for the names that are still unresolved.
describe('[P5 fix7] Retry name keys never re-fetches a resolved name', () => {
  const other = () => localName({
    cid: 'lcnaf:n2', localId: 'n2', uri: 'http://id.loc.gov/authorities/names/n2', label: 'Second, Name'
  });

  it('one resolved and one failed name: only the failed one is a target and a bypass', () => {
    const state = emptyNameKeyState();
    mergeNameKeys(state, new Map([
      ['lcnaf:n79091264', { marcKey: KURO_KEY }],
      ['lcnaf:n2', { reason: NAME_KEY_REASONS.failed }]
    ]));
    const recommendations = applyNameKeys([localName(), other()], state);
    // The resolved one is no longer "unresolved" at all.
    expect(nameKeyTargets(recommendations).map((t) => t.cid)).toEqual(['lcnaf:n2']);

    const runState = {
      run: { runId: 'r1' },
      lookup: { results: {}, revisions: {}, pending: {} },
      select: { additional: [] },
      suggest: { suggestions: [] },
      recommendations,
      nameKeys: {
        revision: 1, pending: false,
        keys: Object.fromEntries(state.keys), reasons: Object.fromEntries(state.reasons),
        deps: {}, choicesKey: null
      }
    };
    const retry = beginNameKeys(runState, { retry: true });
    expect(retry.targets.map((t) => t.cid)).toEqual(['lcnaf:n2']);
    expect([...retry.bypassCids]).toEqual(['lcnaf:n2']);

    // An ordinary regeneration asks for neither: one is resolved, one failed.
    expect(beginNameKeys(runState).targets).toEqual([]);
  });
});
