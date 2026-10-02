/**
 * P6 fix 14: FINISHED display values are checked (findings 2 and 3). Model
 * text that is joined or formatted for display after the suggest commit, and
 * every model-derived field of a history entry, is shown as fixed local text
 * when it repeats a known key. Stored entries are never changed.
 *
 * Only APIs that existed before fix 14 are used, so this file also runs on
 * the old code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MatchesPanel } from '../ScrapedResults';
import { RecommendationsPanel } from '../FinalRecommendations';
import { V2EntryView, LegacyEntryView } from '../ConversationHistory';
import { buildHistoryEntry, loadHistory } from '../../services/history';
import { selectionsOf, buildRun } from '../../services/pipeline/run';
import { rememberRunKey, setStoredKeys, resetKeyRegistry, watchStoredKeys } from '../../services/keyGuard';
import { renderHtml, textOf } from '../../../test/render';
import { builtRun, V110_ENTRY } from '../../../test/pipelineFixtures';
import { fakes } from '../../../test/setup';

const HIDDEN = 'Hidden: this text repeats an API key.';

beforeEach(() => resetKeyRegistry());

/** builtRun() with s1's heading given extra subdivisions the chosen record lacks. */
const runWithHeading = (heading) => {
  const run = builtRun();
  const suggestions = run.suggest.suggestions.map((s) => (s.id === 's1' ? { ...s, heading } : s));
  return buildRun({ ...run, suggest: { ...run.suggest, suggestions } });
};
const matchesHtml = (run) => renderHtml(MatchesPanel, {
  suggestions: run.suggest.suggestions, results: run.lookup.results, selections: selectionsOf(run), mode: run.select.mode, readOnly: true
});
const recommendationsHtml = (run) => renderHtml(RecommendationsPanel, {
  recommendations: run.recommendations, selections: selectionsOf(run), suggestions: run.suggest.suggestions
});

describe('[P6 fix14] finished display values (finding 2)', () => {
  it('key "abc, def", heading "…--abc--def": the JOINED subdivision note is hidden in Matches and Recommendations', () => {
    rememberRunKey('abc, def');
    const run = runWithHeading('Motion pictures--Japan--History--abc--def');
    const s1 = selectionsOf(run).find((s) => s.suggestionId === 's1');
    expect(s1.droppedSubdivisions).toEqual(['abc', 'def']);
    for (const html of [matchesHtml(run), recommendationsHtml(run)]) {
      const text = textOf(html);
      expect(text).not.toContain('abc, def');
      expect(text).toContain(HIDDEN);
    }
  });

  it('a stored key that only appears once a line is ASSEMBLED ("<heading> (AI suggestion)") is hidden too', () => {
    // s4 "Japanese cinema" has no LC heading, so it is listed as "Japanese cinema (AI suggestion)".
    setStoredKeys(['cinema (AI sugg']);
    const text = textOf(recommendationsHtml(runWithHeading('Motion pictures--Japan--History')));
    expect(text).not.toContain('cinema (AI sugg');
    expect(text).toContain(HIDDEN);
  });

  it('an ordinary run shows every value; nothing is hidden', () => {
    rememberRunKey('sk-run-key-1234567');
    setStoredKeys(['sk-other-key-7654321', 'a']);
    const run = runWithHeading('Motion pictures--Japan--History--Interviews');
    for (const html of [matchesHtml(run), recommendationsHtml(run)]) {
      const text = textOf(html);
      expect(text).toContain('Interviews');
      expect(text).not.toContain(HIDDEN);
    }
  });
});

describe('[P6 fix14] history display (finding 3)', () => {
  const KEY = 'sk-history-stored-key-42';

  it('an OLD v2 entry with a stored key is hidden when shown; the stored entry is unchanged', async () => {
    const run = runWithHeading(`Motion pictures--Japan--History--${KEY}`);
    const entry = buildHistoryEntry({ run: { ...run, suggest: { ...run.suggest, subjectAnalysis: `About ${KEY}.` } }, id: 'old', timestamp: '2026-09-01T00:00:00.000Z' });
    // Written by an older version, before the save check existed.
    await fakes.storage.local.set({ conversationHistory: [entry] });
    const before = JSON.stringify(fakes.storage.dump());
    setStoredKeys([KEY]);
    const [loaded] = await loadHistory();
    const text = textOf(renderHtml(V2EntryView, { entry: loaded }));
    expect(text).not.toContain(KEY);
    expect(text).toContain(HIDDEN);
    expect(JSON.stringify(fakes.storage.dump())).toBe(before);
  });

  it('an OLD legacy entry with a stored key is hidden when shown; the stored entry is unchanged', async () => {
    const legacy = {
      ...V110_ENTRY,
      initialSuggestions: { specialConsiderations: `Use ${KEY}.` },
      finalRecommendations: [{ ...V110_ENTRY.finalRecommendations[0], justification: `Because ${KEY}` }],
      marcRecords: { Cats: `650 _0 $a Cats ${KEY}` }
    };
    await fakes.storage.local.set({ conversationHistory: [legacy] });
    const before = JSON.stringify(fakes.storage.dump());
    setStoredKeys([KEY]);
    const [loaded] = await loadHistory();
    const text = textOf(renderHtml(LegacyEntryView, { entry: loaded, onCopy: () => {} }));
    expect(text).not.toContain(KEY);
    expect(text).toContain(HIDDEN);
    expect(JSON.stringify(fakes.storage.dump())).toBe(before);
  });

  it('ordinary history entries are shown unchanged', async () => {
    setStoredKeys([KEY, 'a']);
    const entry = buildHistoryEntry({ run: builtRun(), id: 'ok', timestamp: '2026-09-01T00:00:00.000Z' });
    await fakes.storage.local.set({ conversationHistory: [entry, V110_ENTRY] });
    const [v2, legacy] = await loadHistory();
    const v2Text = textOf(renderHtml(V2EntryView, { entry: v2 }));
    expect(v2Text).toContain('Motion pictures--Japan--History');
    expect(v2Text).not.toContain(HIDDEN);
    const legacyText = textOf(renderHtml(LegacyEntryView, { entry: legacy, onCopy: () => {} }));
    expect(legacyText).toContain('Main topic');
    expect(legacyText).not.toContain(HIDDEN);
  });
});

// P6 fix 15, item 1: nothing model-derived is shown before the stored keys
// have loaded once.
describe('[P6 fix15] history renders before the stored keys load', () => {
  const KEY = 'sk-late-loaded-key-0099';

  it('model fields are not shown until the keys are ready; then the clean ones appear and the echo is hidden', async () => {
    let answer;
    const stop = watchStoredKeys({
      readStoredApiKeys: () => new Promise((resolve) => { answer = resolve; }),
      onSettingsChanged: () => () => {}
    });
    const run = runWithHeading(`Motion pictures--Japan--History--${KEY}`);
    const entry = buildHistoryEntry({ run, id: 'early', timestamp: '2026-09-01T00:00:00.000Z' });
    await fakes.storage.local.set({ conversationHistory: [entry, V110_ENTRY] });
    const [v2, legacy] = await loadHistory();

    // Keys not loaded yet: neither the echo nor any other model text is shown.
    const before = textOf(renderHtml(V2EntryView, { entry: v2 })) + textOf(renderHtml(LegacyEntryView, { entry: legacy, onCopy: () => {} }));
    expect(before).not.toContain(KEY);
    expect(before).not.toContain('Japanese film people.');
    expect(before).not.toContain('Main topic');
    expect(before).toContain('Loading…');

    answer([KEY]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = textOf(renderHtml(V2EntryView, { entry: v2 })) + textOf(renderHtml(LegacyEntryView, { entry: legacy, onCopy: () => {} }));
    expect(after).not.toContain(KEY);
    expect(after).toContain(HIDDEN);
    expect(after).toContain('Japanese film people.');
    expect(after).toContain('Main topic');
    expect(after).not.toContain('Loading…');
    stop();
  });
});

// P6 fix 15, item 3: each COMPLETE legacy line is checked, not only its parts.
describe('[P6 fix15] legacy history lines are checked as assembled', () => {
  it('key "abc; link def" from identifier "abc" and link "def" → the line is hidden', () => {
    setStoredKeys(['abc; link def']);
    const legacy = {
      ...V110_ENTRY,
      finalRecommendations: [{ ...V110_ENTRY.finalRecommendations[0], bestMatch: { ...V110_ENTRY.finalRecommendations[0].bestMatch, identifier: 'abc', uri: 'def' } }]
    };
    const text = textOf(renderHtml(LegacyEntryView, { entry: legacy, onCopy: () => {} }));
    expect(text).not.toContain('abc; link def');
    expect(text).toContain(HIDDEN);
  });
});
