import { describe, it, expect } from 'vitest';
import { originFor, validateBaseURL, hasAccess, requestAccess, ensureAccess } from '../permissions';
import { generate } from '../index';
import { fakes, installLanguageModel } from '../../../../test/setup';
import { entryOf, makeCfg } from '../../../../test/fixtures';

describe('[row 14] permissions: originFor', () => {
  it('is the base URL origin plus /*', () => {
    expect(originFor({ entry: entryOf('openai'), baseURL: 'https://api.openai.com/v1' })).toBe('https://api.openai.com/*');
    expect(originFor({ entry: entryOf('lmstudio'), baseURL: 'http://localhost:1234/v1' })).toBe('http://localhost:1234/*');
    expect(originFor({ entry: entryOf('qwen'), baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe('https://dashscope.aliyuncs.com/*');
  });

  it('is null for Nano', () => {
    expect(originFor({ entry: entryOf('gemini-nano'), baseURL: null })).toBeNull();
  });
});

describe('[row 14] permissions: validateBaseURL', () => {
  it.each([
    ['https://llm.example.com/v1', 'https://llm.example.com/v1'],
    ['https://llm.example.com/v1/', 'https://llm.example.com/v1'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['  https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1  ', 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']
  ])('accepts %s', (input, url) => {
    expect(validateBaseURL(input)).toEqual({ ok: true, url });
  });

  it.each([
    [''],
    ['not a url'],
    ['ftp://example.com/v1'],
    ['http://example.com/v1'],
    ['http://192.168.1.5:1234/v1'],
    ['http://[::1]:1234/v1'],
    ['https://[::1]/v1'],
    ['https://user:pass@example.com/v1'],
    ['https://user@example.com/v1'],
    ['https://example.com/v1?key=abc'],
    ['https://example.com/v1?'],
    ['https://example.com/v1#frag'],
    ['javascript:alert(1)'],
    ['file:///etc/passwd']
  ])('rejects %s', (input) => {
    const result = validateBaseURL(input);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});

describe('[row 14] permissions: access checks', () => {
  it('hasAccess and requestAccess use chrome.permissions', async () => {
    expect(await hasAccess('https://api.openai.com/*')).toBe(false);
    expect(await requestAccess('https://api.openai.com/*')).toBe(true);
    expect(fakes.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(await hasAccess('https://api.openai.com/*')).toBe(true);
  });

  it('ensureAccess throws a permission error when not granted', async () => {
    const cfg = await makeCfg('openai', {}, { grant: false });
    await expect(ensureAccess(cfg)).rejects.toMatchObject({ kind: 'permission' });
    await expect(generate(cfg, { system: 's', userText: 'u' })).rejects.toMatchObject({
      kind: 'permission',
      message: 'Chrome needs your permission to contact api.openai.com. Open Settings and click Grant access.'
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('Nano skips permissions entirely', async () => {
    installLanguageModel({ promptResult: 'Hello' });
    const cfg = await makeCfg('gemini-nano', {}, { grant: false });
    await ensureAccess(cfg);
    const result = await generate(cfg, { system: 's', userText: 'u' });
    expect(result.text).toBe('Hello');
    expect(fakes.permissions.contains).not.toHaveBeenCalled();
    expect(fakes.permissions.request).not.toHaveBeenCalled();
  });
});
