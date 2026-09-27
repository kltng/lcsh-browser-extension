import { describe, it, expect, vi } from 'vitest';
import { fakes, flushEvents } from '../../../test/setup';

// A fresh AppContext (and settings) module, as when the app page opens.
const openApp = async () => {
  vi.resetModules();
  return import('../AppContext');
};

describe('[row 25] settings readiness failure: initAppSettings (UI behavior: live verification owned by the lead)', () => {
  it('storage.get rejects during ready() → initAppSettings returns an error result instead of throwing', async () => {
    fakes.storage.failNext('get', new Error('storage broken'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initAppSettings, SETTINGS_LOAD_ERROR } = await openApp();
    const result = await initAppSettings('default rules');
    expect(result).toEqual({ ok: false, message: SETTINGS_LOAD_ERROR });
    expect(SETTINGS_LOAD_ERROR).toMatch(/^Settings could not be loaded/);
    expect(errorSpy).toHaveBeenCalledWith('Failed to load settings');
  });

  it('a working storage loads (and first stores) the default rules', async () => {
    const { initAppSettings } = await openApp();
    expect(await initAppSettings('default rules')).toEqual({ ok: true, systemPromptRules: 'default rules' });
    expect(fakes.storage.data.get('systemPromptRules')).toBe('default rules');
  });

  it('stored rules win over the default', async () => {
    fakes.storage.seed({ systemPromptRules: 'my rules' });
    const { initAppSettings } = await openApp();
    expect(await initAppSettings('default rules')).toEqual({ ok: true, systemPromptRules: 'my rules' });
  });
});

describe('fix-1 #9a: the storage fake models the callback form used by the history code', () => {
  it('get/set/remove with callbacks, and chrome.runtime.lastError during a failed callback', async () => {
    const got = await new Promise((resolve) => chrome.storage.local.set({ conversationHistory: [{ id: 1 }] }, () => {
      chrome.storage.local.get(['conversationHistory'], resolve);
    }));
    expect(got).toEqual({ conversationHistory: [{ id: 1 }] });
    fakes.storage.failNext('set', new Error('QUOTA_BYTES quota exceeded'));
    const lastError = await new Promise((resolve) => chrome.storage.local.set({ conversationHistory: [] }, () => {
      resolve(chrome.runtime.lastError);
    }));
    expect(lastError).toEqual({ message: 'QUOTA_BYTES quota exceeded' });
    expect(chrome.runtime.lastError).toBeNull();
    await new Promise((resolve) => chrome.storage.local.remove(['conversationHistory'], resolve));
    expect(fakes.storage.data.has('conversationHistory')).toBe(false);
  });

  it('onChanged is delivered after the write completes, not inside it', async () => {
    const seen = [];
    chrome.storage.onChanged.addListener((changes) => seen.push(Object.keys(changes)));
    await chrome.storage.local.set({ systemPromptRules: 'x' });
    expect(seen).toEqual([]);
    await flushEvents();
    expect(seen).toEqual([['systemPromptRules']]);
  });
});
