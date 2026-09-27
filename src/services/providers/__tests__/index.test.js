import { describe, it, expect, vi } from 'vitest';
import { generate, testConnection, probeJsonModes } from '../index';
import { resolveConfigFromDraft } from '../config';
import { PROVIDERS } from '../registry';
import { TEST_SCHEMA } from '../schema';
import { TEXT_OPTS, IMAGE_OPTS } from '../geminiNano';
import { fakes, response, installLanguageModel } from '../../../../test/setup';
import {
  KEY, entryOf, makeCfg, mockFetch, mockAnswer, successBody, bodyOf,
  VALID_TEST_ANSWER, GEMINI_TEST_SCHEMA, ANTHROPIC_TEST_SCHEMA
} from '../../../../test/fixtures';

const IMG = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const REQ = { system: 'SYS', userText: 'USER', temperature: 0.2, maxOutputTokens: 4096 };
const SUFFIX = `\n\nReturn only a JSON object that matches this JSON Schema:\n${JSON.stringify(TEST_SCHEMA)}`;

// The JSON mode each provider uses with no model metadata (§3.2, §3.3), written out independently.
const JSON_MODE = {
  openai: 'json_schema', deepseek: 'json_object', qwen: 'json_object', zhipu: 'json_object',
  moonshot: 'json_schema', minimax: 'prompt', openrouter: 'prompt', lmstudio: 'json_schema', custom: 'json_schema'
};
const BASE = {
  custom: { default: 'https://llm.example.com/v1' }
};

const cases = PROVIDERS.filter((p) => p.adapter !== 'chrome-nano').flatMap((entry) => (
  entry.regions
    ? Object.entries(entry.regions).map(([region, { baseURL }]) => ({ entry, region, baseURL }))
    : [{ entry, region: null, baseURL: BASE[entry.id].default }]
));

const tokens = (entry) => (entry.request.thinkingOn ? 8192 : 4096);

const expectedRequest = (entry, baseURL, variant) => {
  const withSchema = variant === 'json';
  const withImage = variant === 'image';
  if (entry.adapter === 'gemini') {
    const generationConfig = { temperature: 0.2, maxOutputTokens: tokens(entry) };
    if (withSchema) Object.assign(generationConfig, { responseMimeType: 'application/json', responseSchema: GEMINI_TEST_SCHEMA });
    return {
      url: `${baseURL}/models/test-model:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: {
        systemInstruction: { parts: [{ text: 'SYS' }] },
        contents: [{ role: 'user', parts: [{ text: 'USER' }, ...(withImage ? [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] : [])] }],
        generationConfig
      }
    };
  }
  if (entry.adapter === 'anthropic') {
    return {
      url: `${baseURL}/messages`,
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json'
      },
      body: {
        model: 'test-model',
        max_tokens: tokens(entry),
        system: 'SYS',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'USER' },
            ...(withImage ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] : [])
          ]
        }],
        ...(withSchema ? { output_config: { format: { type: 'json_schema', schema: ANTHROPIC_TEST_SCHEMA } } } : {})
      }
    };
  }
  const mode = JSON_MODE[entry.id];
  const suffix = withSchema && (mode === 'json_object' || mode === 'prompt') ? SUFFIX : '';
  const body = {
    model: 'test-model',
    messages: [
      { role: 'system', content: `SYS${suffix}` },
      {
        role: 'user',
        content: withImage ? [{ type: 'text', text: 'USER' }, { type: 'image_url', image_url: { url: IMG.dataUrl } }] : 'USER'
      }
    ],
    ...(entry.request.sendTemperature ? { temperature: 0.2 } : {}),
    [entry.request.maxTokensParam]: tokens(entry),
    ...(entry.request.extraBody || {})
  };
  if (withSchema && mode === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: TEST_SCHEMA } };
  }
  if (withSchema && mode === 'json_object') body.response_format = { type: 'json_object' };
  return {
    url: `${baseURL}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body
  };
};

describe('[row 7] request fixtures: every registry entry and region', () => {
  for (const { entry, region, baseURL } of cases) {
    for (const variant of ['text', 'json', 'image']) {
      it(`${entry.id}${region ? ` (${region})` : ''}: ${variant}`, async () => {
        const cfg = await makeCfg(entry.id, { ...(region ? { region } : {}), imagesOverride: true });
        expect(cfg.baseURL).toBe(baseURL);
        const answer = variant === 'json' ? JSON.stringify(VALID_TEST_ANSWER) : 'Hello';
        const fetchMock = mockAnswer(entry.adapter, answer);
        const result = await generate(cfg, {
          ...REQ,
          schema: variant === 'json' ? TEST_SCHEMA : null,
          images: variant === 'image' ? [IMG] : []
        });
        const expected = expectedRequest(entry, baseURL, variant);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(expected.url);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual(expected.headers);
        expect(JSON.parse(init.body)).toEqual(expected.body);
        expect(result.mode).toBe(variant === 'json' ? (JSON_MODE[entry.id] || entry.json) : 'text');
        if (variant === 'json') expect(result.json).toEqual(VALID_TEST_ANSWER);
      });
    }
  }

  it('OpenRouter with structured_outputs metadata adds provider.require_parameters', async () => {
    const modelMeta = { fetchedAt: 1, models: [{ id: 'test-model', images: true, supportedParameters: ['structured_outputs'] }] };
    const cfg = await makeCfg('openrouter', {}, { modelMeta });
    const fetchMock = mockAnswer('openai-style', JSON.stringify(VALID_TEST_ANSWER));
    const result = await generate(cfg, { ...REQ, schema: TEST_SCHEMA });
    const body = bodyOf(fetchMock);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', strict: true, schema: TEST_SCHEMA } });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.messages[0].content).toBe('SYS');
    expect(result.mode).toBe('json_schema');
  });

  it('LM Studio without a key sends no Authorization header', async () => {
    const cfg = await makeCfg('lmstudio', { apiKey: '' });
    const fetchMock = mockAnswer('openai-style', 'Hello');
    await generate(cfg, REQ);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('without thinking the token limit stays as requested; with thinking it is at least 8192', async () => {
    const deepseek = await makeCfg('deepseek');
    let fetchMock = mockAnswer('openai-style', 'Hello');
    await generate(deepseek, { ...REQ, maxOutputTokens: 100 });
    expect(bodyOf(fetchMock).max_tokens).toBe(100);
    const openai = await makeCfg('openai');
    fetchMock = mockAnswer('openai-style', 'Hello');
    await generate(openai, { ...REQ, maxOutputTokens: 10000 });
    expect(bodyOf(fetchMock).max_completion_tokens).toBe(10000);
    fetchMock = mockAnswer('openai-style', 'Hello');
    await generate(openai, { system: 'SYS', userText: 'USER' });
    expect(bodyOf(fetchMock).max_completion_tokens).toBe(8192);
  });

  describe('gemini-nano (no HTTP: create options and prompt input)', () => {
    it('text', async () => {
      const { LanguageModel, sessions } = installLanguageModel({ promptResult: 'Hello' });
      const cfg = await makeCfg('gemini-nano');
      const result = await generate(cfg, REQ);
      expect(result).toMatchObject({ text: 'Hello', mode: 'text', finish: 'stop' });
      expect(LanguageModel.availability).toHaveBeenCalledWith(TEXT_OPTS);
      const createOpts = LanguageModel.create.mock.calls[0][0];
      expect(createOpts).toMatchObject({ ...TEXT_OPTS, initialPrompts: [{ role: 'system', content: 'SYS' }] });
      expect(createOpts.signal).toBeInstanceOf(AbortSignal);
      expect(sessions[0].prompt.mock.calls[0][0]).toBe('USER');
      expect(Object.keys(sessions[0].prompt.mock.calls[0][1])).toEqual(['signal']);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('json', async () => {
      const { sessions } = installLanguageModel({ promptResult: JSON.stringify(VALID_TEST_ANSWER) });
      const cfg = await makeCfg('gemini-nano');
      const result = await generate(cfg, { ...REQ, schema: TEST_SCHEMA });
      expect(result).toMatchObject({ json: VALID_TEST_ANSWER, mode: 'responseConstraint' });
      expect(sessions[0].prompt.mock.calls[0][1].responseConstraint).toEqual(TEST_SCHEMA);
      expect(sessions[0].measureContextUsage.mock.calls[0][1].responseConstraint).toEqual(TEST_SCHEMA);
    });

    it('image', async () => {
      const { LanguageModel, sessions } = installLanguageModel({ promptResult: 'Hello' });
      const cfg = await makeCfg('gemini-nano');
      await generate(cfg, { ...REQ, images: [IMG] });
      expect(LanguageModel.availability).toHaveBeenCalledWith(IMAGE_OPTS);
      expect(LanguageModel.create.mock.calls[0][0]).toMatchObject(IMAGE_OPTS);
      const input = sessions[0].prompt.mock.calls[0][0];
      expect(input[0].role).toBe('user');
      expect(input[0].content[0]).toEqual({ type: 'text', value: 'USER' });
      expect(input[0].content[1].type).toBe('image');
      expect(input[0].content[1].value).toBeInstanceOf(Blob);
    });
  });
});

describe('[row 11] no downgrade', () => {
  for (const entry of PROVIDERS.filter((p) => p.adapter !== 'chrome-nano')) {
    it(`${entry.id}: a 400 in json mode is bad_request, with exactly one fetch`, async () => {
      const cfg = await makeCfg(entry.id);
      const fetchMock = mockFetch(response({ error: 'response_format unsupported' }, { status: 400 }));
      await expect(generate(cfg, { ...REQ, schema: TEST_SCHEMA })).rejects.toMatchObject({ kind: 'bad_request', status: 400 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('[row 16] testConnection', () => {
  it('text: success, including "OK." and " ok! "', async () => {
    const cfg = await makeCfg('gemini');
    for (const answer of ['OK', 'OK.', ' ok! ']) {
      mockAnswer('gemini', answer);
      expect(await testConnection(cfg, { mode: 'text' })).toEqual({ ok: true, mode: 'text', effectiveJsonMode: null });
    }
    const body = bodyOf(globalThis.fetch);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a test.' }] });
    expect(body.contents[0].parts[0].text).toBe('Reply with the single word OK.');
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('text: "not OK" fails', async () => {
    const cfg = await makeCfg('deepseek');
    const fetchMock = mockAnswer('openai-style', 'Not OK');
    const result = await testConnection(cfg, { mode: 'text' });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('invalid_output');
    expect(bodyOf(fetchMock).max_tokens).toBe(16);
  });

  it('text: a server failure is returned, not thrown', async () => {
    const cfg = await makeCfg('openai');
    mockFetch(response({}, { status: 401 }));
    const result = await testConnection(cfg, { mode: 'text' });
    expect(result).toMatchObject({ ok: false, mode: 'text' });
    expect(result.error.kind).toBe('auth');
  });

  it('json: success reports the effective JSON mode', async () => {
    const cfg = await makeCfg('deepseek');
    const fetchMock = mockAnswer('openai-style', JSON.stringify(VALID_TEST_ANSWER));
    expect(await testConnection(cfg, { mode: 'json' })).toEqual({ ok: true, mode: 'json', effectiveJsonMode: 'json_object' });
    const body = bodyOf(fetchMock);
    expect(body.messages[0].content.startsWith('You are a library cataloger.')).toBe(true);
    expect(body.messages[1].content).toContain('book about cats');
  });

  it('json: an invalid answer fails', async () => {
    const cfg = await makeCfg('openai');
    mockAnswer('openai-style', JSON.stringify({ analysis: 'x' }));
    const result = await testConnection(cfg, { mode: 'json' });
    expect(result).toMatchObject({ ok: false, mode: 'json', effectiveJsonMode: null });
    expect(result.error.kind).toBe('invalid_output');
  });

  it('missing configuration → not_configured without any fetch', async () => {
    await expect(resolveConfigFromDraft(entryOf('openai'), { model: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
    const listCfg = await resolveConfigFromDraft(entryOf('openrouter'), { apiKey: KEY }, { purpose: 'list' });
    const result = await testConnection(listCfg, { mode: 'text' });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('not_configured');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('custom tries json_schema → json_object → prompt with a temporary override and saves nothing', async () => {
    const cfg = await makeCfg('custom', { jsonMode: 'json_schema' });
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.response_format?.type === 'json_schema') return response({ error: 'no' }, { status: 400 });
      return response(successBody('openai-style', JSON.stringify(VALID_TEST_ANSWER)));
    });
    globalThis.fetch = fetchMock;
    const setsBefore = fakes.storage.calls.set.length;
    const probe = await probeJsonModes(cfg);
    expect(probe.results.map((r) => [r.jsonMode, r.ok, r.effectiveJsonMode])).toEqual([
      ['json_schema', false, null],
      ['json_object', true, 'json_object'],
      ['prompt', true, 'prompt']
    ]);
    expect(probe.suggested).toBe('json_object');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock, 0).response_format.type).toBe('json_schema');
    expect(bodyOf(fetchMock, 1).response_format).toEqual({ type: 'json_object' });
    expect(bodyOf(fetchMock, 2).response_format).toBeUndefined();
    expect(bodyOf(fetchMock, 2).messages[0].content).toContain('Return only a JSON object');
    expect(cfg.caps.jsonMode).toBe('json_schema');
    expect(fakes.storage.calls.set.length).toBe(setsBefore);
  });

  it('Nano runs text and json through the same generate()', async () => {
    installLanguageModel({ promptResult: 'OK' });
    const cfg = await makeCfg('gemini-nano');
    expect((await testConnection(cfg, { mode: 'text' })).ok).toBe(true);
    fakes.nano.config.promptResult = JSON.stringify(VALID_TEST_ANSWER);
    expect(await testConnection(cfg, { mode: 'json' })).toEqual({ ok: true, mode: 'json', effectiveJsonMode: 'responseConstraint' });
  });
});
