/**
 * ui-2c item 2 (route ownership when Next resumes) and item 3 (the editor's
 * note after a failed key read). Clicks call the REAL handlers recorded from
 * a server render (the MUI Button is wrapped to record its onClick).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import AppShell from '../AppShell';
import ScrapedResults from '../ScrapedResults';
import { SuggestionsPanel, KEY_READ_FAILED_HEADING_NOTE, HIDDEN_HEADING_NOTE } from '../InitialSuggestions';
import { AppProvider, useAppContext } from '../../context/AppContext';
import { createRunCache } from '../../services/lookup/scheduler';
import { resetKeyRegistry, watchStoredKeys } from '../../services/keyGuard';
import { textOf } from '../../../test/render';
import { KEY } from '../../../test/fixtures';
/* eslint-enable import/first */

beforeEach(() => {
  recorded.clear();
  resetKeyRegistry();
});
afterEach(() => vi.unstubAllGlobals());

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

const CFG = { providerId: 'deepseek', model: 'deepseek-flash', apiKey: KEY, entry: { adapter: 'openai-style' } };
const answer = (json) => ({ text: JSON.stringify(json), json, finish: 'stop', mode: 'json_object', usage: {} });
const SUGGESTED = answer({ subjectAnalysis: 'Cats.', suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'Topic.' }] });
const SELECTION = answer({ selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 90 }], additional: [] });
const CATS = {
  cid: 'lcsh:sh85021262', authority: 'lcsh', localId: 'sh85021262', uri: 'http://id.loc.gov/authorities/subjects/sh85021262',
  label: 'Cats', marcKey: '150  $aCats', rdfTypes: [], matchClass: 'exact-full', source: 'local-db', via: 'label'
};
const PROVENANCE = { backend: 'local-db', profile: 'core', release: '2026.10.01.1', releaseCommit: 'a'.repeat(40), file: '/db.db' };
const isSelectRequest = (req) => JSON.stringify(req?.schema || {}).includes('selections');

/** The real provider, AppShell and Matches view; the run is looked up and on Matches. */
const onMatches = async () => {
  const gate = deferred();
  const nameKeyCalls = [];
  let n = 0;
  const deps = {
    loadConfig: async () => ({ cfg: CFG, settings: { lookupBackend: 'local-db' } }),
    generateImpl: async (cfg, req) => (isSelectRequest(req) ? gate.promise : SUGGESTED),
    createBackend: () => ({
      id: 'local-db',
      cache: createRunCache(),
      lookup: async (s) => ({
        suggestionId: s.id, candidates: [CATS], failures: [], incomplete: false, rejectedHits: 0, requests: [], provenance: PROVENANCE, replacementNotes: []
      })
    }),
    uuid: () => `run-${++n}`,
    resolveNameKeysImpl: async (args) => { nameKeyCalls.push(args); return new Map(); }
  };
  let ctx = null;
  const Capture = () => { ctx = useAppContext(); return null; };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  renderToString(React.createElement(AppProvider, { workflowDeps: deps },
    React.createElement(Capture),
    React.createElement(AppShell, { hash: '', onNavigate: () => {} }),
    React.createElement(ScrapedResults)));
  const wf = ctx.workflow;
  await wf.suggest({ bibliographicInfo: { title: 'Cats' }, rules: '' });
  ctx.setActiveStep(1);
  await wf.lookupAll();
  ctx.setActiveStep(2);
  const leave = vi.spyOn(wf, 'leave');
  return { ctx, wf, gate, leave, nameKeyCalls };
};
// Leaving step 2 for step 3 calls leave('select'): the step changed.
const stepChanged = (leave) => leave.mock.calls.some(([op]) => op === 'select');

describe('[ui-2c item 2] Next checks the live route when it resumes', () => {
  it('control: the hash stays on the workflow → Next builds and changes the step', async () => {
    const win = { location: { hash: '' } };
    vi.stubGlobal('window', win);
    const { wf, gate, leave } = await onMatches();
    click('Next: recommendations');
    await settle();
    gate.resolve(SELECTION);
    await settle();
    expect(wf.getState().run.stage).toBe('built');
    expect(stepChanged(leave)).toBe(true);
  });

  it('the reviewer\'s ordering: location.hash becomes #settings, NO hashchange delivered, then the selection resolves → no build, no name keys, step unchanged', async () => {
    const win = { location: { hash: '' } };
    vi.stubGlobal('window', win);
    const { ctx, wf, gate, leave, nameKeyCalls } = await onMatches();
    click('Next: recommendations');
    await settle();
    expect(wf.getState().select.pending).toBe(true);
    const epoch = ctx.viewEpoch();
    win.location.hash = '#settings'; // the browser changed the hash; its event is still queued
    gate.resolve(SELECTION);
    await settle();
    expect(ctx.viewEpoch()).toBe(epoch); // nothing noted a navigation: only the live route stopped it
    expect(wf.getState().run.stage).not.toBe('built');
    expect(wf.getState().recommendations).toBeNull();
    expect(nameKeyCalls).toHaveLength(0);
    expect(stepChanged(leave)).toBe(false);
  });

  it('control: an empty "#" hash is still the workflow route → Next builds', async () => {
    const win = { location: { hash: '#' } };
    vi.stubGlobal('window', win);
    const { wf, gate } = await onMatches();
    click('Next: recommendations');
    await settle();
    gate.resolve(SELECTION);
    await settle();
    expect(wf.getState().run.stage).toBe('built');
  });
});

describe('[ui-2c item 3] the editor note after a FAILED key read', () => {
  it('says the saved settings could not be read, not that the text repeats a key', async () => {
    const stop = watchStoredKeys({ readStoredApiKeys: () => Promise.reject(new Error('read failed')), onSettingsChanged: () => () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settle();
    const html = renderToString(React.createElement(SuggestionsPanel, {
      suggest: { subjectAnalysis: '', suggestMode: 'json', suggestions: [{ id: 's1', heading: 'Cats', kind: 'topical', reason: '', source: 'ai' }] },
      editable: true, onEdit: () => ({ ok: true }), editingId: 's1'
    }));
    stop();
    const text = textOf(html);
    expect(text).toContain(KEY_READ_FAILED_HEADING_NOTE);
    expect(text).not.toContain(HIDDEN_HEADING_NOTE);
    expect(html).not.toMatch(/value="Cats"/);
  });
});
