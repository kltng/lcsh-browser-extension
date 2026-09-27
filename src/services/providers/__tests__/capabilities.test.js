import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities, getProviderEntry, regionFor, modelMetaKey, baseURLFor, findModelMeta, allModelMetaKeys
} from '../capabilities';
import { PROVIDERS } from '../registry';

const caps = (id, settings = {}, meta = null) => resolveCapabilities(getProviderEntry(id), settings, meta);

describe('[row 4] capabilities: json', () => {
  it('fixed json values pass through unchanged', () => {
    const fixed = { openai: 'json_schema', gemini: 'responseSchema', anthropic: 'output_config', deepseek: 'json_object', qwen: 'json_object', zhipu: 'json_object', moonshot: 'json_schema', minimax: 'prompt', 'gemini-nano': 'responseConstraint' };
    for (const [id, mode] of Object.entries(fixed)) {
      expect(caps(id).jsonMode, id).toBe(mode);
      expect(caps(id).openrouterRequireParameters).toBe(false);
    }
  });

  it('OpenRouter: structured_outputs → json_schema with require_parameters', () => {
    const c = caps('openrouter', {}, { id: 'm', images: true, supportedParameters: ['structured_outputs', 'response_format'] });
    expect(c.jsonMode).toBe('json_schema');
    expect(c.openrouterRequireParameters).toBe(true);
  });

  it('OpenRouter: only response_format → json_object', () => {
    const c = caps('openrouter', {}, { id: 'm', images: false, supportedParameters: ['response_format', 'temperature'] });
    expect(c.jsonMode).toBe('json_object');
    expect(c.openrouterRequireParameters).toBe(false);
  });

  it('OpenRouter: neither, or no metadata → prompt', () => {
    expect(caps('openrouter', {}, { id: 'm', images: null, supportedParameters: ['temperature'] }).jsonMode).toBe('prompt');
    expect(caps('openrouter', {}, null).jsonMode).toBe('prompt');
  });

  it('user-choice uses jsonMode, default json_schema', () => {
    for (const id of ['custom', 'lmstudio']) {
      expect(caps(id).jsonMode).toBe('json_schema');
      expect(caps(id, { jsonMode: 'json_object' }).jsonMode).toBe('json_object');
      expect(caps(id, { jsonMode: 'prompt' }).jsonMode).toBe('prompt');
    }
  });
});

describe('[row 4] capabilities: images', () => {
  it('yes → true (known)', () => {
    for (const id of ['openai', 'gemini', 'anthropic']) expect(caps(id)).toMatchObject({ images: true, imagesKnown: true });
  });

  it('DeepSeek and Moonshot metadata decide images', () => {
    expect(caps('deepseek', {}, { id: 'deepseek-flash', images: true })).toMatchObject({ images: true, imagesKnown: true });
    expect(caps('deepseek', {}, { id: 'deepseek-v4-pro', images: false })).toMatchObject({ images: false, imagesKnown: true });
    expect(caps('moonshot', {}, { id: 'kimi-k3', images: true })).toMatchObject({ images: true, imagesKnown: true });
  });

  it('a hand-typed model (no metadata) → unknown → images false', () => {
    expect(caps('deepseek', {}, null)).toMatchObject({ images: false, imagesKnown: false });
    const meta = { fetchedAt: 1, models: [{ id: 'deepseek-flash', images: true }] };
    expect(findModelMeta(meta, 'typed-by-hand')).toBeNull();
    expect(caps('deepseek', {}, findModelMeta(meta, 'typed-by-hand'))).toMatchObject({ images: false, imagesKnown: false });
    expect(caps('openrouter', {}, { id: 'x', images: null })).toMatchObject({ images: false, imagesKnown: false });
  });

  it('unknown stays unknown; imagesOverride:true turns images on', () => {
    for (const id of ['qwen', 'zhipu', 'minimax', 'lmstudio', 'custom']) {
      expect(caps(id)).toMatchObject({ images: false, imagesKnown: false });
      expect(caps(id, { imagesOverride: true })).toMatchObject({ images: true, imagesKnown: false });
      expect(caps(id, { imagesOverride: 'yes' })).toMatchObject({ images: false });
    }
    expect(caps('deepseek', { imagesOverride: true }, null)).toMatchObject({ images: true });
    // Known metadata wins over the override.
    expect(caps('deepseek', { imagesOverride: true }, { id: 'p', images: false })).toMatchObject({ images: false, imagesKnown: true });
  });

  it('nano-availability uses the availability result passed as metadata', () => {
    expect(caps('gemini-nano', {}, { images: true })).toMatchObject({ images: true, imagesKnown: true });
    expect(caps('gemini-nano', {}, { images: false })).toMatchObject({ images: false, imagesKnown: true });
  });
});

describe('[row 4] capabilities: request fields', () => {
  it('OpenAI temperature is omitted (sendTemperature false)', () => {
    expect(caps('openai').sendTemperature).toBe(false);
    expect(caps('openai').maxTokensParam).toBe('max_completion_tokens');
  });

  it('copies request and answer fields from the registry', () => {
    for (const entry of PROVIDERS) {
      const c = resolveCapabilities(entry, {}, null);
      expect(c.sendTemperature).toBe(entry.request.sendTemperature);
      expect(c.maxTokensParam).toBe(entry.request.maxTokensParam);
      expect(c.extraBody).toEqual(entry.request.extraBody);
      expect(c.thinkingOn).toBe(entry.request.thinkingOn);
      expect(c.stripThinkTags).toBe(entry.answer.stripThinkTags);
    }
  });
});

describe('[row 4] capabilities: regions and URLs', () => {
  it('regionFor honors selectable regions only', () => {
    expect(regionFor(getProviderEntry('qwen'), { region: 'cn' })).toBe('cn');
    expect(regionFor(getProviderEntry('qwen'), {})).toBe('intl');
    expect(regionFor(getProviderEntry('openai'), { region: 'cn' })).toBe('intl');
    expect(regionFor(getProviderEntry('custom'), {})).toBeNull();
  });

  it('modelMetaKey and the list of keys', () => {
    expect(modelMetaKey('qwen', 'cn')).toBe('modelMeta:qwen:cn');
    expect(modelMetaKey('custom', null)).toBe('modelMeta:custom:default');
    expect(allModelMetaKeys()).toContain('modelMeta:moonshot:cn');
    expect(allModelMetaKeys()).toContain('modelMeta:gemini-nano:default');
  });

  it('baseURLFor uses the region, or the validated user URL', () => {
    expect(baseURLFor(getProviderEntry('moonshot'), { region: 'cn' })).toEqual({ ok: true, url: 'https://api.moonshot.cn/v1' });
    expect(baseURLFor(getProviderEntry('lmstudio'), {})).toEqual({ ok: true, url: 'http://localhost:1234/v1' });
    expect(baseURLFor(getProviderEntry('lmstudio'), { baseURL: 'http://127.0.0.1:9000/v1/' })).toEqual({ ok: true, url: 'http://127.0.0.1:9000/v1' });
    expect(baseURLFor(getProviderEntry('custom'), {})).toMatchObject({ ok: false, missing: true });
    expect(baseURLFor(getProviderEntry('custom'), { baseURL: 'http://example.com/v1' })).toMatchObject({ ok: false, missing: false });
    expect(baseURLFor(getProviderEntry('gemini-nano'), {})).toEqual({ ok: true, url: null });
  });
});
