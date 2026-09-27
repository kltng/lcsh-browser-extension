import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import AppContext from '../../context/AppContext';
import ConversationHistory from '../ConversationHistory';
import { buildHistoryEntry, LEGACY_HEADER } from '../../services/history';
import { builtRun, V110_ENTRY, P3_ENTRY } from '../../../test/pipelineFixtures';

const render = (conversationHistory) => renderToString(React.createElement(
  AppContext.Provider,
  {
    value: {
      conversationHistory,
      deleteConversation: vi.fn(async () => {}),
      clearConversationHistory: vi.fn(async () => {}),
      setActiveStep: vi.fn(),
      setBibliographicInfo: vi.fn(),
      error: null,
      setError: vi.fn()
    }
  },
  React.createElement(ConversationHistory)
)).replace(/<!-- -->/g, '');

describe('[row 26] old history (P3 test, kept; also [P4 row 13] the P3 entry shape)', () => {
  it('renders a dev v1.1.0 entry without provenance fields', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = render([V110_ENTRY]);
    expect(html).toContain('Cats of Japan');
    expect(html).toContain('90%');
    expect(html).not.toContain('Suggestions:');
    expect(html).toContain(LEGACY_HEADER);
    // No real errors (React development "Warning: …" lines are not about the entry's data).
    const realErrors = errors.mock.calls.filter((args) => !String(args[0]).startsWith('Warning:'));
    expect(realErrors).toEqual([]);
  });

  it('renders the provenance of a P3 entry', () => {
    expect(render([P3_ENTRY])).toContain('Suggestions: deepseek (deepseek-flash)');
  });
});

describe('[P4 row 13] history: the list renders v2 and legacy entries together', () => {
  it('newest first; v2 entries read-only, legacy entries through the adapter', () => {
    const v2 = buildHistoryEntry({ run: { ...builtRun(), input: { title: 'New record' } } });
    const html = render([V110_ENTRY, P3_ENTRY, v2]);
    expect(html.indexOf('New record')).toBeLessThan(html.indexOf('Cats of Japan'));
    expect(html).toContain('Recommendations');
    expect(html.split(LEGACY_HEADER)).toHaveLength(3);
  });

  it('an empty history', () => {
    expect(render([])).toContain('No history yet.');
  });
});
