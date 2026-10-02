/**
 * SPEC-UI2 §13 acceptance coverage for provenance, order and formatting, and
 * presentation, plus the integration with round 1 (History navigation,
 * Settings sections, plain match labels, Matches summary).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RecommendationsPanel } from '../FinalRecommendations';
import { MatchesPanel } from '../ScrapedResults';
import { SuggestionsPanel, hasDownstreamResults } from '../InitialSuggestions';
import { V2EntryView, LegacyEntryView } from '../ConversationHistory';
import ConfidenceBadge from '../ConfidenceBadge';
import SettingsPage, { ProviderMark } from '../SettingsPage';
import { PopupView, offlineDatabaseLine } from '../PopupLauncher';
import { nextMoreDetailsOpen, hasMoreDetails } from '../BibliographicInfoForm';
import { isProviderConfigured, isNanoAvailable } from '../providerStatus';
import {
  confidenceLevel, confidenceTooltip, authorLabel, matchesSummary, matchClassLabel, SUGGESTION_NOTE, DOWNSTREAM_WARNING
} from '../pipelineText';
import { AppProvider, useAppContext, EMPTY_BIBLIOGRAPHIC_INFO } from '../../context/AppContext';
import { buildHistoryEntry, rebuildEntry, runViewOf, legacyMarcCopyText, LEGACY_MARC_LABEL } from '../../services/history';
import { selectionsOf, buildRun, editSuggestions } from '../../services/pipeline/run';
import { copyAllText, csvRows, recommendationsCsv, marcTextOf } from '../../services/pipeline/exports';
import { formatMarcField, sortRecommendations, resolveDelimiter } from '../../services/pipeline/marcFormat';
import { getSettings, setSubfieldDelimiter, DELIMITER_KEY } from '../../services/settings';
import { PROVIDERS } from '../../services/providers/registry';
import { guardExit, KeyEchoError, setStoredKeys, resetKeyRegistry, HIDDEN_TEXT } from '../../services/keyGuard';
import { renderHtml, textOf } from '../../../test/render';
import { builtRun, V110_ENTRY, C } from '../../../test/pipelineFixtures';
import { fakes } from '../../../test/setup';

beforeEach(() => resetKeyRegistry());

/** builtRun() with s1, s3 and s4 written by the user (s1: AI choice; s3: manual; s4: no results). */
const mixedRun = () => {
  const run = builtRun();
  const suggestions = run.suggest.suggestions.map((s) => (['s1', 's3', 's4'].includes(s.id) ? { ...s, source: 'user', reason: '' } : { ...s, source: 'ai' }));
  return buildRun({ ...run, suggest: { ...run.suggest, suggestions } });
};
const byId = (list, id) => list.find((s) => s.id === id || s.suggestionId === id);

describe('[UI2 §2 provenance] mixed AI and user headings', () => {
  it('survive history building and rebuilding (both allowlists), and the read-only panels name the author', () => {
    const run = mixedRun();
    const built = buildHistoryEntry({ run, id: 'e1', timestamp: '2026-10-02T00:00:00.000Z' });
    expect(built.suggestions.map((s) => s.source)).toEqual(['user', 'ai', 'user', 'user', 'ai', 'ai']);
    const stored = JSON.parse(JSON.stringify(built));
    const loaded = rebuildEntry(stored);
    expect(loaded.suggestions.map((s) => s.source)).toEqual(['user', 'ai', 'user', 'user', 'ai', 'ai']);
    const text = textOf(renderHtml(V2EntryView, { entry: loaded }));
    expect(text).toContain('Your heading · topical');
    expect(text).toContain('AI suggestion · topical');
    expect(text).toContain('Japanese cinema (Your heading)');
    expect(text).toContain('Kurosawa, Akira (AI suggestion)');
    // History is read-only: no edit or navigation actions
    expect(text).not.toMatch(/Back to Matches|Edit search heading|Add a heading|Remove/);
  });

  it('old v2 entries (no field) default to AI; an unsupported value is not shown as AI or user authorship', () => {
    const stored = JSON.parse(JSON.stringify(buildHistoryEntry({ run: builtRun(), id: 'e2', timestamp: 't' })));
    for (const s of stored.suggestions) delete s.source;
    stored.suggestions[0].source = 'robot';
    const loaded = rebuildEntry(stored);
    expect(loaded.suggestions.map((s) => s.source)).toEqual(['unknown', 'ai', 'ai', 'ai', 'ai', 'ai']);
    expect(authorLabel('unknown')).toBe('Suggestion');
    const text = textOf(renderHtml(V2EntryView, { entry: loaded }));
    expect(text).toContain('Suggestion · topical');
    expect(text).not.toMatch(/Your heading/);
  });

  it('authorship is independent of the selection method; authority sources are unchanged', () => {
    const run = mixedRun();
    const sels = selectionsOf(run);
    expect(byId(sels, 's1').method).toBe('ai'); // a Your heading matched by the AI
    expect(byId(sels, 's3').method).toBe('manual');
    const text = textOf(renderHtml(MatchesPanel, {
      suggestions: run.suggest.suggestions, results: run.lookup.results, selections: sels, mode: run.select.mode, readOnly: true
    }));
    expect(text).toContain('Motion pictures--Japan--History (Your heading · topical)');
    expect(text).toContain('AI choice');
    expect(text).toContain('Your choice');
    expect(run.recommendations.every((r) => r.source === 'loc-api')).toBe(true);
    expect(run.recommendations.map((r) => r.cid)).not.toContain('user');
  });

  it('CSV: suggestion_sources is aligned with the selections; additional picks are null; unmatched headings are not rows', () => {
    const run = mixedRun();
    const sels = selectionsOf(run);
    const rows = csvRows(run.recommendations, sels, { suggestions: run.suggest.suggestions });
    const col = rows[0].indexOf('suggestion_sources');
    const methods = rows[0].indexOf('methods');
    expect(col).toBe(rows[0].length - 1);
    const label = rows[0].indexOf('label');
    const byLabel = Object.fromEntries(rows.slice(1).map((r) => [r[label], [r[methods], r[col]]]));
    expect(byLabel['Motion pictures--Japan--History']).toEqual(['["ai"]', '["user"]']);
    expect(byLabel.Japan).toEqual(['["manual"]', '["user"]']);
    expect(byLabel['Motion picture actors and actresses--Japan--Biography']).toEqual(['["ai"]', '[null]']);
    const all = recommendationsCsv(run.recommendations, sels, { suggestions: run.suggest.suggestions }) + copyAllText(run.recommendations, sels);
    expect(all).not.toContain('Japanese cinema');
    expect(rows).toHaveLength(1 + run.recommendations.length);
  });
});

describe('[UI2 §3, §4] order and delimiter', () => {
  const rec = (cid, tag, status = 'from-authority') => ({ cid, marc: status === 'from-authority' ? { status, tag, text: `${tag} 0 $a${cid}`, ind1: ' ', ind2: '0', subfields: [['a', cid]] } : { status, reason: 'no key' } });

  it('MARC tag order, stable ties, unavailable fields last, other tags ascending', () => {
    const sorted = sortRecommendations([
      rec('u1', null, 'unavailable'), rec('a650', '650'), rec('x690', '690'), rec('b655', '655'), rec('c600', '600'),
      rec('d650', '650'), rec('u2', null, 'unavailable'), rec('e651', '651'), rec('f610', '610'), rec('g653', '653')
    ]);
    expect(sorted.map((r) => r.cid)).toEqual(['c600', 'f610', 'a650', 'd650', 'e651', 'b655', 'g653', 'x690', 'u1', 'u2']);
  });

  it('a stored v2 entry keeps its saved order (it is not re-sorted)', () => {
    const run = builtRun();
    const entry = buildHistoryEntry({ run, id: 'e3', timestamp: 't' });
    const reversed = JSON.parse(JSON.stringify({ ...entry, recommendations: [...entry.recommendations].reverse() }));
    const view = runViewOf(rebuildEntry(reversed));
    expect(view.recommendations.map((r) => r.cid)).toEqual([...entry.recommendations].reverse().map((r) => r.cid));
  });

  it('the delimiter replaces only structural subfield boundaries; literal $ inside values stays', () => {
    const marc = { status: 'from-authority', tag: '650', ind1: ' ', ind2: '0', text: '650 _0 $a Prices $x US$ costs', subfields: [['a', 'Prices'], ['x', 'US$ costs']] };
    const dollar = formatMarcField(marc, '$');
    const dagger = formatMarcField(marc, '‡');
    expect(dagger).toBe(dollar.replace('$a', '‡a').replace('$x', '‡x'));
    expect(dagger).toContain('US$ costs');
    // Only from-authority fields are formatted
    expect(formatMarcField({ status: 'unavailable', reason: 'no key' }, '‡')).toBeNull();
    // A malformed stored structure is shown as stored, never repaired
    const broken = { status: 'from-authority', tag: '650', text: '650 _0 $a Cats', subfields: 'oops' };
    expect(formatMarcField(broken, '‡')).toBe('650 _0 $a Cats');
    expect(resolveDelimiter('#')).toBe('$');
    expect(resolveDelimiter(undefined)).toBe('$');
  });

  it('display, Copy all and CSV use the delimiter; run state and history keep canonical $ text', () => {
    const run = builtRun();
    const sels = selectionsOf(run);
    const html = renderHtml(RecommendationsPanel, { recommendations: run.recommendations, selections: sels, suggestions: run.suggest.suggestions, delimiter: '‡' });
    expect(textOf(html)).toContain('‡a');
    expect(copyAllText(run.recommendations, sels, { delimiter: '‡' })).toContain('‡a');
    const rows = csvRows(run.recommendations, sels, { suggestions: run.suggest.suggestions, delimiter: '‡' });
    const marcCol = rows[0].indexOf('marc_field');
    expect(rows.slice(1).every((r) => !r[marcCol] || r[marcCol].includes('‡'))).toBe(true);
    expect(run.recommendations.every((r) => !r.marc.text || !r.marc.text.includes('‡'))).toBe(true);
    const entry = buildHistoryEntry({ run, id: 'e4', timestamp: 't' });
    expect(JSON.stringify(entry)).not.toContain('‡');
  });

  it('legacy entries keep their warnings and AI-written MARC as stored', () => {
    const html = renderHtml(LegacyEntryView, { entry: V110_ENTRY, onCopy: () => {} });
    const text = textOf(html);
    expect(text).toContain(LEGACY_MARC_LABEL);
    expect(text).toContain('150 _0 $a Cats');
    expect(text).not.toContain('‡');
    expect(legacyMarcCopyText('650 _0 $a Cats')).toBe('UNVERIFIED (older version): 650 _0 $a Cats');
  });

  it('guards see the FINISHED formatted text: a key that only appears after formatting is caught', () => {
    const run = builtRun();
    const sels = selectionsOf(run);
    const key = 'pictures ‡z Japan';
    const canonical = run.recommendations.map((r) => r.marc.text).join('\n');
    expect(canonical).not.toContain(key);
    // Display
    setStoredKeys([key]);
    const props = { recommendations: run.recommendations, selections: sels, suggestions: run.suggest.suggestions };
    expect(textOf(renderHtml(RecommendationsPanel, { ...props, delimiter: '$' }))).not.toContain(HIDDEN_TEXT);
    const dagger = textOf(renderHtml(RecommendationsPanel, { ...props, delimiter: '‡' }));
    expect(dagger).toContain(HIDDEN_TEXT);
    expect(dagger).not.toContain(key);
    // Exports: Copy all, one field's Copy and the serialized CSV
    expect(() => guardExit('export', copyAllText(run.recommendations, sels, { delimiter: '$' }), [key])).not.toThrow();
    expect(() => guardExit('export', copyAllText(run.recommendations, sels, { delimiter: '‡' }), [key])).toThrow(KeyEchoError);
    expect(() => guardExit('export', marcTextOf(run.recommendations[0], '‡'), [key])).toThrow(KeyEchoError);
    expect(() => guardExit('export', recommendationsCsv(run.recommendations, sels, { suggestions: run.suggest.suggestions, delimiter: '‡' }), [key])).toThrow(KeyEchoError);
  });

  it('Settings → Output: the delimiter is saved on its own; missing or invalid values read as $', async () => {
    fakes.storage.seed({ 'provider:openai': { apiKey: 'sk-x', model: 'gpt' }, lookupBackend: 'loc-api' });
    expect((await getSettings()).subfieldDelimiter).toBe('$');
    await setSubfieldDelimiter('‡');
    expect((await getSettings()).subfieldDelimiter).toBe('‡');
    const stored = fakes.storage.dump();
    expect(stored['provider:openai']).toEqual({ apiKey: 'sk-x', model: 'gpt' });
    expect(stored.lookupBackend).toBe('loc-api');
    expect(stored[DELIMITER_KEY]).toBe('‡');
    await expect(setSubfieldDelimiter('#')).rejects.toThrow();
    fakes.storage.seed({ [DELIMITER_KEY]: '#' });
    expect((await getSettings()).subfieldDelimiter).toBe('$');
  });
});

describe('[UI2 §6] AI confidence', () => {
  it('levels at the boundaries; null and invalid values have no level', () => {
    expect([0, 49, 50, 79, 80, 100].map(confidenceLevel)).toEqual(['Low', 'Low', 'Medium', 'Medium', 'High', 'High']);
    expect([null, undefined, -1, 101, 85.5, '85', NaN].map(confidenceLevel)).toEqual([null, null, null, null, null, null, null]);
    expect(confidenceTooltip(85)).toBe('The AI’s own estimate (0–100): 85');
  });

  it('the badge appears only for AI selections with a valid value, keyboard-focusable with its tooltip', () => {
    const html = renderHtml(ConfidenceBadge, { method: 'ai', confidence: 80 });
    expect(textOf(html)).toContain('AI confidence: High');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-confidence="80"');
    expect(html).toContain('The AI’s own estimate (0–100): 80');
    for (const props of [{ method: 'ai', confidence: null }, { method: 'manual', confidence: 90 }, { method: 'exact', confidence: 90 }]) {
      expect(renderHtml(ConfidenceBadge, props)).toBe('');
    }
  });

  it('each selection keeps its own confidence (never aggregated); numbers stay in history and CSV', () => {
    const run = builtRun();
    const text = textOf(renderHtml(RecommendationsPanel, { recommendations: run.recommendations, selections: selectionsOf(run), suggestions: run.suggest.suggestions }));
    expect(text).toContain('AI choice AI confidence: High');
    expect(text).toContain('Additional AI pick AI confidence: Low');
    expect(text).not.toContain('AI confidence: Medium');
    const entry = buildHistoryEntry({ run, id: 'e5', timestamp: 't' });
    expect(entry.recommendations.flatMap((r) => r.selections.map((s) => s.confidence))).toContain(85);
    const rows = csvRows(run.recommendations, selectionsOf(run), { suggestions: run.suggest.suggestions });
    expect(rows.slice(1).map((r) => r[rows[0].indexOf('confidence')])).toContain('[85]');
  });
});

describe('[UI2 §7] provider list marks', () => {
  const entry = (id) => PROVIDERS.find((p) => p.id === id);

  it('Configured needs the SAVED key or a saved valid endpoint; drafts never reach the check', () => {
    expect(isProviderConfigured(entry('openai'), {})).toBe(false);
    expect(isProviderConfigured(entry('openai'), { apiKey: '  ' })).toBe(false);
    expect(isProviderConfigured(entry('openai'), { apiKey: 'sk-1' })).toBe(true);
    expect(isProviderConfigured(entry('lmstudio'), {})).toBe(false);
    expect(isProviderConfigured(entry('lmstudio'), { baseURL: 'not a url' })).toBe(false);
    expect(isProviderConfigured(entry('lmstudio'), { baseURL: 'http://localhost:1234/v1' })).toBe(true);
    expect(isProviderConfigured(entry('custom'), { apiKey: 'k' })).toBe(false);
    const mark = renderHtml(ProviderMark, { entry: entry('openai'), stored: { apiKey: 'sk-1' } });
    expect(mark).toContain('aria-label="Configured"');
    expect(mark).toContain('role="img"');
    expect(renderHtml(ProviderMark, { entry: entry('openai'), stored: {} })).toBe('');
  });

  it('Nano shows Available only for "available"', () => {
    expect(['available', 'downloadable', 'downloading', 'unavailable', 'unknown', undefined, null].map(isNanoAvailable))
      .toEqual([true, false, false, false, false, false, false]);
    expect(textOf(renderHtml(ProviderMark, { entry: entry('gemini-nano'), nanoAvailability: 'available' }))).toContain('Available');
    expect(renderHtml(ProviderMark, { entry: entry('gemini-nano'), nanoAvailability: 'downloadable' })).toBe('');
  });
});

describe('[UI2 §8, §10] form disclosure and popup line', () => {
  it('More details: initial state from the fields; own typing keeps it; Start new search closes; a replacement with text opens', () => {
    expect(hasMoreDetails({ tableOfContents: '', notes: '' })).toBe(false);
    expect(hasMoreDetails({ tableOfContents: '', notes: 'x' })).toBe(true);
    expect(nextMoreDetailsOpen(true, { tableOfContents: '', notes: '' }, true)).toBe(true);
    expect(nextMoreDetailsOpen(false, { tableOfContents: 'x', notes: '' }, true)).toBe(false);
    expect(nextMoreDetailsOpen(true, EMPTY_BIBLIOGRAPHIC_INFO, false)).toBe(false);
    expect(nextMoreDetailsOpen(false, { ...EMPTY_BIBLIOGRAPHIC_INFO, notes: 'n' }, false)).toBe(true);
    expect(nextMoreDetailsOpen(true, { ...EMPTY_BIBLIOGRAPHIC_INFO, title: 'T' }, false)).toBe(true);
  });

  it('popup: absent, invalid and unreadable records, and a recorded database', () => {
    expect(offlineDatabaseLine(null)).toBe('Offline database: status unavailable');
    expect(offlineDatabaseLine({ localDb: null, localDbInvalid: true })).toBe('Offline database: saved record needs attention');
    expect(offlineDatabaseLine({ localDb: null, localDbInvalid: false })).toBe('Offline database: not installed');
    expect(offlineDatabaseLine({ localDb: { profile: 'full', release: '2026.10.01.1' } })).toBe('Offline database recorded: full (release 2026.10.01.1)');
    const text = textOf(renderHtml(PopupView, { state: null, onOpen: () => {}, onSettings: () => {}, dbLine: 'Offline database: not installed' }));
    expect(text).toContain('Offline database: not installed');
    expect(text).not.toMatch(/healthy|complete|in use/i);
  });
});

describe('[UI2 §0] integration with round 1', () => {
  it('Settings keeps its round-1 sections and adds Output', () => {
    const text = textOf(renderToString(React.createElement(AppProvider, null, React.createElement(SettingsPage, { onClose: () => {} }))));
    const order = ['AI provider', 'Lookup source and offline database', 'Output', 'Selection rules (advanced)'].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Subfield delimiter');
    expect(text).toContain('$ (default)');
  });

  it('History navigation and step changes end a Next continuation (the view epoch changes)', () => {
    let ctx = null;
    const Capture = () => { ctx = useAppContext(); return null; };
    renderToString(React.createElement(AppProvider, null, React.createElement(Capture)));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const start = ctx.viewEpoch();
    ctx.openHistory();
    const afterOpen = ctx.viewEpoch();
    ctx.closeHistory();
    errors.mockRestore();
    expect(afterOpen).toBeGreaterThan(start);
    expect(ctx.viewEpoch()).toBeGreaterThan(afterOpen);
  });

  it('the Matches summary and plain labels follow the current run after an edit', () => {
    const run = builtRun();
    const before = matchesSummary(run.suggest.suggestions, run.lookup.results, run.lookup.pending);
    const edited = editSuggestions(run, [...run.suggest.suggestions, { id: 's7', heading: 'Cinema', kind: 'topical', reason: '', source: 'user' }]);
    const after = matchesSummary(edited.suggest.suggestions, edited.lookup.results, edited.lookup.pending);
    expect(after).not.toEqual(before);
    expect(hasDownstreamResults(edited)).toBe(false);
    expect(hasDownstreamResults(run)).toBe(true);
    const html = renderHtml(MatchesPanel, { suggestions: run.suggest.suggestions, results: run.lookup.results, selections: selectionsOf(run), mode: run.select.mode, readOnly: true });
    expect(textOf(html)).toContain(matchClassLabel(C.mpjh.matchClass));
    expect(html).toContain('id="match-card-s1"');
  });

  it('the Suggestions view: heading, note, downstream warning, editing only when live', () => {
    const run = mixedRun();
    const live = textOf(renderHtml(SuggestionsPanel, { suggest: run.suggest, editable: true, onEdit: () => {}, hasDownstream: true }));
    expect(live).toContain(SUGGESTION_NOTE);
    expect(live).toContain(DOWNSTREAM_WARNING);
    expect(live).toContain('AI analysis of the work');
    expect(live).toContain('Edit');
    expect(live).toContain('Remove');
    const readOnly = textOf(renderHtml(SuggestionsPanel, { suggest: run.suggest }));
    expect(readOnly).not.toContain(DOWNSTREAM_WARNING);
    expect(readOnly).not.toMatch(/\bEdit\b|\bRemove\b|Add a heading/);
    const empty = textOf(renderHtml(SuggestionsPanel, { suggest: { ...run.suggest, suggestions: [] }, editable: true, onEdit: () => {} }));
    expect(empty).toContain('No suggestions. Add a heading to look it up.');
  });

  it('Recommendations: "Back to Matches" and "Edit search heading" for each heading without an LC heading, live only, with the real none reason', () => {
    const run = builtRun();
    const props = { recommendations: run.recommendations, selections: selectionsOf(run), suggestions: run.suggest.suggestions };
    const live = textOf(renderHtml(RecommendationsPanel, { ...props, onBackToMatches: () => {}, onEditHeading: () => {} }));
    const withoutHeading = selectionsOf(run).filter((s) => !s.cid).length;
    expect((live.match(/Back to Matches/g) || []).length).toBe(withoutHeading);
    expect((live.match(/Edit search heading/g) || []).length).toBe(withoutHeading);
    expect(textOf(renderHtml(RecommendationsPanel, props))).not.toMatch(/Back to Matches|Edit search heading/);
  });
});
