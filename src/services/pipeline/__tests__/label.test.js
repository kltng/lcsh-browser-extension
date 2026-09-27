import { describe, it, expect } from 'vitest';
import { describeActiveProvider, providerLabel } from '../label';
import { fakes } from '../../../../test/setup';
import { KEY } from '../../../../test/fixtures';

const configure = (active, providers) => {
  fakes.storage.seed({
    settingsVersion: 2,
    activeProviderId: active,
    lookupBackend: 'loc-api',
    ...Object.fromEntries(Object.entries(providers).map(([id, value]) => [`provider:${id}`, value]))
  });
};

describe('[P4 row17] moved helpers: label (from legacyBridge)', () => {
  it('describes the active provider for the workflow label (P3 bridge test)', async () => {
    configure('deepseek', { deepseek: { apiKey: KEY } });
    expect(await describeActiveProvider()).toBe('Using DeepSeek · deepseek-flash');
  });

  it('a stored model wins; a provider without a default model says so', async () => {
    configure('gemini', { gemini: { apiKey: KEY, model: ' gemini-3.8-flash ' } });
    expect(await describeActiveProvider()).toBe('Using Google Gemini · gemini-3.8-flash');
    expect(providerLabel('openai', {})).toBe('Using OpenAI · no model chosen');
  });
});
