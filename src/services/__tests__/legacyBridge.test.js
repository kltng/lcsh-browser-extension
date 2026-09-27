import { describe, it, expect, vi } from 'vitest';
import {
  legacyGenerateSuggestions, legacyGenerateMarc, parseLcshSuggestions, describeActiveProvider, logWorkflowError
} from '../legacyBridge';
import { setActiveProvider, updateProvider } from '../settings';
import { buildConversationRecord } from '../../components/FinalRecommendations';
import { fakes, response } from '../../../test/setup';
import { KEY, mockFetch, successBody, bodyOf, spyConsole } from '../../../test/fixtures';

const ORIGINS = {
  gemini: 'https://generativelanguage.googleapis.com/*',
  deepseek: 'https://api.deepseek.com/*',
  anthropic: 'https://api.anthropic.com/*',
  openai: 'https://api.openai.com/*'
};

const configure = (active, providers) => {
  fakes.storage.seed({
    settingsVersion: 2,
    activeProviderId: active,
    lookupBackend: 'loc-api',
    ...Object.fromEntries(Object.entries(providers).map(([id, value]) => [`provider:${id}`, value]))
  });
  for (const id of Object.keys(providers)) if (ORIGINS[id]) fakes.permissions.granted.add(ORIGINS[id]);
};

const SUGGESTION_TEXT = `### **Subject Analysis**
A study of cats.

---

### **API Validation Process**
I will validate the following candidate LCSH terms using the API:
1. **Cats**
2. **Cats--Behavior**

---

### **Recommended LCSH Terms**

1. **Cats** (✓ Verified by API)
   - **MARC:**
   \`\`\`marc
   650 _0 $a Cats
   \`\`\`
   - **API ID:** sh85021262
   - **URL:** [LCSH Record](https://id.loc.gov/authorities/subjects/sh85021262)
   - **Justification:** Main topic.

---

### **Special Considerations**
None.`;

const BIB = { title: 'Cats', author: 'Tanaka', abstract: 'About cats.', tableOfContents: '', notes: '', images: [] };
const RULES = '# Rules\n1. Be specific.';
const RECS = [
  { term: 'cats (suggested)', similarity: 80, bestMatch: { heading: 'Cats', identifier: 'sh85021262', source: 'lcsh' } },
  { term: 'Dog stuff', similarity: 10, bestMatch: { heading: 'Dogs' } },
  { term: 'Japan history', similarity: 70, bestMatch: { heading: 'Japan--History', source: 'lcsh' } },
  { term: 'No match', similarity: 90, bestMatch: null }
];
const MARC_TEXT = '```marc\n650 _0 $a Cats\n```\n\n```marc\n651 _0 $a Japan $x History\n```';

describe('[row 15] bridge', () => {
  it('the suggestions envelope is parsed by the unchanged parseLcshSuggestions', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const fetchMock = mockFetch(response(successBody('gemini', SUGGESTION_TEXT)));
    const result = await legacyGenerateSuggestions(BIB, RULES);
    expect(result.candidates).toEqual([{ content: { parts: [{ text: SUGGESTION_TEXT }] } }]);
    expect(result.provenance).toEqual({ providerId: 'gemini', model: 'gemini-2.5-flash' });
    const parsed = parseLcshSuggestions(result);
    expect(parsed.candidateTerms).toEqual(['Cats', 'Cats--Behavior']);
    expect(parsed.recommendedTerms[0]).toMatchObject({ term: 'Cats', marc: '650 _0 $a Cats', apiId: 'sh85021262' });
    expect(parsed.specialConsiderations).toBe('None.');
    const body = bodyOf(fetchMock);
    expect(body.systemInstruction.parts[0].text.startsWith(RULES)).toBe(true);
    expect(body.contents[0].parts[0].text).toContain('Title: Cats');
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 8192 });
  });

  it('MARC returns {marcRecords} keyed by the original terms', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const fetchMock = mockFetch(response(successBody('gemini', MARC_TEXT)));
    const result = await legacyGenerateMarc(RECS);
    expect(result.marcRecords).toEqual({ 'cats (suggested)': '650 _0 $a Cats', 'Japan history': '651 _0 $a Japan $x History' });
    expect(result.provenance).toEqual({ providerId: 'gemini', model: 'gemini-2.5-flash' });
    const body = bodyOf(fetchMock);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain('Term: Cats');
    expect(body.contents[0].parts[0].text).not.toContain('Dogs');
    expect(body.generationConfig.temperature).toBe(0.1);
  });

  it('zero eligible terms → no network call', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    expect(await legacyGenerateMarc([RECS[1], RECS[3]])).toEqual({ marcRecords: {}, provenance: null });
    expect(await legacyGenerateMarc([])).toEqual({ marcRecords: {}, provenance: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('the snapshot is kept when settings change mid-call', async () => {
    configure('gemini', { gemini: { apiKey: KEY, model: 'gemini-2.5-flash' }, deepseek: { apiKey: KEY } });
    const fetchMock = vi.fn(async () => {
      await setActiveProvider('deepseek');
      await updateProvider('gemini', { model: 'gemini-3.8-flash' });
      return response(successBody('gemini', SUGGESTION_TEXT));
    });
    globalThis.fetch = fetchMock;
    const result = await legacyGenerateSuggestions(BIB, RULES);
    expect(result.provenance).toEqual({ providerId: 'gemini', model: 'gemini-2.5-flash' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-2.5-flash:generateContent');
    expect(fakes.storage.data.get('activeProviderId')).toBe('deepseek');
  });

  it('maps images [{data, name, type, size}] to [{mimeType, dataUrl}]', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const fetchMock = mockFetch(response(successBody('gemini', SUGGESTION_TEXT)));
    await legacyGenerateSuggestions({
      ...BIB,
      images: [
        { data: 'data:image/png;base64,AAAA', name: 'a.png', type: 'image/png', size: 3 },
        { data: 'data:image/jpeg;base64,BBBB', name: 'b.jpg', type: 'image/jpeg', size: 3 }
      ]
    }, RULES);
    expect(bodyOf(fetchMock).contents[0].parts.slice(1)).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }
    ]);
  });

  it('describes the active provider for the workflow label', async () => {
    configure('deepseek', { deepseek: { apiKey: KEY } });
    expect(await describeActiveProvider()).toBe('Using DeepSeek · deepseek-flash');
  });
});

describe('[row 19] bridge provenance (UI behavior: live verification owned by the lead)', () => {
  it('suggestions with provider A and MARC with provider B return their provenance; buildConversationRecord keeps both provenance fields', async () => {
    configure('gemini', { gemini: { apiKey: KEY }, deepseek: { apiKey: KEY, model: 'deepseek-flash' } });
    mockFetch(response(successBody('gemini', SUGGESTION_TEXT)));
    const suggestions = await legacyGenerateSuggestions(BIB, RULES);
    await setActiveProvider('deepseek');
    const fetchMock = mockFetch(response(successBody('openai-style', MARC_TEXT)));
    const marc = await legacyGenerateMarc(RECS);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    const record = buildConversationRecord({
      bibliographicInfo: BIB,
      initialSuggestions: parseLcshSuggestions(suggestions),
      sortedRecommendations: RECS,
      selectedRecommendations: [],
      averageSimilarity: 62,
      marcRecords: marc.marcRecords,
      suggestionProvenance: suggestions.provenance,
      marcProvenance: marc.provenance
    });
    const saved = JSON.parse(JSON.stringify(record));
    expect(saved.suggestionProvenance).toEqual({ providerId: 'gemini', model: 'gemini-2.5-flash' });
    expect(saved.marcProvenance).toEqual({ providerId: 'deepseek', model: 'deepseek-flash' });
    expect(saved.marcRecords['cats (suggested)']).toBe('650 _0 $a Cats');
    expect(JSON.stringify(record)).not.toContain(KEY);
  });

  it('a settings change during the MARC request keeps the snapshot', async () => {
    configure('deepseek', { deepseek: { apiKey: KEY, model: 'deepseek-flash' }, gemini: { apiKey: KEY } });
    globalThis.fetch = vi.fn(async () => {
      await updateProvider('deepseek', { model: 'deepseek-v4-pro' });
      await setActiveProvider('gemini');
      return response(successBody('openai-style', MARC_TEXT));
    });
    const marc = await legacyGenerateMarc(RECS);
    expect(marc.provenance).toEqual({ providerId: 'deepseek', model: 'deepseek-flash' });
    expect(bodyOf(globalThis.fetch).model).toBe('deepseek-flash');
  });

  it('MARC with zero eligible terms and NO provider configured → {marcRecords:{}}', async () => {
    configure('openai', {});
    fakes.storage.failNext('get', new Error('must not be read'));
    expect(await legacyGenerateMarc([RECS[1]])).toEqual({ marcRecords: {}, provenance: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('missing provenance is saved as null', () => {
    const record = buildConversationRecord({
      bibliographicInfo: BIB, initialSuggestions: {}, sortedRecommendations: [], selectedRecommendations: [],
      averageSimilarity: 0, marcRecords: {}
    });
    expect(record).toMatchObject({ suggestionProvenance: null, marcProvenance: null });
  });
});

describe('[row 23] Anthropic temperature', () => {
  it('bridge requests (0.2 / 0.1) to Anthropic contain no temperature', async () => {
    configure('anthropic', { anthropic: { apiKey: KEY } });
    let fetchMock = mockFetch(response(successBody('anthropic', SUGGESTION_TEXT)));
    await legacyGenerateSuggestions(BIB, RULES);
    const suggestionBody = bodyOf(fetchMock);
    expect('temperature' in suggestionBody).toBe(false);
    expect(suggestionBody.model).toBe('claude-sonnet-5');
    expect(suggestionBody.max_tokens).toBe(8192);
    fetchMock = mockFetch(response(successBody('anthropic', MARC_TEXT)));
    await legacyGenerateMarc(RECS);
    const marcBody = bodyOf(fetchMock);
    expect('temperature' in marcBody).toBe(false);
    expect('system' in marcBody).toBe(false);
  });

  it('OpenAI requests contain no temperature either; DeepSeek sends it', async () => {
    configure('openai', { openai: { apiKey: KEY, model: 'gpt-6-astra' }, deepseek: { apiKey: KEY } });
    let fetchMock = mockFetch(response(successBody('openai-style', SUGGESTION_TEXT)));
    await legacyGenerateSuggestions(BIB, RULES);
    expect('temperature' in bodyOf(fetchMock)).toBe(false);
    await setActiveProvider('deepseek');
    fetchMock = mockFetch(response(successBody('openai-style', SUGGESTION_TEXT)));
    await legacyGenerateSuggestions(BIB, RULES);
    expect(bodyOf(fetchMock).temperature).toBe(0.2);
  });
});

describe('[row 24] malformed 200 + secrets; logWorkflowError is the helper the component catch blocks call (UI behavior: live verification owned by the lead)', () => {
  it.each([
    ['HTML', () => response(`<html>${KEY}</html>`)],
    ['bad JSON', () => response(`{"candidates": "${KEY}`)],
    ['wrong types', () => response({ candidates: [{ content: { parts: [{ text: { key: KEY } }] }, finishReason: 'STOP' }] })]
  ])('%s echoing the key → invalid_output; logWorkflowError logs no key', async (_, make) => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const consoleSpy = spyConsole();
    for (const run of [() => legacyGenerateSuggestions(BIB, RULES), () => legacyGenerateMarc(RECS)]) {
      mockFetch(make());
      let caught = null;
      try {
        await run();
      } catch (err) {
        caught = err;
        // The existing catch blocks of BibliographicInfoForm and FinalRecommendations:
        logWorkflowError('Error generating LCSH suggestions:', err);
        logWorkflowError('Error generating MARC records:', err);
      }
      expect(caught).not.toBeNull();
      expect(caught.kind).toBe('invalid_output');
      expect(caught.message).toBe('Google Gemini returned an answer in the wrong format.');
      expect(caught.message).not.toContain(KEY);
      expect(JSON.stringify(caught)).not.toContain(KEY);
    }
    expect(consoleSpy.spies[3]).toHaveBeenCalledWith('Error generating LCSH suggestions:', expect.anything());
    expect(consoleSpy.logged(KEY)).toBe(false);
  });

  it('the key is never in a request URL', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const fetchMock = mockFetch(response(successBody('gemini', SUGGESTION_TEXT)));
    await legacyGenerateSuggestions(BIB, RULES);
    expect(fetchMock.mock.calls[0][0]).not.toContain(KEY);
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe(KEY);
  });
});

describe('fix-1 #1: a successful answer that echoes the key is rejected', () => {
  it.each([
    ['a suggestion answer', () => legacyGenerateSuggestions(BIB, RULES), `${SUGGESTION_TEXT}\nYour key is ${KEY}`],
    ['a MARC answer', () => legacyGenerateMarc(RECS), `\`\`\`marc\n650 _0 $a ${KEY}\n\`\`\``]
  ])('%s → invalid_output; the key is not returned or logged', async (_, run, text) => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const consoleSpy = spyConsole();
    mockFetch(response(successBody('gemini', text)));
    const outcome = await run().then((value) => ({ value }), (error) => ({ error }));
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ kind: 'invalid_output', message: 'Google Gemini returned an answer in the wrong format.' });
    logWorkflowError('Error generating:', outcome.error);
    expect(JSON.stringify(outcome.error)).not.toContain(KEY);
    expect(consoleSpy.logged(KEY)).toBe(false);
    expect(JSON.stringify(fakes.storage.dump()['conversationHistory'] ?? null)).not.toContain(KEY);
  });
});

describe('fix-1 #9b: logWorkflowError is safe by construction', () => {
  it('a ProviderError logs only {providerId, kind, status}', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    mockFetch(response({}, { status: 401 }));
    const err = await legacyGenerateSuggestions(BIB, RULES).catch((e) => e);
    const consoleSpy = spyConsole();
    logWorkflowError('Error generating LCSH suggestions:', err);
    expect(consoleSpy.spies[3]).toHaveBeenCalledWith('Error generating LCSH suggestions:', { providerId: 'gemini', kind: 'auth', status: 401 });
  });

  it.each([
    ['an Error whose message holds the key', new Error(`boom ${KEY}`)],
    ['a TypeError whose stack holds the key', Object.assign(new TypeError('x'), { stack: KEY })],
    ['a plain object', { message: KEY, detail: KEY }],
    ['a string', `oops ${KEY}`]
  ])('%s: only a typeof classification and a fixed message are logged', (_, err) => {
    const consoleSpy = spyConsole();
    logWorkflowError('Error generating MARC records:', err);
    expect(consoleSpy.logged(KEY)).toBe(false);
    const [label, payload] = consoleSpy.spies[3].mock.calls[0];
    expect(label).toBe('Error generating MARC records:');
    expect(Object.keys(payload)).toEqual(['errorType', 'message']);
    expect(payload.message).toBe('Unexpected error (details are not logged).');
  });

  it('fix-2 #3: { constructor: { name: KEY } } never logs the key', () => {
    const consoleSpy = spyConsole();
    logWorkflowError('Error generating LCSH suggestions:', { constructor: { name: KEY } });
    expect(consoleSpy.logged(KEY)).toBe(false);
    expect(consoleSpy.spies[3].mock.calls[0][1]).toEqual({
      errorType: 'non-provider error (object)', message: 'Unexpected error (details are not logged).'
    });
  });

  it('fix-2 #3: an object whose constructor getter throws does not make the logger throw', () => {
    const consoleSpy = spyConsole();
    const getter = vi.fn(() => { throw new Error(KEY); });
    const hostile = Object.defineProperty({}, 'constructor', { get: getter });
    expect(() => logWorkflowError('Error generating MARC records:', hostile)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(consoleSpy.logged(KEY)).toBe(false);
    // A Proxy whose prototype lookup throws is also handled.
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(KEY); } });
    expect(() => logWorkflowError('x', proxy)).not.toThrow();
    expect(consoleSpy.logged(KEY)).toBe(false);
  });
});
