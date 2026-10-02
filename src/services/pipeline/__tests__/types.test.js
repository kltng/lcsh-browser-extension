import { describe, it, expect } from 'vitest';
import { makeSuggestion, makeSelection, makeLookupResult, isCandidate, isSelection, NONE_REASONS, NONE_REASON_WORDS } from '../types';
import { C } from '../../../../test/pipelineFixtures';

describe('[P4 row9] select: data model validators (types.js)', () => {
  it('factories normalize their fields', () => {
    // UI2 §2: a new suggestion is AI-authored unless explicitly the user's.
    expect(makeSuggestion({ id: 's1', heading: 'Cats', kind: 'bogus' })).toEqual({ id: 's1', heading: 'Cats', kind: 'unknown', reason: '', source: 'ai' });
    expect(makeSuggestion({ id: 's2', heading: 'Dogs', source: 'user' }).source).toBe('user');
    expect(makeSuggestion({ id: 's3', heading: 'Owls', source: 'robot' }).source).toBe('ai');
    expect(makeSelection({ suggestionId: 's1', cid: 'lcsh:x', method: 'manual', confidence: 90, noneReason: 'no-results' }))
      .toMatchObject({ confidence: null, noneReason: null });
    expect(makeSelection({ suggestionId: 's1', method: 'ai', cid: 'lcsh:x', confidence: 101 }).confidence).toBeNull();
    expect(makeLookupResult({ suggestionId: 's1', outcome: 'weird' }).outcome).toBe('failed');
  });

  it('isCandidate and isSelection', () => {
    expect(isCandidate(C.mpjh)).toBe(true);
    expect(isCandidate({ ...C.mpjh, source: 'model' })).toBe(false);
    expect(isCandidate({ ...C.mpjh, cid: 'lcsh:other' })).toBe(false);
    expect(isSelection(makeSelection({ suggestionId: 's1', noneReason: 'not-chosen' }))).toBe(true);
    expect(isSelection({ ...makeSelection({ suggestionId: 's1', noneReason: 'not-chosen' }), noneReason: 'bogus' })).toBe(false);
  });

  it('every noneReason has words; manual-none reads "You chose none"', () => {
    for (const reason of NONE_REASONS) expect(NONE_REASON_WORDS[reason]).toBeTruthy();
    expect(NONE_REASON_WORDS['manual-none']).toBe('You chose none');
  });
});
