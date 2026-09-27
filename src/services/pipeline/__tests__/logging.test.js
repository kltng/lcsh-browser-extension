import { describe, it, expect, vi } from 'vitest';
import { logWorkflowError } from '../logging';
import { runSuggest } from '../suggest';
import { createWorkflow } from '../workflow';
import { copyAllText, recommendationsCsv } from '../exports';
import { buildHistoryEntry, saveHistoryEntry } from '../../history';
import { fakes, response } from '../../../../test/setup';
import { KEY, makeCfg, mockFetch, successBody, spyConsole } from '../../../../test/fixtures';

const BIB = { title: 'Cats', author: 'Tanaka', abstract: 'About cats.', tableOfContents: '', notes: '', images: [] };
const suggestWith = async () => runSuggest({ cfg: await makeCfg('gemini', { model: 'gemini-2.5-flash' }), bibliographicInfo: BIB, rules: '' });

describe('[P4 row17] moved helpers: logging (from legacyBridge; P3 rows 24, fix-1 #9b, fix-2 #3)', () => {
  it.each([
    ['HTML', () => response(`<html>${KEY}</html>`)],
    ['bad JSON', () => response(`{"candidates": "${KEY}`)],
    ['wrong types', () => response({ candidates: [{ content: { parts: [{ text: { key: KEY } }] }, finishReason: 'STOP' }] })]
  ])('%s echoing the key → invalid_output; logWorkflowError logs no key', async (_, make) => {
    const consoleSpy = spyConsole();
    mockFetch(make());
    const caught = await suggestWith().catch((err) => err);
    logWorkflowError('Error generating suggestions:', caught);
    expect(caught.kind).toBe('invalid_output');
    expect(caught.message).toBe('Google Gemini returned an answer in the wrong format.');
    expect(JSON.stringify(caught)).not.toContain(KEY);
    expect(consoleSpy.spies[3]).toHaveBeenCalledWith('Error generating suggestions:', expect.anything());
    expect(consoleSpy.logged(KEY)).toBe(false);
  });

  it.each([
    ['in a heading', { subjectAnalysis: 'About cats.', suggestions: [{ heading: `Cats ${KEY}`, kind: 'topical', reason: 'r' }] }],
    ['in the subject analysis', { subjectAnalysis: `Your key is ${KEY}`, suggestions: [{ heading: 'Cats', kind: 'topical', reason: 'r' }] }],
    ['in a reason', { subjectAnalysis: 'x', suggestions: [{ heading: 'Cats', kind: 'topical', reason: KEY }] }]
  ])('a SCHEMA-VALID structured answer that echoes the key %s is rejected; history and exports never get it (fix-1 #8)', async (_, json) => {
    const { SUGGEST_SCHEMA } = await import('../schemas');
    const { validate } = await import('../../providers/schema');
    // The answer passes the schema: only the key guard can reject it.
    expect(validate(SUGGEST_SCHEMA, json).ok).toBe(true);
    const consoleSpy = spyConsole();
    // The JSON attempt and the text fallback both echo the key.
    mockFetch(response(successBody('gemini', JSON.stringify(json))));
    const cfg = await makeCfg('gemini', { model: 'gemini-2.5-flash' });
    const wf = createWorkflow({ loadConfig: async () => ({ cfg, settings: {} }), uuid: () => 'run-key' });
    await wf.suggest({ bibliographicInfo: BIB, rules: '' });
    const state = wf.getState();
    expect(state.suggestError).toMatchObject({ kind: 'invalid_output', message: 'Google Gemini returned an answer in the wrong format.' });
    expect(state.suggest).toBeNull();
    // The production destinations: the history builder + locked save, Copy all and the CSV builder.
    const entry = buildHistoryEntry({ run: state });
    await saveHistoryEntry(entry);
    const recs = state.recommendations || [];
    const outputs = [JSON.stringify(entry), JSON.stringify(fakes.storage.dump()), copyAllText(recs, []), recommendationsCsv(recs, []), JSON.stringify(state)];
    for (const out of outputs) expect(out).not.toContain(KEY);
    expect(consoleSpy.logged(KEY)).toBe(false);
  });

  it('the key is never in a request URL', async () => {
    const fetchMock = mockFetch(response(successBody('gemini', '{"subjectAnalysis":"x","suggestions":[{"heading":"Cats","kind":"topical","reason":""}]}')));
    await suggestWith();
    expect(fetchMock.mock.calls[0][0]).not.toContain(KEY);
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe(KEY);
  });

  it('a ProviderError logs only {providerId, kind, status}', async () => {
    mockFetch(response({}, { status: 401 }));
    const err = await suggestWith().catch((e) => e);
    const consoleSpy = spyConsole();
    logWorkflowError('Error generating suggestions:', err);
    expect(consoleSpy.spies[3]).toHaveBeenCalledWith('Error generating suggestions:', { providerId: 'gemini', kind: 'auth', status: 401 });
  });

  it.each([
    ['an Error whose message holds the key', new Error(`boom ${KEY}`)],
    ['a TypeError whose stack holds the key', Object.assign(new TypeError('x'), { stack: KEY })],
    ['a plain object', { message: KEY, detail: KEY }],
    ['a string', `oops ${KEY}`]
  ])('%s: only a typeof classification and a fixed message are logged', (_, err) => {
    const consoleSpy = spyConsole();
    logWorkflowError('Error choosing headings:', err);
    expect(consoleSpy.logged(KEY)).toBe(false);
    const [label, payload] = consoleSpy.spies[3].mock.calls[0];
    expect(label).toBe('Error choosing headings:');
    expect(Object.keys(payload)).toEqual(['errorType', 'message']);
    expect(payload.message).toBe('Unexpected error (details are not logged).');
  });

  it('{ constructor: { name: KEY } } never logs the key', () => {
    const consoleSpy = spyConsole();
    logWorkflowError('x', { constructor: { name: KEY } });
    expect(consoleSpy.logged(KEY)).toBe(false);
    expect(consoleSpy.spies[3].mock.calls[0][1]).toEqual({
      errorType: 'non-provider error (object)', message: 'Unexpected error (details are not logged).'
    });
  });

  it('an object whose constructor getter throws, or a hostile Proxy, does not make the logger throw', () => {
    const consoleSpy = spyConsole();
    const getter = vi.fn(() => { throw new Error(KEY); });
    const hostile = Object.defineProperty({}, 'constructor', { get: getter });
    expect(() => logWorkflowError('x', hostile)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(KEY); } });
    expect(() => logWorkflowError('x', proxy)).not.toThrow();
    expect(consoleSpy.logged(KEY)).toBe(false);
  });
});
