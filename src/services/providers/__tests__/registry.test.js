import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from '../registry';
import { originFor } from '../permissions';

const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'manifest.json'), 'utf8'));

const FIELDS = ['id', 'name', 'adapter', 'regions', 'defaultRegion', 'regionSelectable', 'keyRequired',
  'keyHelpUrl', 'defaultModel', 'request', 'json', 'images', 'answer', 'models'];

const req = (maxTokensParam, sendTemperature, extraBody, thinkingOn) => ({ maxTokensParam, sendTemperature, extraBody, thinkingOn });

// The §3.2 table, row by row.
const EXPECTED = {
  openai: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://api.openai.com/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://platform.openai.com/api-keys', defaultModel: null, request: req('max_completion_tokens', false, null, true), json: 'json_schema', images: 'yes', answer: { stripThinkTags: false }, models: 'openai-list' },
  gemini: { adapter: 'gemini', regions: { intl: { baseURL: 'https://generativelanguage.googleapis.com/v1beta' } }, keyRequired: 'yes', keyHelpUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-2.5-flash', request: req('maxOutputTokens', true, null, true), json: 'responseSchema', images: 'yes', answer: { stripThinkTags: false }, models: 'gemini-paged' },
  anthropic: { adapter: 'anthropic', regions: { intl: { baseURL: 'https://api.anthropic.com/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-sonnet-5', request: req('max_tokens', false, null, true), json: 'output_config', images: 'yes', answer: { stripThinkTags: false }, models: 'anthropic-paged' },
  deepseek: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://api.deepseek.com' } }, keyRequired: 'yes', keyHelpUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-flash', request: req('max_tokens', true, { thinking: { type: 'disabled' } }, false), json: 'json_object', images: 'from-model-meta', answer: { stripThinkTags: false }, models: 'openai-list' },
  qwen: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, cn: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://modelstudio.console.alibabacloud.com/', defaultModel: 'qwen3.7-plus', request: req('max_tokens', true, { enable_thinking: false }, false), json: 'json_object', images: 'unknown', answer: { stripThinkTags: true }, models: 'none' },
  zhipu: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://api.z.ai/api/paas/v4' }, cn: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' } }, keyRequired: 'yes', keyHelpUrl: 'https://z.ai/manage-apikey/apikey-list', defaultModel: 'glm-5.3', request: req('max_tokens', true, null, true), json: 'json_object', images: 'unknown', answer: { stripThinkTags: true }, models: 'none' },
  moonshot: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://api.moonshot.ai/v1' }, cn: { baseURL: 'https://api.moonshot.cn/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://platform.kimi.ai/console/api-keys', defaultModel: 'kimi-k3', request: req('max_completion_tokens', true, null, true), json: 'json_schema', images: 'from-model-meta', answer: { stripThinkTags: true }, models: 'openai-list' },
  minimax: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://api.minimax.io/v1' }, cn: { baseURL: 'https://api.minimax.cn/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', defaultModel: 'MiniMax-M3', request: req('max_completion_tokens', true, { reasoning_split: true }, true), json: 'prompt', images: 'unknown', answer: { stripThinkTags: true }, models: 'openai-list' },
  openrouter: { adapter: 'openai-style', regions: { intl: { baseURL: 'https://openrouter.ai/api/v1' } }, keyRequired: 'yes', keyHelpUrl: 'https://openrouter.ai/keys', defaultModel: null, request: req('max_tokens', true, null, true), json: 'from-model-meta', images: 'from-model-meta', answer: { stripThinkTags: true }, models: 'openai-list' },
  lmstudio: { adapter: 'openai-style', regions: { intl: { baseURL: 'http://localhost:1234/v1' } }, keyRequired: 'no', keyHelpUrl: null, defaultModel: null, request: req('max_tokens', true, null, true), json: 'user-choice', images: 'unknown', answer: { stripThinkTags: true }, models: 'openai-list' },
  custom: { adapter: 'openai-style', regions: null, keyRequired: 'optional', keyHelpUrl: null, defaultModel: null, request: req('max_tokens', true, null, true), json: 'user-choice', images: 'unknown', answer: { stripThinkTags: true }, models: 'openai-list' },
  'gemini-nano': { adapter: 'chrome-nano', regions: null, keyRequired: 'no', keyHelpUrl: null, defaultModel: 'gemini-nano', request: req(null, false, null, false), json: 'responseConstraint', images: 'nano-availability', answer: { stripThinkTags: false }, models: 'fixed-nano' }
};

const SELECTABLE = ['qwen', 'zhipu', 'moonshot', 'minimax'];

describe('[row 3] registry', () => {
  it('has exactly the §3.2 providers, in table order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(Object.keys(EXPECTED));
  });

  it.each(PROVIDERS.map((p) => [p.id, p]))('%s has every §3.1 field with the §3.2 value', (id, entry) => {
    expect(Object.keys(entry).sort()).toEqual([...FIELDS].sort());
    expect(typeof entry.name).toBe('string');
    for (const [field, value] of Object.entries(EXPECTED[id])) {
      expect(entry[field], `${id}.${field}`).toEqual(value);
    }
    expect(entry.defaultRegion).toBe(entry.regions ? 'intl' : null);
    expect(entry.regionSelectable).toBe(SELECTABLE.includes(id));
  });

  it('every region URL is https except the LM Studio loopback default', () => {
    for (const entry of PROVIDERS) {
      for (const [region, { baseURL }] of Object.entries(entry.regions || {})) {
        if (entry.id === 'lmstudio') expect(baseURL).toBe('http://localhost:1234/v1');
        else expect(new URL(baseURL).protocol, `${entry.id}.${region}`).toBe('https:');
      }
    }
  });

  it('every region origin is in the manifest (optional, or required for Gemini)', () => {
    const optional = manifest.optional_host_permissions;
    for (const entry of PROVIDERS) {
      for (const { baseURL } of Object.values(entry.regions || {})) {
        const origin = originFor({ entry, baseURL });
        if (entry.id === 'gemini') expect(manifest.host_permissions).toContain(origin);
        else expect(optional).toContain(origin);
      }
    }
    for (const extra of ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']) expect(optional).toContain(extra);
    expect(manifest.host_permissions).toContain('https://id.loc.gov/*');
    // P5 §10: `unlimitedStorage` protects the local database from eviction.
    expect(manifest.permissions).toEqual(['storage', 'unlimitedStorage']);
    expect(manifest.content_security_policy.extension_pages)
      .toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
  });
});

describe('[P4 row 16] P3 queued fixes: the manifest', () => {
  it('the optional list lacks the Gemini origin (it is a required host permission; no duplicate)', () => {
    expect(manifest.optional_host_permissions).not.toContain('https://generativelanguage.googleapis.com/*');
    expect(manifest.host_permissions).toContain('https://generativelanguage.googleapis.com/*');
    const both = manifest.optional_host_permissions.filter((o) => manifest.host_permissions.includes(o));
    expect(both).toEqual([]);
  });

  it('the new description', () => {
    expect(manifest.description).toBe('Suggests Library of Congress Subject Headings with your choice of AI provider');
  });
});
