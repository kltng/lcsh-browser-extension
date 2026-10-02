/**
 * UI round 1 (owner-approved items 1–5 and 16): presentation and navigation
 * only. Every behaviour, honesty rule and key guard is unchanged.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MatchesPanel, startsCollapsed, cardExpanded } from '../ScrapedResults';
import { LocalDbSettings, INSTALL_FIRST_TEXT } from '../LocalDbSettings';
import { V2EntryView } from '../ConversationHistory';
import SettingsPage from '../SettingsPage';
import AppShell, { STEPS } from '../AppShell';
import { AppProvider, useAppContext, STEP_OPERATIONS } from '../../context/AppContext';
import { matchClassLabel, MATCH_CLASS_LABELS, similarityText, matchesSummary } from '../pipelineText';
import { buildHistoryEntry } from '../../services/history';
import { resetKeyRegistry } from '../../services/keyGuard';
import { renderHtml, textOf } from '../../../test/render';
import { builtRun, cand, result } from '../../../test/pipelineFixtures';

// Rendering AppProvider marks the key registry as waiting (P6 fix 16), and no
// watcher runs in a server render, so every test starts from a ready registry.
beforeEach(() => resetKeyRegistry());

const noop = () => {};
const exact = cand('lcsh', 'sh85021262', 'Cats', 'exact-full', '150  $aCats');
const longer = cand('lcsh', 'sh85021263', 'Cats--Behavior', 'prefix-full', '150  $aCats$xBehavior');
const selection = (suggestionId, cid, lexicalSimilarity = 100) => ({
  suggestionId, cid, method: cid ? 'ai' : 'none', noneReason: cid ? null : 'not-chosen', confidence: cid ? 90 : null,
  lexicalSimilarity: cid ? lexicalSimilarity : null, mainHeadingOnly: false, droppedSubdivisions: []
});
const panel = (props) => textOf(renderHtml(MatchesPanel, { mode: 'ai', onChoose: noop, onRetry: noop, ...props }));
const dbProps = (over = {}) => ({
  lookupBackend: 'loc-api', installed: null, state: null, pointer: null, operation: null,
  onBackendChange: noop, onInstall: noop, onRepair: noop, onUninstall: noop, onCancel: noop, onRetryOwnership: noop,
  onCheckUpdate: noop, ...over
});
const CORE = { profile: 'core', release: '2026.09.27.1', dbSize: 205_000_000, installedAt: '2026-09-27T00:00:00.000Z' };

describe('[UI1 item 1] plain words for match classes', () => {
  it('ONE label function: every class in plain words; unknown → "Other match"', () => {
    expect(MATCH_CLASS_LABELS).toEqual({
      'exact-full': 'Exact match',
      exact: 'Exact match',
      'exact-main': 'Main heading matches',
      'prefix-full': 'Longer heading',
      'prefix-main': 'Starts with the main heading',
      keyword: 'Keyword match',
      variant: 'Matched a variant name',
      replacement: 'Replaces an old heading'
    });
    expect(matchClassLabel('exact-full')).toBe('Exact match');
    expect(matchClassLabel('made-up')).toBe('Other match');
    expect(matchClassLabel('toString')).toBe('Other match');
    expect(matchClassLabel(undefined)).toBe('Other match');
  });

  it('Matches and the history view show the plain words, never the codes', () => {
    const suggestions = [{ id: 's1', heading: 'Cats', kind: 'topical', reason: '' }];
    const results = { s1: result('s1', 'found', [exact, longer]) };
    const text = panel({ suggestions, results, selections: [selection('s1', exact.cid)] });
    expect(text).toContain('Exact match');
    expect(text).toContain('Longer heading');
    expect(text).not.toMatch(/exact-full|prefix-full/);

    const history = textOf(renderHtml(V2EntryView, { entry: buildHistoryEntry({ run: builtRun(), id: 'h', timestamp: 't' }) }));
    expect(history).toContain('Exact match');
    expect(history).not.toMatch(/\b(exact-full|exact-main|prefix-full|prefix-main)\b/);
  });

  it('"N% similar spelling" only when N < 100', () => {
    expect(similarityText(100)).toBeNull();
    expect(similarityText(85)).toBe('85% similar spelling');
    expect(similarityText(null)).toBeNull();
    const suggestions = [{ id: 's1', heading: 'Cat', kind: 'topical', reason: '' }, { id: 's2', heading: 'Cats', kind: 'topical', reason: '' }];
    const results = { s1: result('s1', 'found', [exact, longer]), s2: result('s2', 'found', [exact, longer]) };
    const text = panel({ suggestions, results, selections: [selection('s1', exact.cid, 75), selection('s2', exact.cid, 100)] });
    expect(text).toContain('75% similar spelling');
    expect(text).not.toContain('100% similar spelling');
  });
});

describe('[UI1 item 2] the Settings structure and the database section', () => {
  it('the INSTALLED profile shows "Installed ✓" and no button; the other one offers "Switch to …"', () => {
    const core = textOf(renderHtml(LocalDbSettings, dbProps({ installed: CORE })));
    expect(core).toContain('Installed ✓');
    expect(core).toContain('Switch to full');
    expect(core).not.toContain('Switch to core');
    expect(core).not.toMatch(/\bDownload\b/);
    const full = textOf(renderHtml(LocalDbSettings, dbProps({ installed: { ...CORE, profile: 'full' } })));
    expect(full).toContain('Switch to core');
    expect(full).not.toContain('Switch to full');
    expect(full).toContain('Installed ✓');
    // Repair and Uninstall stay with the installed line, and so does the release check.
    expect(full).toMatch(/Installed: full.*Repair.*Uninstall.*Check for a new release/);
  });

  it('never "(download —, disk —)": exact sizes with a pointer, nothing without one', () => {
    const without = textOf(renderHtml(LocalDbSettings, dbProps()));
    expect(without).not.toContain('(download');
    expect(without).not.toMatch(/disk —/);
    expect(without).toContain('Large download (about 1.9 GB) and about 5.4 GB of disk space.');
    const pointer = { release: 'r', profiles: { core: { gzSize: 62_000_000, dbSize: 205_000_000 }, full: { gzSize: 1_870_000_000, dbSize: 5_400_000_000 } } };
    const withPointer = textOf(renderHtml(LocalDbSettings, dbProps({ pointer })));
    expect(withPointer).toContain('Core — subjects and genres (download 62 MB, disk 205 MB)');
  });

  it('the "Local database" radio is disabled while nothing is installed, with the helper text', () => {
    const html = renderHtml(LocalDbSettings, dbProps());
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="local-db"|<input[^>]*value="local-db"[^>]*disabled=""/);
    expect(textOf(html)).toContain(INSTALL_FIRST_TEXT);
    const installed = renderHtml(LocalDbSettings, dbProps({ installed: CORE }));
    expect(installed).not.toMatch(/<input[^>]*disabled=""[^>]*value="local-db"|<input[^>]*value="local-db"[^>]*disabled=""/);
    expect(textOf(installed)).not.toContain(INSTALL_FIRST_TEXT);
  });

  it('Settings has the title and the three headed sections, with the rules editor (item 4)', () => {
    const text = textOf(renderToString(React.createElement(AppProvider, null, React.createElement(SettingsPage, { onClose: noop }))));
    expect(text).toMatch(/^\s*Settings Back to the workflow/);
    expect(text).toContain('AI provider');
    expect(text).toContain('Lookup source and offline database');
    expect(text).toContain('Selection rules (advanced)');
    // UI round 1b: ONE title — the section heading; the editor itself is shown directly.
    expect(text.match(/selection rules \(advanced\)/gi)).toHaveLength(1);
    expect(text).not.toContain('LCSH Selection Rules (Advanced)');
    expect(text).toContain('Save Rules');
    expect(text).toContain('Reset to Default');
    expect(text).not.toContain('Settings: AI provider');
  });
});

describe('[UI1 items 3 and 4] History is a view; the workflow has 4 steps', () => {
  const shell = (props = {}, providerProps = {}) => renderToString(
    React.createElement(AppProvider, providerProps, React.createElement(AppShell, { hash: '', onNavigate: noop, ...props }))
  );

  it('the stepper has the 4 workflow steps, and the header has History and Settings buttons', () => {
    expect(STEPS).toEqual(['Describe the work', 'AI suggestions', 'Matches', 'Recommendations']);
    const html = shell();
    expect((html.match(/class="MuiStep-root/g) || []).length).toBe(4);
    const text = textOf(html);
    for (const step of STEPS) expect(text).toContain(step);
    expect(text).toMatch(/History\s+Settings/);
    // The selection rules editor is no longer under the workflow (item 4); since
    // round 1b it has no title of its own, so its controls are what is checked.
    expect(text).not.toContain('LCSH Selection Rules (Advanced)');
    expect(text).not.toContain('Save Rules');
    expect(text).not.toContain('Reset to Default');
    expect(Object.keys(STEP_OPERATIONS)).toEqual(['0', '1', '2', '3']);
  });

  it('the History view opens OVER the workflow, which stays mounted (state kept)', () => {
    const html = shell({}, { initialHistoryOpen: true });
    const text = textOf(html);
    expect(text).toContain('Back to the workflow');
    expect(text).toContain('No history yet.');
    // The workflow subtree is still rendered, only hidden.
    expect(html).toMatch(/data-testid="workflow"/);
    expect((html.match(/class="MuiStep-root/g) || []).length).toBe(4);
    expect(text).toContain('Describe the work');
  });

  it('opening and closing History leaves no workflow step', () => {
    let ctx;
    const Capture = () => {
      ctx = useAppContext();
      return null;
    };
    renderToString(React.createElement(AppProvider, null, React.createElement(Capture)));
    ctx.workflow.leave = vi.fn();
    ctx.openHistory();
    ctx.closeHistory();
    expect(ctx.workflow.leave).not.toHaveBeenCalled();
  });
});

describe('[UI1 item 5] the Matches summary and less repetition', () => {
  const suggestions = [
    { id: 's1', heading: 'Cats', kind: 'topical', reason: '' },
    { id: 's2', heading: 'Cats--Behavior', kind: 'topical', reason: '' },
    { id: 's3', heading: 'Zzz', kind: 'topical', reason: '' },
    { id: 's4', heading: 'Broken', kind: 'topical', reason: '' }
  ];
  const results = {
    s1: result('s1', 'found', [exact]),
    s2: result('s2', 'partial', [longer, exact]),
    s3: result('s3', 'no-results'),
    s4: result('s4', 'failed', [], 'network')
  };
  const selections = [selection('s1', exact.cid), selection('s2', longer.cid, 90), selection('s3', null), selection('s4', null)];

  it('one summary line counted from the lookup results, with failures', () => {
    expect(matchesSummary(suggestions, results)).toBe('4 suggestions: 2 matched, 1 with no match, 1 failed');
    expect(matchesSummary(suggestions.slice(0, 1), results)).toBe('1 suggestion: 1 matched, 0 with no match');
    expect(panel({ suggestions, results, selections })).toContain('4 suggestions: 2 matched, 1 with no match, 1 failed');
  });

  it('"Source: …" once when every result has the same source; per card when they differ', () => {
    const same = panel({ suggestions, results, selections });
    expect(same.match(/Source:/g)).toHaveLength(1);
    const mixed = {
      ...results,
      s2: { ...results.s2, provenance: { backend: 'local-db', release: '2026.09.27.1' } }
    };
    const text = panel({ suggestions, results: mixed, selections });
    // Per card: s2, s3 and s4 (s1 starts collapsed to one line, item 5).
    expect(text.match(/Source:/g)).toHaveLength(3);
    expect(text).toContain('Source: Local database (release 2026.09.27.1)');
    expect(text).toContain('Source: Library of Congress online');
  });

  it('an exact-only chosen card starts collapsed to one line; every other card starts expanded', () => {
    expect(startsCollapsed(results.s1, selections[0])).toBe(true);
    expect(startsCollapsed(results.s2, selections[1])).toBe(false);
    expect(startsCollapsed(results.s1, selection('s1', null))).toBe(false);
    const html = renderHtml(MatchesPanel, { suggestions, results, selections, mode: 'ai', onChoose: noop, onRetry: noop });
    const text = textOf(html);
    // s1: one line with the heading, the chosen LC label, "Exact match" and an expand control.
    // Heading, arrow, chosen label, then the class and the expand control, in one run.
    const line = text.indexOf('Cats → Cats ');
    expect(line).toBeGreaterThan(-1);
    expect(text.indexOf('Exact match Show details', line)).toBe(line + 'Cats → Cats '.length);
    expect((text.match(/Show details/g) || [])).toHaveLength(1);
    // The other cards are expanded: their "Current choice" lines are shown (s2 only has candidates).
    expect(text.match(/Current choice:/g)).toHaveLength(1);
    expect(text).toContain('Cats--Behavior (AI suggestion · topical)');
  });
});

describe('[UI1 item 16] a user cancel is a neutral notice', () => {
  it('"Cancelled." is info without "Try again"; a real failure stays red with "Try again"', () => {
    const cancelled = renderHtml(LocalDbSettings, dbProps({ errorMessage: 'Cancelled.', errorKind: 'cancelled' }));
    expect(textOf(cancelled)).toContain('Cancelled.');
    expect(textOf(cancelled)).not.toContain('Try again');
    expect(cancelled).toContain('MuiAlert-standardInfo');
    expect(cancelled).not.toContain('MuiAlert-standardError');
    const failed = renderHtml(LocalDbSettings, dbProps({ errorMessage: 'The download was damaged; nothing was changed.', errorKind: 'damaged' }));
    expect(textOf(failed)).toContain('Try again');
    expect(failed).toContain('MuiAlert-standardError');
  });
});

// UI round 1b (live findings).
describe('[UI1b item 1] an exact card collapses when the AI choice makes the rule true', () => {
  const suggestions = [{ id: 's1', heading: 'Cats', kind: 'topical', reason: '' }];
  const results = { s1: result('s1', 'found', [exact]) };
  const render = (sel) => textOf(renderHtml(MatchesPanel, {
    suggestions, results, selections: [sel], mode: 'ai', onChoose: noop, onRetry: noop, runId: 'run-1'
  }));

  it('before "Choose headings" the card is expanded; after the AI choice commits it is collapsed', () => {
    const before = render(selection('s1', null));
    expect(before).toContain('Current choice:');
    expect(before).not.toContain('Show details');
    const after = render(selection('s1', exact.cid));
    expect(after).toContain('Show details');
    expect(after).not.toContain('Current choice:');
  });

  it('the user\'s own choice wins for that card; without one the rule decides', () => {
    // No choice by hand: collapsed exactly while the rule holds.
    expect(cardExpanded(null, false)).toBe(true);
    expect(cardExpanded(null, true)).toBe(false);
    // The user expanded it: it stays expanded when the rule becomes (or stays) true.
    expect(cardExpanded(true, true)).toBe(true);
    // The user collapsed it by hand: it stays collapsed.
    expect(cardExpanded(false, true)).toBe(false);
    // A card the rule does not allow to collapse is always shown in full.
    expect(cardExpanded(false, false)).toBe(true);
  });

  it('an expanded collapsible card offers "Hide details"; a non-collapsible card does not', () => {
    const two = { s1: result('s1', 'found', [exact, longer]) };
    const text = textOf(renderHtml(MatchesPanel, {
      suggestions, results: two, selections: [selection('s1', exact.cid)], mode: 'ai', onChoose: noop, onRetry: noop
    }));
    expect(text).not.toContain('Hide details');
    expect(text).not.toContain('Show details');
  });
});

describe('[UI1b item 2] the database offers read as separate lines', () => {
  it('each title is its own line; its note is secondary text on the next line', () => {
    const html = renderHtml(LocalDbSettings, dbProps());
    // Each text closes its OWN paragraph (MUI's server render puts <style> tags in between).
    for (const line of ['Core — subjects and genres', 'Names are looked up online.', 'Full — also 12 million names',
      'Large download (about 1.9 GB) and about 5.4 GB of disk space.']) {
      expect(html).toContain(`>${line}</p>`);
    }
  });
});
