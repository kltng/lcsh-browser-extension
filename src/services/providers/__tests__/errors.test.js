import { describe, it, expect, vi } from 'vitest';
import util from 'node:util';
import { ProviderError, errorFromStatus } from '../errors';
import { generate } from '../index';
import { resolveConfigFromDraft } from '../config';
import { listModels } from '../models';
import { fakes, response, installLanguageModel } from '../../../../test/setup';
import {
  KEY, entryOf, makeCfg, mockFetch, spyConsole, successBody, VALID_TEST_ANSWER
} from '../../../../test/fixtures';
import { TEST_SCHEMA } from '../schema';

const REQ = { system: 'You are a test.', userText: 'Say OK.' };
const RA0 = { 'Retry-After': '0' };

const failWith = async (cfg, req = REQ) => {
  try {
    await generate(cfg, req);
  } catch (err) {
    return err;
  }
  throw new Error('expected generate() to fail');
};

describe('[row 9] errors: every §4.6 row, with its template', () => {
  it('not_configured: key, model and URL', async () => {
    await expect(resolveConfigFromDraft(entryOf('openai'), {})).rejects.toMatchObject({
      kind: 'not_configured', retryable: false, message: 'OpenAI is not set up: the API key is missing. Open Settings.'
    });
    await expect(resolveConfigFromDraft(entryOf('openai'), { apiKey: KEY })).rejects.toMatchObject({
      kind: 'not_configured', message: 'OpenAI is not set up: no model is chosen. Open Settings.'
    });
    await expect(resolveConfigFromDraft(entryOf('custom'), { model: 'm' })).rejects.toMatchObject({
      kind: 'not_configured', message: 'Custom (OpenAI-compatible) is not set up: the server address is missing. Open Settings.'
    });
    await expect(resolveConfigFromDraft(entryOf('custom'), { model: 'm', baseURL: 'http://example.com' })).rejects.toMatchObject({
      kind: 'not_configured'
    });
  });

  it('permission', async () => {
    const cfg = await makeCfg('openai', {}, { grant: false });
    const err = await failWith(cfg);
    expect(err).toMatchObject({ kind: 'permission', retryable: false });
    expect(err.message).toBe('Chrome needs your permission to contact api.openai.com. Open Settings and click Grant access.');
  });

  it.each([
    [401, 'auth', false, 'OpenAI rejected the API key. Check it in Settings.'],
    [403, 'forbidden', false, 'OpenAI refused the request (403). The key may lack access to this model or region.'],
    [404, 'bad_request', false, 'OpenAI does not know the model or address. Check the model name and region.'],
    [400, 'bad_request', false, 'OpenAI rejected the request. The model may not support this feature (for example structured output or images).'],
    [422, 'bad_request', false, 'OpenAI rejected the request. The model may not support this feature (for example structured output or images).'],
    [429, 'rate_limit', true, 'OpenAI rate limit reached. Try again in a minute.'],
    [500, 'server', true, 'OpenAI had a server error. Try again later.'],
    [502, 'server', true, 'OpenAI had a server error. Try again later.'],
    [504, 'server', true, 'OpenAI had a server error. Try again later.'],
    [503, 'overloaded', true, 'OpenAI is overloaded. Try again later.'],
    [529, 'overloaded', true, 'OpenAI is overloaded. Try again later.'],
    [402, 'billing', false, 'OpenAI reports a billing or credit problem on this account.'],
    [413, 'too_long', false, 'The request is too large for OpenAI. Remove images or shorten the text.'],
    [418, 'bad_request', false, 'OpenAI rejected the request. The model may not support this feature (for example structured output or images).'],
    [599, 'server', true, 'OpenAI had a server error. Try again later.']
  ])('HTTP %i → %s', async (status, kind, retryable, message) => {
    const cfg = await makeCfg('openai');
    const fetchMock = mockFetch(response({ error: { message: 'raw provider text' } }, { status, headers: RA0 }));
    const err = await failWith(cfg);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind, retryable, status, providerId: 'openai' });
    expect(err.message).toBe(message);
    expect(err.message).not.toContain('raw provider text');
    const retried = [429, 500, 502, 503, 504, 529].includes(status);
    expect(fetchMock).toHaveBeenCalledTimes(retried ? 3 : 1);
  });

  it('2xx with a non-JSON body → invalid_output', async () => {
    const cfg = await makeCfg('openai');
    mockFetch(response('<html>oops</html>'));
    const err = await failWith(cfg);
    expect(err).toMatchObject({ kind: 'invalid_output', retryable: false, message: 'OpenAI returned an answer in the wrong format.' });
  });

  it('deadline → timeout; caller abort → cancelled', async () => {
    const cfg = await makeCfg('openai');
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const timeout = await failWith(cfg, { ...REQ, deadlineMs: 20 });
    expect(timeout).toMatchObject({ kind: 'timeout', retryable: true, message: 'OpenAI did not answer in time.' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const cancelled = await failWith(cfg, { ...REQ, signal: controller.signal });
    expect(cancelled).toMatchObject({ kind: 'cancelled', retryable: false, message: 'Cancelled.' });
  });

  it('network TypeError after retries → network', async () => {
    vi.useFakeTimers();
    const cfg = await makeCfg('openai');
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    globalThis.fetch = fetchMock;
    const pending = failWith(cfg);
    await vi.advanceTimersByTimeAsync(3500);
    const err = await pending;
    expect(err).toMatchObject({ kind: 'network', retryable: true, message: 'Could not reach api.openai.com. Check your connection.' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('truncated, refused, invalid_output (extraction and validation)', async () => {
    const cfg = await makeCfg('openai');
    mockFetch(response({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] }));
    expect(await failWith(cfg)).toMatchObject({ kind: 'truncated', message: 'The answer was cut off (token limit reached).' });
    mockFetch(response({ choices: [{ message: { content: null, refusal: 'I cannot' }, finish_reason: 'stop' }] }));
    expect(await failWith(cfg)).toMatchObject({ kind: 'refused', message: 'OpenAI declined to answer this request.' });
    mockFetch(response(successBody('openai-style', 'no json here')));
    expect(await failWith(cfg, { ...REQ, schema: TEST_SCHEMA })).toMatchObject({ kind: 'invalid_output', message: 'OpenAI returned an answer in the wrong format.' });
    mockFetch(response(successBody('openai-style', JSON.stringify({ ...VALID_TEST_ANSWER, terms: [] }))));
    expect(await failWith(cfg, { ...REQ, schema: TEST_SCHEMA })).toMatchObject({ kind: 'invalid_output' });
  });

  it('images_unsupported before any network call', async () => {
    const cfg = await makeCfg('qwen');
    const err = await failWith(cfg, { ...REQ, images: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }] });
    expect(err).toMatchObject({ kind: 'images_unsupported', message: 'This model cannot read images. Remove the images or choose another model.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('Nano unavailable and Nano too_long', async () => {
    const cfg = await makeCfg('gemini-nano');
    expect(await failWith(cfg)).toMatchObject({ kind: 'unavailable', message: 'Gemini Nano is not available on this device or browser right now.' });
    installLanguageModel({ used: 5000, need: 500, window: 6000 });
    expect(await failWith(cfg)).toMatchObject({ kind: 'too_long', message: 'The input is too long for Gemini Nano. Shorten the abstract or table of contents.' });
  });

  it('errorFromStatus never needs a body; ProviderError keeps only local fields', () => {
    const err = errorFromStatus(500, { providerId: 'x', provider: 'X', host: 'x.example' });
    expect(JSON.parse(JSON.stringify(err))).toEqual({ name: 'ProviderError', providerId: 'x', kind: 'server', status: 500, retryable: true });
    expect(err.cause).toBeUndefined();
  });

  it('logs only {providerId, kind, status}', async () => {
    const cfg = await makeCfg('openai');
    const consoleSpy = spyConsole();
    mockFetch(response({}, { status: 401 }));
    await failWith(cfg);
    const errorSpy = consoleSpy.spies[3];
    expect(errorSpy).toHaveBeenCalledWith('[provider]', { providerId: 'openai', kind: 'auth', status: 401 });
  });
});

describe('[row 9] errors: the key never leaks, even when the server echoes it', () => {
  const echoes = [
    ['a JSON body', (status) => response({ error: { message: `Invalid key ${KEY}` } }, { status, headers: { ...RA0, 'x-echo': KEY } })],
    ['an HTML body', (status) => response(`<html><body>key=${KEY}</body></html>`, { status, headers: { ...RA0, 'x-echo': KEY } })],
    ['a header only', (status) => response('', { status, headers: { ...RA0, 'www-authenticate': `Bearer ${KEY}` } })]
  ];

  for (const [label, make] of echoes) {
    it.each([400, 401, 403, 404, 429, 500, 200])(`${label}, HTTP %i`, async (status) => {
      const consoleSpy = spyConsole();
      for (const id of ['openai', 'gemini', 'anthropic']) {
        const cfg = await makeCfg(id);
        mockFetch(make(status));
        const err = await failWith(cfg, { ...REQ, schema: status === 200 ? TEST_SCHEMA : null });
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).not.toContain(KEY);
        expect(JSON.stringify(err)).not.toContain(KEY);
        expect(String(err.stack)).not.toContain(KEY);
        expect(util.inspect(err, { depth: 10, showHidden: true })).not.toContain(KEY);
      }
      expect(consoleSpy.logged(KEY)).toBe(false);
    });
  }
});

describe('[row 24] malformed 200 responses that echo the key', () => {
  it.each([
    ['HTML', () => response(`<!doctype html><p>${KEY}</p>`)],
    ['bad JSON', () => response(`{"choices": [ ${KEY}`)],
    ['wrong types', () => response({ choices: [{ message: { content: { key: KEY } }, finish_reason: 'stop' }] })],
    ['a whitespace answer', () => response({ choices: [{ message: { content: '   \n ' }, finish_reason: 'stop' }], echo: KEY })]
  ])('%s → invalid_output without the key', async (_, make) => {
    const consoleSpy = spyConsole();
    const cfg = await makeCfg('openai');
    mockFetch(make());
    const err = await failWith(cfg);
    expect(err).toMatchObject({ kind: 'invalid_output', message: 'OpenAI returned an answer in the wrong format.' });
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(consoleSpy.logged(KEY)).toBe(false);
  });
});

describe('fix-1 #1: successful answers that echo the key', () => {
  const escaped = `\\u${KEY.charCodeAt(0).toString(16).padStart(4, '0')}${KEY.slice(1)}`;

  it.each([
    ['a text answer', null, `Sure. Your key is ${KEY}.`],
    ['a JSON field', TEST_SCHEMA, JSON.stringify({ ...VALID_TEST_ANSWER, analysis: `About ${KEY}` })],
    ['a JSON field hidden by a \\u escape', TEST_SCHEMA, `{"analysis":"About ${escaped}","terms":[{"heading":"Cats","kind":"topical","confidence":90,"uri":null}]}`]
  ])('%s → invalid_output, nothing returned or logged', async (_, schema, text) => {
    const consoleSpy = spyConsole();
    for (const id of ['openai', 'gemini', 'anthropic']) {
      const cfg = await makeCfg(id);
      mockFetch(response(successBody(cfg.entry.adapter, text)));
      const err = await failWith(cfg, { ...REQ, schema });
      expect(err).toMatchObject({ kind: 'invalid_output' });
      expect(JSON.stringify(err)).not.toContain(KEY);
    }
    expect(consoleSpy.logged(KEY)).toBe(false);
  });

  it('the escaped form really hides the key from a plain text search', () => {
    expect(escaped).not.toContain(KEY);
    expect(JSON.parse(`"${escaped}"`)).toBe(KEY);
  });
});

describe('fix-2 #1: keys shorter than 8 characters are not checked', () => {
  it('a short key ("a"): normal generation and normal model listing succeed', async () => {
    const cfg = await makeCfg('lmstudio', { apiKey: 'a' });
    mockFetch(response(successBody('openai-style', 'A normal answer about cats and a lamp.')));
    expect((await generate(cfg, REQ)).text).toBe('A normal answer about cats and a lamp.');
    mockFetch(response(successBody('openai-style', JSON.stringify(VALID_TEST_ANSWER))));
    expect((await generate(cfg, { ...REQ, schema: TEST_SCHEMA })).json).toEqual(VALID_TEST_ANSWER);
    const listCfg = await resolveConfigFromDraft(entryOf('lmstudio'), { apiKey: 'a' }, { purpose: 'list' });
    mockFetch(response({ data: [{ id: 'qwen/qwen3-1.7b' }, { id: 'a-model' }] }));
    expect((await listModels(listCfg)).models.map((m) => m.id)).toEqual(['qwen/qwen3-1.7b', 'a-model']);
  });

  describe('an 8-character key is still checked', () => {
    const KEY8 = 'k8secret';

    it('in answer text and in parsed JSON', async () => {
      const cfg = await makeCfg('lmstudio', { apiKey: KEY8 });
      mockFetch(response(successBody('openai-style', `echo ${KEY8}`)));
      await expect(generate(cfg, REQ)).rejects.toMatchObject({ kind: 'invalid_output' });
      mockFetch(response(successBody('openai-style', JSON.stringify({ ...VALID_TEST_ANSWER, analysis: KEY8 }))));
      await expect(generate(cfg, { ...REQ, schema: TEST_SCHEMA })).rejects.toMatchObject({ kind: 'invalid_output' });
    });

    it('in a pagination token (never reaches the next URL)', async () => {
      const cfg = await resolveConfigFromDraft(entryOf('gemini'), { apiKey: KEY8 }, { purpose: 'list' });
      fakes.permissions.granted.add('https://generativelanguage.googleapis.com/*');
      const fetchMock = mockFetch(
        response({ models: [], nextPageToken: `t-${KEY8}` }),
        response({ models: [] })
      );
      await expect(listModels(cfg)).rejects.toMatchObject({ kind: 'invalid_output' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).not.toContain(KEY8);
    });
  });
});
