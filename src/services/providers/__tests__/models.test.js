import { describe, it, expect, vi } from 'vitest';
import { listModels } from '../models';
import { resolveConfigFromDraft, resolveConfig } from '../config';
import { originFor } from '../permissions';
import { fakes, response, installLanguageModel } from '../../../../test/setup';
import { KEY, entryOf, mockFetch, spyConsole } from '../../../../test/fixtures';

const listCfg = async (id, draft = {}, { grant = true } = {}) => {
  const cfg = await resolveConfigFromDraft(entryOf(id), { apiKey: KEY, ...draft }, { purpose: 'list' });
  if (grant && originFor(cfg)) fakes.permissions.granted.add(originFor(cfg));
  return cfg;
};

const SHAPE = ['models', 'partial', 'supported'];

describe('[row 12] listModels', () => {
  it('OpenAI-style list with image metadata (DeepSeek, Moonshot, OpenRouter)', async () => {
    const cfg = await listCfg('deepseek');
    const fetchMock = mockFetch(response({
      object: 'list',
      data: [
        { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
        { id: 'deepseek-v4-pro', input_modalities: ['text'] }
      ]
    }));
    const result = await listModels(cfg);
    expect(result).toEqual({
      supported: true,
      partial: false,
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash', images: true },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', images: false }
      ]
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/models');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });

    const moonshot = await listCfg('moonshot', { region: 'cn' });
    mockFetch(response({ data: [{ id: 'kimi-k3', supports_image_in: true }, { id: 'kimi-k2.6', supports_image_in: false }, { id: 'x' }] }));
    expect((await listModels(moonshot)).models.map((m) => m.images)).toEqual([true, false, null]);
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.moonshot.cn/v1/models');

    const openrouter = await listCfg('openrouter');
    mockFetch(response({ data: [{ id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs', 'response_format'] }] }));
    expect((await listModels(openrouter)).models).toEqual([{ id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash', images: true }]);
    expect(fakes.storage.data.get('modelMeta:openrouter:intl').models).toEqual([
      { id: 'google/gemini-2.5-flash', images: true, supportedParameters: ['structured_outputs', 'response_format'] }
    ]);
  });

  it('404 → unsupported', async () => {
    const cfg = await listCfg('minimax');
    mockFetch(response('not found', { status: 404 }));
    expect(await listModels(cfg)).toEqual({ supported: false, models: [], partial: false });
    expect(fakes.storage.data.has('modelMeta:minimax:intl')).toBe(false);
  });

  it('Gemini paging, prefix strip and generateContent filter', async () => {
    const cfg = await listCfg('gemini');
    const fetchMock = mockFetch(
      response({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ],
        nextPageToken: 'P2'
      }),
      response({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] })
    );
    const result = await listModels(cfg);
    expect(result).toEqual({
      supported: true,
      partial: false,
      models: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', images: null },
        { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash', images: null }
      ]
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100');
    expect(fetchMock.mock.calls[1][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&pageToken=P2');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-goog-api-key': KEY });
    expect(fetchMock.mock.calls[0][0]).not.toContain(KEY);
  });

  it('Gemini stops after 5 pages with partial:true', async () => {
    const cfg = await listCfg('gemini');
    let n = 0;
    const fetchMock = mockFetch(() => {
      n += 1;
      return response({ models: [{ name: `models/m${n}`, supportedGenerationMethods: ['generateContent'] }], nextPageToken: `T${n}` });
    });
    const result = await listModels(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.partial).toBe(true);
    expect(result.models).toHaveLength(5);
  });

  it('Anthropic paging with after_id while has_more', async () => {
    const cfg = await listCfg('anthropic');
    const fetchMock = mockFetch(
      response({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { image_input: true } }], has_more: true, last_id: 'claude-opus-5-5' }),
      response({ data: [{ id: 'claude-haiku-4-5', capabilities: {} }], has_more: false, last_id: 'claude-haiku-4-5' })
    );
    const result = await listModels(cfg);
    expect(result.models).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', images: true },
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', images: null }
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=100&after_id=claude-opus-5-5');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
  });

  it('missing permission → permission error, no fetch', async () => {
    const cfg = await listCfg('openai', {}, { grant: false });
    await expect(listModels(cfg)).rejects.toMatchObject({ kind: 'permission' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('the cache is written with fetchedAt', async () => {
    const cfg = await listCfg('moonshot');
    mockFetch(response({ data: [{ id: 'kimi-k3', supports_image_in: true }] }));
    const before = Date.now();
    await listModels(cfg);
    const cached = fakes.storage.data.get('modelMeta:moonshot:intl');
    expect(cached.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(cached.models).toEqual([{ id: 'kimi-k3', images: true }]);
  });
});

describe('[row 18] listing without a model', () => {
  it.each([
    ['openai', {}, 'https://api.openai.com/v1/models'],
    ['openrouter', {}, 'https://openrouter.ai/api/v1/models'],
    ['lmstudio', { apiKey: '' }, 'http://localhost:1234/v1/models'],
    ['custom', { apiKey: '', baseURL: 'https://llm.example.com/v1' }, 'https://llm.example.com/v1/models']
  ])('a fresh %s draft with no model can load models', async (id, draft, url) => {
    const cfg = await listCfg(id, draft);
    expect(cfg.model).toBeNull();
    const fetchMock = mockFetch(response({ data: [{ id: 'model-a' }] }));
    const result = await listModels(cfg);
    expect(result).toEqual({ supported: true, partial: false, models: [{ id: 'model-a', label: 'model-a', images: null }] });
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    await expect(resolveConfigFromDraft(entryOf(id), { apiKey: KEY, ...draft })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('persisted metadata is reloaded after a restart', async () => {
    const cfg = await listCfg('openrouter');
    mockFetch(response({ data: [{ id: 'vendor/strict', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs'] }] }));
    await listModels(cfg);

    // "Restart": a new page loads the settings module fresh and reads the cache.
    vi.resetModules();
    const settings = await import('../../settings');
    const config = await import('../config');
    await settings.updateProvider('openrouter', { apiKey: KEY, model: 'vendor/strict' });
    const loaded = await settings.getSettings();
    expect(loaded.modelMeta['modelMeta:openrouter:intl'].models[0].id).toBe('vendor/strict');
    const resolved = await config.resolveConfig(loaded, 'openrouter');
    expect(resolved.caps).toMatchObject({ jsonMode: 'json_schema', openrouterRequireParameters: true, images: true, imagesKnown: true });
    expect(await resolveConfig(loaded, 'openrouter')).toMatchObject({ model: 'vendor/strict' });
  });

  it('every branch returns exactly {supported, models, partial}', async () => {
    const results = [];
    results.push(await listModels(await listCfg('qwen')));
    results.push(await listModels(await listCfg('zhipu', { region: 'cn' })));
    installLanguageModel({ availability: { text: 'available', image: 'downloadable' } });
    results.push(await listModels(await listCfg('gemini-nano')));
    mockFetch(response('', { status: 404 }));
    results.push(await listModels(await listCfg('openai')));
    mockFetch(response({ data: [] }));
    results.push(await listModels(await listCfg('openai')));
    mockFetch(response({ models: [] }));
    results.push(await listModels(await listCfg('gemini')));
    mockFetch(response({ data: [], has_more: false }));
    results.push(await listModels(await listCfg('anthropic')));
    for (const r of results) {
      expect(Object.keys(r).sort()).toEqual(SHAPE);
      expect(Array.isArray(r.models)).toBe(true);
    }
    expect(results[0]).toEqual({ supported: false, models: [], partial: false });
    expect(results[2]).toEqual({ supported: true, partial: false, models: [{ id: 'gemini-nano', label: 'Gemini Nano (on-device)', images: false }] });
  });
});

describe('[row 21] listModels deadline is shared across pages', () => {
  it('two slow pages together exceed 20 s → timeout', async () => {
    vi.useFakeTimers();
    const cfg = await listCfg('gemini');
    let n = 0;
    const fetchMock = mockFetch(() => new Promise((resolve) => {
      n += 1;
      setTimeout(() => resolve(response({ models: [], nextPageToken: `T${n}` })), 12000);
    }));
    const pending = listModels(cfg).then((v) => ({ v }), (e) => ({ e }));
    await vi.advanceTimersByTimeAsync(20000);
    const { e } = await pending;
    expect(e).toMatchObject({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fix-1 #1: a successful model list that echoes the key is rejected', () => {
  const noLeak = (fetchMock, consoleSpy) => {
    for (const [url] of fetchMock.mock.calls) expect(url).not.toContain(KEY);
    expect(JSON.stringify(fakes.storage.dump())).not.toContain(KEY);
    expect(consoleSpy.logged(KEY)).toBe(false);
  };

  it('Gemini nextPageToken carrying the key never reaches the next request URL', async () => {
    const consoleSpy = spyConsole();
    const cfg = await listCfg('gemini');
    const fetchMock = mockFetch(
      response({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: `tok-${KEY}` }),
      response({ models: [] })
    );
    await expect(listModels(cfg)).rejects.toMatchObject({ kind: 'invalid_output', message: 'Google Gemini returned an answer in the wrong format.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    noLeak(fetchMock, consoleSpy);
  });

  it('Anthropic last_id carrying the key never becomes after_id', async () => {
    const consoleSpy = spyConsole();
    const cfg = await listCfg('anthropic');
    const fetchMock = mockFetch(
      response({ data: [{ id: 'claude-sonnet-5' }], has_more: true, last_id: KEY }),
      response({ data: [], has_more: false })
    );
    await expect(listModels(cfg)).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    noLeak(fetchMock, consoleSpy);
  });

  it.each([
    ['a model id', { data: [{ id: `model-${KEY}` }] }],
    ['a metadata field', { data: [{ id: 'm', supported_parameters: [KEY] }] }],
    ['a property name', { data: [{ id: 'm', [KEY]: true }] }]
  ])('%s carrying the key is not cached or returned', async (_, body) => {
    const consoleSpy = spyConsole();
    const cfg = await listCfg('openrouter');
    const fetchMock = mockFetch(response(body));
    const outcome = await listModels(cfg).then((value) => ({ value }), (error) => ({ error }));
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ kind: 'invalid_output' });
    expect(JSON.stringify(outcome.error)).not.toContain(KEY);
    expect(fakes.storage.data.has('modelMeta:openrouter:intl')).toBe(false);
    noLeak(fetchMock, consoleSpy);
  });

  it('a list without the key is unaffected; a keyless config checks nothing', async () => {
    const cfg = await listCfg('lmstudio', { apiKey: '' });
    mockFetch(response({ data: [{ id: 'anything-at-all' }] }));
    expect((await listModels(cfg)).models).toHaveLength(1);
  });
});

describe('fix-1 #7: discarded response bodies are cancelled', () => {
  it('the accepted 404 of an OpenAI-style list cancels its body', async () => {
    const cfg = await listCfg('openai');
    const notFound = response('nope', { status: 404 });
    mockFetch(notFound);
    expect(await listModels(cfg)).toEqual({ supported: false, models: [], partial: false });
    expect(notFound.body.cancel).toHaveBeenCalledTimes(1);
    expect(notFound.text).not.toHaveBeenCalled();
  });
});
