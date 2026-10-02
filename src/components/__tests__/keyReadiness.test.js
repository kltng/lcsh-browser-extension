/**
 * P6 fix 16, items 1 and 2: the key watcher is never started during render
 * (a discarded render cannot leak it), the very first paint still hides model
 * text until the stored keys have loaded, and a failed first read shows a
 * local message with "Try again" instead of "Loading…" for ever.
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import AppContext, { AppProvider } from '../../context/AppContext';
import ConversationHistory from '../ConversationHistory';
import { SuggestionsPanel } from '../InitialSuggestions';
import * as keyGuard from '../../services/keyGuard';
import { textOf } from '../../../test/render';
import { V110_ENTRY } from '../../../test/pipelineFixtures';
import { fakes } from '../../../test/setup';

const FAILED = 'Your saved settings could not be read, so AI text is hidden. Try again.';
const SUGGEST = {
  subjectAnalysis: 'A book about cats.',
  suggestions: [{ id: 's1', heading: 'Cats', kind: 'topical', reason: 'Main topic.' }],
  suggestMode: 'json'
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => keyGuard.resetKeyRegistry());

describe('[P6 fix16] the key watcher is not started during render (item 1)', () => {
  it('a DISCARDED render (no effects run) leaves no storage subscription behind', () => {
    const before = fakes.storage.listeners.size;
    renderToString(React.createElement(AppProvider, null, React.createElement('div')));
    expect(fakes.storage.listeners.size).toBe(before);
  });

  it('the first paint still shows "Loading…" for model fields, not the text', () => {
    const html = renderToString(React.createElement(AppProvider, null, React.createElement(SuggestionsPanel, { suggest: SUGGEST })));
    const text = textOf(html);
    expect(text).toContain('Loading…');
    expect(text).not.toContain('A book about cats.');
    expect(text).not.toContain('Main topic.');
  });
});

describe('[P6 fix16] a failed first key read (item 2)', () => {
  const renderHistory = () => textOf(renderToString(React.createElement(
    AppContext.Provider,
    {
      value: {
        conversationHistory: [V110_ENTRY], deleteConversation: async () => [], clearConversationHistory: async () => [],
        setActiveStep: () => {}, setBibliographicInfo: () => {}, error: null, setError: () => {}
      }
    },
    React.createElement(ConversationHistory)
  )));

  it('shows the local message with "Try again", not "Loading…"; a retry that succeeds renders normally', async () => {
    let attempt = 0;
    const stop = keyGuard.watchStoredKeys({
      readStoredApiKeys: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('storage is broken');
        return [];
      },
      onSettingsChanged: () => () => {}
    });
    await tick();
    const failed = renderHistory();
    expect(failed).toContain(FAILED);
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('Loading…');
    expect(failed).not.toContain('Main topic');

    await keyGuard.retryStoredKeys();
    await tick();
    const ok = renderHistory();
    expect(ok).not.toContain(FAILED);
    expect(ok).toContain('Main topic');
    stop();
  });
});
