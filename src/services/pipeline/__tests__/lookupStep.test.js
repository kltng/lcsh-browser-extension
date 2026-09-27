import { describe, it, expect, vi, afterEach } from 'vitest';
import { runLookupStep, LOOKUP_BUDGET_MS } from '../lookupStep';
import { createLocApiBackend } from '../../lookup/locApi';
import { createScheduler, createRunCache } from '../../lookup/scheduler';
import { isCandidate } from '../types';
import { hit, EVIDENCE, mockLoc } from '../../../../test/locFixtures';

const hang = () => new Promise(() => {});
const backendOf = (opts = {}) => createLocApiBackend({ scheduler: createScheduler({ spacingMs: 0, maxInFlight: 8, ...opts }), cache: createRunCache() });
const SUGGESTIONS = [
  { id: 's1', heading: 'Cats', kind: 'topical' },
  { id: 's2', heading: 'Motion pictures--Japan', kind: 'topical' },
  { id: 's3', heading: 'Zzz', kind: 'topical' }
];

afterEach(() => {
  vi.useRealTimers();
});

describe('[P4 row8] lookup step: the 120 s work budget', () => {
  it('the budget is 120 s', () => {
    expect(LOOKUP_BUDGET_MS).toBe(120000);
  });

  it('expiry finalizes every suggestion: completed keep their outcome; unfinished → partial/failed with timeout (not cancelled)', async () => {
    vi.useFakeTimers({ now: 0 });
    mockLoc({
      'lcsh leftanchored "Cats"': [EVIDENCE.cats],
      'lcsh leftanchored "Motion pictures--Japan"': [EVIDENCE.motionPicturesJapanHistory],
      'lcsh leftanchored "Motion pictures"': hang,
      'lcsh leftanchored "Zzz"': hang
    });
    const onResult = vi.fn();
    const done = runLookupStep({ backend: backendOf(), suggestions: SUGGESTIONS, budgetMs: 5000, onResult });
    await vi.advanceTimersByTimeAsync(5001);
    const { results, debug } = await done;
    expect(results.map((r) => [r.suggestionId, r.outcome, r.errorKind, r.candidates.length])).toEqual([
      ['s1', 'found', null, 1],
      ['s2', 'partial', 'timeout', 1],
      ['s3', 'failed', 'timeout', 0]
    ]);
    expect(debug.budgetExpired).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(results.every((r) => typeof r.searchedAt === 'string')).toBe(true);
    expect(results[0].candidates.every(isCandidate)).toBe(true);
  });

  it('queued work is dropped at expiry (with the real 2-in-flight / 500 ms queue)', async () => {
    vi.useFakeTimers({ now: 0 });
    const loc = mockLoc({ 'lcsh leftanchored "A"': hang, 'lcsh leftanchored "B"': hang, 'lcsh leftanchored "C"': hang });
    const backend = createLocApiBackend({ scheduler: createScheduler(), cache: createRunCache() });
    const done = runLookupStep({
      backend, suggestions: ['A', 'B', 'C'].map((h, i) => ({ id: `s${i + 1}`, heading: h, kind: 'topical' })), budgetMs: 300
    });
    await vi.advanceTimersByTimeAsync(400);
    const { results } = await done;
    expect(results.map((r) => r.errorKind)).toEqual(['timeout', 'timeout', 'timeout']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(loc.fetch.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('a caller cancel rejects with cancelled and commits nothing', async () => {
    mockLoc({ 'lcsh leftanchored "Cats"': hang });
    const controller = new AbortController();
    const onResult = vi.fn();
    const done = runLookupStep({ backend: backendOf(), suggestions: [SUGGESTIONS[0]], signal: controller.signal, onResult });
    await Promise.resolve();
    controller.abort();
    await expect(done).rejects.toMatchObject({ kind: 'cancelled' });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('the limit and the debug counts', async () => {
    mockLoc({ 'lcsh leftanchored "Japan"': [...Array.from({ length: 6 }, (_, i) => hit('lcsh', `sh${i + 1}`, `Japan--X${i}`)), EVIDENCE.historySubdivision] });
    const { results, debug } = await runLookupStep({ backend: backendOf(), suggestions: [{ id: 's1', heading: 'Japan', kind: 'topical' }], limit: 4 });
    expect(results[0].candidates).toHaveLength(4);
    expect(debug.rejectedHits).toBe(1);
    expect(debug.requests.length).toBeGreaterThan(0);
  });
});
