import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import AppContext from '../../context/AppContext';
import InitialSuggestions, { SuggestionsPanel } from '../InitialSuggestions';
import ScrapedResults, { MatchesPanel } from '../ScrapedResults';
import FinalRecommendations, { RecommendationsPanel } from '../FinalRecommendations';
import { V2EntryView, LegacyEntryView } from '../ConversationHistory';
import { selectionsOf, continueWithoutAi, beginSelect, failSelect, setManualChoice } from '../../services/pipeline/run';
import { buildHistoryEntry, LEGACY_MARC_LABEL, LEGACY_HEADER } from '../../services/history';
import { lcLink, NO_MATCH_TEXT } from '../pipelineText';
import { renderHtml, textOf } from '../../../test/render';
import { builtRun, C, V110_ENTRY, P3_ENTRY, SUGGESTIONS, RESULTS } from '../../../test/pipelineFixtures';

const CANDIDATE_IDS = new Set(Object.values(C).map((c) => c.localId));
const CANDIDATE_LINKS = new Set(Object.values(C).map((c) => lcLink(c.uri)));
const hrefsOf = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const lcIdsOf = (text) => [...text.matchAll(/LC ID: (\S+)/g)].map((m) => m[1]);
const withContext = (Component, run) => renderToString(React.createElement(
  AppContext.Provider,
  { value: { run, workflow: { choose: vi.fn(), retryLookup: vi.fn(), select: vi.fn(), build: vi.fn(), lookupAll: vi.fn(), continueWithoutAi: vi.fn() }, setActiveStep: vi.fn(), saveRunToHistory: vi.fn() } },
  React.createElement(Component)
)).replace(/<!-- -->/g, '');

/** Fixture states covering every outcome and every noneReason. */
const states = () => {
  const built = builtRun();
  const exact = continueWithoutAi(built);
  const stoppedSel = beginSelect({ ...built, recommendations: null }, null);
  const stopped = failSelect(stoppedSel.state, stoppedSel.token, { kind: 'auth', message: 'DeepSeek rejected the API key. Check it in Settings.' });
  return { built, exact, stopped };
};

const expectHonest = (html) => {
  const text = textOf(html);
  expect(text).not.toMatch(/verif/i);
  expect(text).not.toMatch(/not in LC|not found in LC/i);
  for (const href of hrefsOf(html)) expect(CANDIDATE_LINKS.has(href), href).toBe(true);
  for (const id of lcIdsOf(text)) expect(CANDIDATE_IDS.has(id), id).toBe(true);
  return text;
};

describe('[P4 row15] honesty: step components', () => {
  it('step 2: suggestions are labeled as AI suggestions; the text-fallback banner; no LC data', () => {
    const { built } = states();
    for (const suggestMode of ['json', 'text-fallback']) {
      const html = renderHtml(SuggestionsPanel, { suggest: { ...built.suggest, suggestMode } });
      const text = expectHonest(html);
      expect(hrefsOf(html)).toEqual([]);
      expect(lcIdsOf(text)).toEqual([]);
      expect(text).toContain('These are AI suggestions. The next step looks them up at the Library of Congress.');
      expect(text).toContain('AI suggestion · topical');
      expect(text.includes('The model did not return structured output; suggestions were read from plain text.')).toBe(suggestMode === 'text-fallback');
    }
    const container = expectHonest(withContext(InitialSuggestions, built));
    expect(container).toContain('Look up at the Library of Congress');
  });

  it('step 3: every outcome line and every noneReason in words', () => {
    const { built, exact, stopped } = states();
    const html = renderHtml(MatchesPanel, {
      suggestions: SUGGESTIONS, results: RESULTS, selections: selectionsOf(built), mode: 'ai', manual: built.select.manual,
      onChoose: vi.fn(), onRetry: vi.fn()
    });
    const text = expectHonest(html);
    expect(text).toContain('2 candidates');
    expect(text).toContain('1 candidate (some searches failed)');
    expect(text).toContain(NO_MATCH_TEXT);
    expect(NO_MATCH_TEXT).toBe('No match returned by this search');
    expect(text).toContain('Lookup failed: Could not reach id.loc.gov. Check your connection.');
    expect(text).toContain('Retry lookup');
    expect(text).toContain('AI choice (confidence 85)');
    expect(text).toContain('Your choice');
    expect(text).toContain('You chose none');
    expect(text).toContain('None — the AI chose none of the candidates');
    expect(text).toContain('Use this heading');
    expect(text).toContain('Use none');
    expect(hrefsOf(html).length).toBeGreaterThan(0);

    const s6Chosen = setManualChoice(built, 's6', C.mpjh.cid);
    const dropped = expectHonest(renderHtml(MatchesPanel, {
      suggestions: SUGGESTIONS, results: RESULTS, selections: selectionsOf(s6Chosen), mode: 'ai', manual: s6Chosen.select.manual
    }));
    expect(dropped).toContain('The selected heading does not include these suggested subdivisions: Biography');

    const exactText = expectHonest(renderHtml(MatchesPanel, {
      suggestions: SUGGESTIONS, results: RESULTS, selections: selectionsOf({ ...exact, select: { ...exact.select, manual: {} } }), mode: 'exact-fallback'
    }));
    expect(exactText).toContain('Exact match');
    expect(exactText).toContain('None — no unique exact match (the AI did not choose)');

    const notChosen = expectHonest(renderHtml(MatchesPanel, {
      suggestions: SUGGESTIONS, results: RESULTS, selections: selectionsOf({ ...stopped, select: { ...stopped.select, manual: {}, mode: 'ai' } }), mode: 'ai'
    }));
    expect(notChosen).toContain('None — no candidate was chosen');

    const pending = expectHonest(renderHtml(MatchesPanel, {
      suggestions: SUGGESTIONS, results: {}, pending: { s1: true }, selections: [], mode: null
    }));
    expect(pending).toContain('Searching the Library of Congress…');
    expect(pending).toContain('Not looked up yet');

    const stoppedText = expectHonest(withContext(ScrapedResults, stopped));
    expect(stoppedText).toContain('DeepSeek rejected the API key. Check it in Settings.');
    expect(stoppedText).toContain('Continue without AI (exact matches only)');
    expect(stoppedText).toContain('Settings');
    const fallbackText = expectHonest(withContext(ScrapedResults, exact));
    expect(fallbackText).toContain('The AI could not choose; only exact matches were kept.');
  });

  it('step 4: LC ID and link only from Candidates; suggestions without a heading are never recommendations', () => {
    const { built } = states();
    const html = renderHtml(RecommendationsPanel, {
      recommendations: built.recommendations, selections: selectionsOf(built), suggestions: SUGGESTIONS, onCopy: vi.fn()
    });
    const text = expectHonest(html);
    expect(lcIdsOf(text)).toEqual(['sh2008108026', 'n78089021', 'sh2010102453']);
    expect(hrefsOf(html)).toEqual(built.recommendations.map((r) => lcLink(r.uri)));
    expect(text).toContain('MARC field (text form):');
    expect(text).toContain('650 _0 $a Motion pictures $z Japan $x History');
    expect(text).toContain('Additional AI pick (confidence 45)');
    expect(text).toContain('Suggestions without an LC heading');
    expect(text).toContain('Japanese cinema (AI suggestion)');
    expect(text).toContain('no match returned by this search');
    expect(text).not.toContain('MARC record');
    const container = expectHonest(withContext(FinalRecommendations, built));
    expect(container).toContain('Copy all');
    expect(container).toContain('Save to history');
  });

  it('MARC not available is shown with its reason', () => {
    const { built } = states();
    const rec = { ...built.recommendations[0], marc: { status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'no key' } };
    const text = expectHonest(renderHtml(RecommendationsPanel, { recommendations: [rec], selections: selectionsOf(built), suggestions: SUGGESTIONS }));
    expect(text).toContain('MARC not available (no key)');
  });
});

describe('[P4 row15] honesty: the history view', () => {
  it('a v2 entry re-renders honestly', () => {
    const entry = buildHistoryEntry({ run: builtRun() });
    const html = renderHtml(V2EntryView, { entry });
    const text = expectHonest(html);
    expect(text).toContain(NO_MATCH_TEXT);
  });

  it('legacy entries: the UNVERIFIED label, no LC ID and no LC link; old "verified" text only under the older-version label', () => {
    for (const entry of [V110_ENTRY, P3_ENTRY]) {
      const html = renderHtml(LegacyEntryView, { entry, onCopy: vi.fn() });
      const text = textOf(html);
      expect(text).toContain(LEGACY_HEADER);
      expect(text).toContain(LEGACY_MARC_LABEL);
      expect(hrefsOf(html)).toEqual([]);
      expect(lcIdsOf(text)).toEqual([]);
      const verified = text.match(/(?<!un)verified/gi) || [];
      expect(verified).toHaveLength(1);
      expect(text).toContain('Text from the older version (not checked): Main topic (✓ Verified by API)');
    }
  });
});
