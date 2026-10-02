/**
 * ui-2b: the six review findings of round 2 (each as an invariant) and the
 * lead's item 7. There is no DOM in these tests, so a click is the REAL
 * handler of a rendered button: the MUI Button is wrapped to record its
 * onClick by label, and the test calls it after the server render.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

const recorded = vi.hoisted(() => new Map());
vi.mock('@mui/material', async (importOriginal) => {
  const mui = await importOriginal();
  const ReactLib = await import('react');
  const textOfChildren = (children) => ReactLib.Children.toArray(children)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : textOfChildren(c?.props?.children)))
    .join('');
  const Button = ReactLib.forwardRef((props, ref) => {
    const label = textOfChildren(props.children).trim();
    if (props.onClick) recorded.set(label, [...(recorded.get(label) || []), props.onClick]);
    return ReactLib.createElement(mui.Button, { ...props, ref });
  });
  return { ...mui, Button };
});

/* eslint-disable import/first */
import AppShell, { installHashRoute } from '../AppShell';
import ScrapedResults, { MatchesPanel } from '../ScrapedResults';
import FinalRecommendations, { RecommendationsPanel } from '../FinalRecommendations';
import { SuggestionsPanel, editorHeadingValue, HIDDEN_HEADING_NOTE } from '../InitialSuggestions';
import { V2EntryView } from '../ConversationHistory';
import AppContext, { AppProvider, useAppContext } from '../../context/AppContext';
import { createWorkflow } from '../../services/pipeline/workflow';
import { createRunCache } from '../../services/lookup/scheduler';
import { ProviderError } from '../../services/providers/errors';
import { FALLBACK_BANNER } from '../../services/pipeline/select';
import { makeSuggestion } from '../../services/pipeline/types';
import { applySuggestionEdit, EDIT_ERRORS } from '../../services/pipeline/suggestionEdits';
import { formatMarcField, NOT_REFORMATTED_NOTE } from '../../services/pipeline/marcFormat';
import { copyAllText, csvRows } from '../../services/pipeline/exports';
import {
  initialRunState, beginSuggest, commitSuggest, beginLookup, commitLookup, beginSelect, commitSelect, buildRun, selectionsOf
} from '../../services/pipeline/run';
import { buildHistoryEntry, rebuildEntry } from '../../services/history';
import { setStoredKeys, resetKeyRegistry, HIDDEN_TEXT } from '../../services/keyGuard';
import { renderHtml, textOf } from '../../../test/render';
import { KEY } from '../../../test/fixtures';
/* eslint-enable import/first */

beforeEach(() => {
  recorded.clear();
  resetKeyRegistry();
});

const click = (label) => {
  const handlers = recorded.get(label) || [];
  expect(handlers.length, `a rendered "${label}" button`).toBeGreaterThan(0);
  handlers[handlers.length - 1]();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => { setTimeout(r, 0); }); };

// ——— a small real workflow: a fake AI and a fake local backend ———
const CFG = { providerId: 'deepseek', model: 'deepseek-flash', apiKey: KEY, entry: { adapter: 'openai-style' } };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const SUGGESTED = answer({ subjectAnalysis: 'Cats.', suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'Topic.' }] });
const CATS = {
  cid: 'lcsh:sh85021262', authority: 'lcsh', localId: 'sh85021262', uri: 'http://id.loc.gov/authorities/subjects/sh85021262',
  label: 'Cats', marcKey: '150  $aCats', rdfTypes: [], matchClass: 'exact-full', source: 'local-db', via: 'label'
};
const PROVENANCE = { backend: 'local-db', profile: 'core', release: '2026.10.01.1', releaseCommit: 'a'.repeat(40), file: '/db.db' };
const isSelectRequest = (req) => JSON.stringify(req?.schema || {}).includes('selections');
const workflowDeps = (selectImpl) => {
  let n = 0;
  const nameKeyCalls = [];
  return {
    nameKeyCalls,
    deps: {
      loadConfig: async () => ({ cfg: CFG, settings: { lookupBackend: 'local-db' } }),
      generateImpl: async (cfg, req) => (isSelectRequest(req) ? selectImpl(req) : SUGGESTED),
      createBackend: () => ({
        id: 'local-db',
        cache: createRunCache(),
        lookup: async (s) => ({
          suggestionId: s.id, candidates: [CATS], failures: [], incomplete: false, rejectedHits: 0, requests: [], provenance: PROVENANCE, replacementNotes: []
        })
      }),
      uuid: () => `run-${++n}`,
      resolveNameKeysImpl: async (args) => { nameKeyCalls.push(args); return new Map(); }
    }
  };
};
const SELECTION = answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] });

describe('[ui-2b item 2] a navigation away from Matches ends Next AT ONCE (real AppShell / Matches wiring)', () => {
  /**
   * Render the real provider with the real AppShell (Settings, History) and
   * the real Matches view; bring the run to "looked up, on Matches".
   */
  const onMatches = async () => {
    const gate = deferred();
    const { deps, nameKeyCalls } = workflowDeps(() => gate.promise);
    let ctx = null;
    const Capture = () => { ctx = useAppContext(); return null; };
    const onNavigate = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderToString(React.createElement(AppProvider, { workflowDeps: deps },
      React.createElement(Capture),
      React.createElement(AppShell, { hash: '', onNavigate }),
      React.createElement(ScrapedResults)));
    const wf = ctx.workflow;
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    ctx.setActiveStep(1);
    await wf.lookupAll();
    ctx.setActiveStep(2);
    const leave = vi.spyOn(wf, 'leave');
    return { ctx, wf, gate, onNavigate, leave, nameKeyCalls };
  };
  // Leaving step 2 for step 3 calls leave('lookup') and leave('select'): the step changed.
  const stepChanged = (leave) => leave.mock.calls.some(([op]) => op === 'select');

  it('control: with no navigation, Next builds and changes the step', async () => {
    const { wf, gate, leave } = await onMatches();
    click('Next: recommendations');
    await settle();
    gate.resolve(SELECTION);
    await settle();
    expect(wf.getState().run.stage).toBe('built');
    expect(stepChanged(leave)).toBe(true);
  });

  it('Settings clicked while the selection is pending: no build, no name keys, the step is unchanged', async () => {
    const { wf, gate, onNavigate, leave, nameKeyCalls } = await onMatches();
    click('Next: recommendations');
    await settle();
    expect(wf.getState().select.pending).toBe(true);
    click('Settings'); // the AppShell header button
    expect(onNavigate).toHaveBeenCalledWith('settings');
    // The selection finishes BEFORE any hashchange or effect could run
    gate.resolve(SELECTION);
    await settle();
    expect(wf.getState().run.stage).not.toBe('built');
    expect(wf.getState().recommendations).toBeNull();
    expect(nameKeyCalls).toHaveLength(0);
    expect(stepChanged(leave)).toBe(false);
  });

  it('a browser-driven hashchange (#settings typed, Back/Forward) while the selection is pending: no build', async () => {
    const { ctx, wf, gate, leave, nameKeyCalls } = await onMatches();
    const win = Object.assign(new EventTarget(), { location: { hash: '' } });
    const onHash = vi.fn();
    const stop = installHashRoute(win, { onHash, noteNavigation: ctx.noteNavigation });
    click('Next: recommendations');
    await settle();
    win.location.hash = '#settings';
    win.dispatchEvent(new Event('hashchange'));
    expect(onHash).toHaveBeenCalledWith('#settings');
    gate.resolve(SELECTION);
    await settle();
    stop();
    expect(wf.getState().run.stage).not.toBe('built');
    expect(nameKeyCalls).toHaveLength(0);
    expect(stepChanged(leave)).toBe(false);
  });

  it('the Settings action under a selection error also ends Next at once', async () => {
    const { ctx, wf, gate, leave } = await onMatches();
    // The error alert's Settings button is rendered only with an error; its handler is the page's.
    vi.stubGlobal('window', { location: { hash: '' } });
    const before = ctx.viewEpoch();
    click('Next: recommendations');
    await settle();
    // Re-render the Matches view with a stored error to obtain its alert buttons
    recorded.clear();
    renderToString(React.createElement(AppContext.Provider, {
      value: { ...ctx, run: { ...wf.getState(), select: { ...wf.getState().select, error: { kind: 'permission', message: 'No access.' } } } }
    }, React.createElement(ScrapedResults)));
    recorded.get('Settings').at(-1)();
    expect(ctx.viewEpoch()).toBeGreaterThan(before + 0);
    gate.resolve(SELECTION);
    await settle();
    vi.unstubAllGlobals();
    expect(wf.getState().run.stage).not.toBe('built');
    expect(stepChanged(leave)).toBe(false);
  });

  it('regression check (already synchronous before): History and Back also end Next', async () => {
    for (const action of ['History', 'Back']) {
      recorded.clear();
      const { wf, gate } = await onMatches();
      click('Next: recommendations');
      await settle();
      click(action);
      gate.resolve(SELECTION);
      await settle();
      expect([action, wf.getState().run.stage]).not.toEqual([action, 'built']);
    }
  });
});

describe('[ui-2b item 3] the automatic exact-only fallback is disclosed where the user arrives', () => {
  const advancedThroughFallback = async (kind) => {
    const { deps } = workflowDeps(async () => { throw new ProviderError(kind, { provider: 'DeepSeek' }); });
    const wf = createWorkflow(deps);
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    await wf.lookupAll();
    expect(await wf.next()).toEqual({ advanced: true });
    return wf;
  };
  const recommendationsPage = (wf) => textOf(renderToString(React.createElement(AppContext.Provider, {
    value: {
      run: wf.getState(), workflow: wf, setActiveStep: () => {}, saveRunToHistory: async () => [], openHistory: () => {}, requestFocus: () => {}
    }
  }, React.createElement(FinalRecommendations))));

  it('Recommendations shows the fallback notice for invalid_output, truncated and too_long', async () => {
    for (const kind of ['invalid_output', 'truncated', 'too_long']) {
      const wf = await advancedThroughFallback(kind);
      const text = recommendationsPage(wf);
      expect([kind, text.includes(FALLBACK_BANNER)]).toEqual([kind, true]);
      expect(text).toContain('Exact match');
    }
  });

  it('the saved entry keeps the fallback, and the read-only history view shows the notice', async () => {
    const wf = await advancedThroughFallback('invalid_output');
    const entry = rebuildEntry(JSON.parse(JSON.stringify(buildHistoryEntry({ run: wf.getState(), id: 'e1', timestamp: 't' }))));
    expect(entry.selectMode).toBe('exact-fallback');
    expect(textOf(renderHtml(V2EntryView, { entry }))).toContain(FALLBACK_BANNER);
  });

  it('an AI selection shows no fallback notice', async () => {
    const { deps } = workflowDeps(async () => SELECTION);
    const wf = createWorkflow(deps);
    await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
    await wf.lookupAll();
    await wf.next();
    expect(recommendationsPage(wf)).not.toContain(FALLBACK_BANNER);
  });
});

/** A run whose one suggestion (by `source`) has a single exact match chosen by the AI with confidence 85. */
const collapsedRun = (source) => {
  const suggestions = [makeSuggestion({ id: 's1', heading: 'Cats', kind: 'topical', reason: '', source })];
  let { state, token } = beginSuggest(initialRunState(), { runId: 'r', snapshot: null, input: { title: 'Cats' } });
  state = commitSuggest(state, token, { subjectAnalysis: '', suggestions, suggestMode: 'json', provenance: {} });
  const begun = beginLookup(state, ['s1']);
  state = commitLookup(begun.state, begun.tokens.s1, {
    suggestionId: 's1', outcome: 'found', candidates: [CATS], errorKind: null, searchedAt: 't', provenance: PROVENANCE, replacementNotes: []
  });
  const sel = beginSelect(state, null);
  return buildRun(commitSelect(sel.state, sel.token, { mode: 'ai', choices: { s1: { cid: CATS.cid, confidence: 85 } }, additional: [] }));
};

describe('[ui-2b item 4] a collapsed Matches card keeps authorship, method and AI confidence', () => {
  const live = (run) => textOf(renderHtml(MatchesPanel, {
    suggestions: run.suggest.suggestions, results: run.lookup.results, selections: selectionsOf(run), mode: run.select.mode,
    onChoose: () => {}, onRetry: () => {}
  }));

  for (const [source, label] of [['user', 'Your heading'], ['ai', 'AI suggestion']]) {
    it(`${label}: live and in the history panel`, () => {
      const run = collapsedRun(source);
      const entry = rebuildEntry(JSON.parse(JSON.stringify(buildHistoryEntry({ run, id: 'e', timestamp: 't' }))));
      for (const text of [live(run), textOf(renderHtml(V2EntryView, { entry }))]) {
        expect(text).toContain('Show details'); // collapsed
        expect(text).not.toContain('Current choice:');
        expect(text).toContain(`Cats (${label} · topical) → Cats`);
        expect(text).toContain('AI choice · confidence High');
      }
    });
  }
});

describe('[ui-2b item 5] MARC formatting never rebuilds a malformed or filtered field', () => {
  const STORED = '650 _0 $a Cats $x History';
  const storedEntry = (marc) => {
    const entry = JSON.parse(JSON.stringify(buildHistoryEntry({ run: collapsedRun('ai'), id: 'e5', timestamp: 't' })));
    entry.recommendations[0].marc = marc;
    return rebuildEntry(entry);
  };

  it('the reviewer\'s scenario: a filtered subfield → the saved text unchanged, with $, marked as not reformatted', () => {
    const entry = storedEntry({
      status: 'from-authority', tag: '650', ind1: '_', ind2: '0', subfields: [['a', 'Cats'], ['x', null]], text: STORED, reason: null
    });
    const rec = entry.recommendations[0];
    for (const d of ['$', '‡']) expect(formatMarcField(rec.marc, d)).toBe(STORED);
    expect(copyAllText(entry.recommendations, entry.selections, { delimiter: '‡' })).toContain(STORED);
    const rows = csvRows(entry.recommendations, entry.selections, { suggestions: entry.suggestions, delimiter: '‡' });
    expect(rows[1][rows[0].indexOf('marc_field')]).toBe(STORED);
    const text = textOf(renderHtml(RecommendationsPanel, {
      recommendations: entry.recommendations, selections: entry.selections, suggestions: entry.suggestions, delimiter: '‡'
    }));
    expect(text).toContain(STORED);
    expect(text).not.toContain('‡');
    expect(text).toContain(NOT_REFORMATTED_NOTE);
  });

  it('every part must have the builder\'s shape; otherwise the stored text is used', () => {
    const good = { status: 'from-authority', tag: '650', ind1: '_', ind2: '0', subfields: [['a', 'Cats'], ['x', 'History']], text: STORED };
    expect(formatMarcField(good, '‡')).toBe('650 _0 ‡a Cats ‡x History');
    const bad = [
      { tag: '65' }, { tag: 'abc' }, { ind1: 'ab' }, { ind2: '' }, { ind1: '!' },
      { subfields: [['A', 'Cats']] }, { subfields: [['aa', 'Cats']] }, { subfields: [['a', '']] }, { subfields: [] },
      { subfields: [['a', 'Cats', 'x']] }, { structureMalformed: true }
    ];
    for (const change of bad) {
      expect([change, formatMarcField({ ...good, ...change }, '‡')]).toEqual([change, STORED]);
    }
    // A clean saved field still formats after a reload
    expect(formatMarcField(storedEntry(good).recommendations[0].marc, '‡')).toBe('650 _0 ‡a Cats ‡x History');
  });
});

describe('[ui-2b item 6] an unsupported explicit source is unknown authorship, shown neutrally', () => {
  it('makeSuggestion keeps it unknown; the list says "Suggestion"; CSV gives null', () => {
    expect(makeSuggestion({ id: 's1', heading: 'Cats' }).source).toBe('ai');
    const robot = makeSuggestion({ id: 's1', heading: 'Cats', kind: 'topical', source: 'robot' });
    expect(robot.source).toBe('unknown');
    const text = textOf(renderHtml(SuggestionsPanel, { suggest: { subjectAnalysis: '', suggestions: [robot], suggestMode: 'json' } }));
    expect(text).toContain('Suggestion · topical');
    expect(text).not.toMatch(/AI suggestion|Your heading/);
    const run = collapsedRun('robot');
    const rows = csvRows(run.recommendations, selectionsOf(run), { suggestions: run.suggest.suggestions });
    expect(rows[1][rows[0].indexOf('suggestion_sources')]).toBe('[null]');
  });
});

describe('[ui-2b item 1] the suggestion editor is a display exit', () => {
  const SECRET = 'sk-live-ABCDEFGH1234';
  const suggest = (heading) => ({ subjectAnalysis: '', suggestMode: 'json', suggestions: [{ id: 's1', heading, kind: 'topical', reason: '', source: 'ai' }] });
  const editor = (heading, onEdit = () => ({ ok: true })) => renderToString(React.createElement(SuggestionsPanel, {
    suggest: suggest(heading), editable: true, onEdit, editingId: 's1'
  }));

  it('an editor opened on a hidden heading starts EMPTY, with the note; the text appears nowhere', () => {
    setStoredKeys([SECRET]);
    const html = editor(SECRET);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(`value="${HIDDEN_TEXT}"`);
    expect(html).toMatch(/aria-label="Search heading"[^>]*value=""|value=""[^>]*aria-label="Search heading"/);
    expect(textOf(html)).toContain(HIDDEN_HEADING_NOTE);
  });

  it('Apply then requires new text; the replacement text never becomes the heading', () => {
    setStoredKeys([SECRET]);
    const s = suggest(SECRET);
    const sent = [];
    editor(SECRET, (edit) => { sent.push(edit); return applySuggestionEdit(s, edit); });
    click('Apply');
    expect(sent).toHaveLength(1);
    expect(sent[0].heading).toBe('');
    expect(sent[0].heading).not.toBe(HIDDEN_TEXT);
    expect(applySuggestionEdit(s, sent[0])).toEqual({ ok: false, error: EDIT_ERRORS.empty });
  });

  it('an ordinary heading opens with its text and no note', () => {
    setStoredKeys(['an-unrelated-key-123']);
    const html = editor('Cats');
    expect(html).toMatch(/value="Cats"/);
    expect(textOf(html)).not.toContain(HIDDEN_HEADING_NOTE);
  });

  it('a heading that becomes hidden while the editor is open disappears from the input', () => {
    // The open editor's untouched draft (null) follows the registry on every render
    expect(editorHeadingValue(null, SECRET, false)).toBe(SECRET);
    expect(editorHeadingValue(null, SECRET, true)).toBe('');
    // Text the user typed again equal to the hidden heading is not shown either
    expect(editorHeadingValue(SECRET, SECRET, true)).toBe('');
    // The user's own new text stays
    expect(editorHeadingValue('Kittens', SECRET, true)).toBe('Kittens');
    // And the rendered editor follows a registry change between renders
    expect(editor(SECRET)).toMatch(/value="sk-live-ABCDEFGH1234"/);
    setStoredKeys([SECRET]);
    expect(editor(SECRET)).not.toContain(SECRET);
  });
});

describe('[ui-2b item 7] the confidence does not repeat "AI"', () => {
  it('"AI choice · confidence High" and "Additional AI pick · confidence Low"; the number is in the tooltip', () => {
    const run = collapsedRun('ai');
    const recs = [{ ...run.recommendations[0], selections: [...run.recommendations[0].selections, { suggestionId: null, method: 'ai', confidence: 45, lexicalSimilarity: null }] }];
    const html = renderHtml(RecommendationsPanel, { recommendations: recs, selections: selectionsOf(run), suggestions: run.suggest.suggestions });
    const text = textOf(html);
    expect(text).toContain('AI choice · confidence High');
    expect(text).toContain('Additional AI pick · confidence Low');
    expect(text).not.toContain('AI confidence');
    expect(html).toContain('The AI’s own estimate (0–100): 85');
  });
});
