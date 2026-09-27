import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import AppContext from '../../context/AppContext';
import ConversationHistory from '../ConversationHistory';

// A history entry as dev v1.1.0 saved it: no suggestionProvenance / marcProvenance.
const V110_ENTRY = {
  id: 1719000000000,
  timestamp: '2026-06-21T10:00:00.000Z',
  bibliographicInfo: {
    title: 'Cats of Japan', author: 'Tanaka, K.', abstract: 'About cats.', tableOfContents: '', notes: '',
    images: [{ name: 'cover.png', type: 'image/png', size: 1234 }]
  },
  initialSuggestions: { specialConsiderations: 'None.' },
  finalRecommendations: [{
    term: 'Cats', similarity: 90, justification: 'Main topic',
    bestMatch: { heading: 'Cats', uri: '/authorities/subjects/sh85021262', identifier: 'sh85021262', source: 'lcsh' }
  }],
  selectedRecommendations: [],
  averageSimilarity: 90,
  marcRecords: { Cats: '650 _0 $a Cats' }
};

const render = (conversationHistory) => renderToString(React.createElement(
  AppContext.Provider,
  {
    value: {
      conversationHistory,
      deleteConversation: vi.fn(),
      clearConversationHistory: vi.fn(),
      setActiveStep: vi.fn(),
      setBibliographicInfo: vi.fn(),
      setInitialSuggestions: vi.fn(),
      setFinalRecommendations: vi.fn(),
      setSuggestionProvenance: vi.fn(),
      error: null,
      setError: vi.fn()
    }
  },
  React.createElement(ConversationHistory)
));

describe('[row 26] old history', () => {
  it('renders a dev v1.1.0 entry without provenance fields', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = render([V110_ENTRY]);
    expect(html).toContain('Cats of Japan');
    expect(html).toContain('90%');
    expect(html).not.toContain('Suggestions:');
    // No real errors (React development "Warning: …" lines are not about the entry's data).
    const realErrors = errors.mock.calls.filter((args) => !String(args[0]).startsWith('Warning:'));
    expect(realErrors).toEqual([]);
  });

  it('renders the provenance of a P3 entry', () => {
    const html = render([{
      ...V110_ENTRY,
      suggestionProvenance: { providerId: 'deepseek', model: 'deepseek-flash' },
      marcProvenance: null
    }]);
    expect(html).toContain('Suggestions: deepseek (deepseek-flash)');
  });
});
