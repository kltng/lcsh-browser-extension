import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { fakes, installLanguageModel } from '../../../test/setup';
import { KEY } from '../../../test/fixtures';

// A fresh launcher (and settings) module, as when the popup opens.
const openPopup = async () => {
  vi.resetModules();
  return import('../launcher');
};

const configure = (active, providers = {}) => {
  fakes.storage.seed({
    settingsVersion: 2,
    activeProviderId: active,
    lookupBackend: 'loc-api',
    ...Object.fromEntries(Object.entries(providers).map(([id, value]) => [`provider:${id}`, value]))
  });
};

const BASE = 'chrome-extension://testid/app.html';

describe('[row 25] settings readiness failure: popup status and static PopupView markup (UI behavior: live verification owned by the lead)', () => {
  it('storage.get rejects during ready() → computeLauncherStatus returns "Settings could not be loaded"', async () => {
    fakes.storage.failNext('get', new Error('storage broken'));
    const { computeLauncherStatus } = await openPopup();
    const status = await computeLauncherStatus();
    expect(status).toMatchObject({ status: 'error', label: 'Settings could not be loaded' });
  });

  it('PopupView rendered to static HTML with the error state: error text, Open disabled, Settings enabled', { timeout: 20000 }, async () => {
    vi.resetModules();
    const { PopupView } = await import('../../components/PopupLauncher');
    const html = renderToString(React.createElement(PopupView, {
      state: { status: 'error', label: 'Settings could not be loaded', providerName: null, model: null },
      onOpen: () => {},
      onSettings: () => {}
    }));
    expect(html).toContain('Settings could not be loaded');
    const buttons = html.split('<button').slice(1);
    const open = buttons.find((b) => b.includes('Open LCSH Tool'));
    const settings = buttons.find((b) => b.includes('>Settings<'));
    expect(open).toContain('disabled');
    expect(settings).not.toContain('disabled=""');
  });
});

describe('[row 25] popup status precedence (§6)', () => {
  it('"Choose a model" comes before "API key missing"', async () => {
    configure('openai', {});
    const { computeLauncherStatus } = await openPopup();
    expect(await computeLauncherStatus()).toMatchObject({ status: 'noModel', label: 'Choose a model', providerName: 'OpenAI', model: null });
  });

  it('"API key missing"', async () => {
    configure('deepseek', {});
    const { computeLauncherStatus } = await openPopup();
    expect(await computeLauncherStatus()).toMatchObject({ label: 'API key missing', model: 'deepseek-flash' });
  });

  it('"Server address missing" (custom)', async () => {
    configure('custom', { custom: { model: 'm' } });
    const { computeLauncherStatus } = await openPopup();
    expect((await computeLauncherStatus()).label).toBe('Server address missing');
  });

  it('"Permission needed", then "Ready" once granted', async () => {
    configure('gemini', { gemini: { apiKey: KEY } });
    const { computeLauncherStatus } = await openPopup();
    expect((await computeLauncherStatus()).label).toBe('Permission needed');
    fakes.permissions.granted.add('https://generativelanguage.googleapis.com/*');
    expect(await computeLauncherStatus()).toMatchObject({ status: 'ready', label: 'Ready', model: 'gemini-2.5-flash' });
  });

  it('Nano: "Not available", "Download needed", "Ready" (no permission check)', async () => {
    configure('gemini-nano', {});
    const { computeLauncherStatus } = await openPopup();
    expect((await computeLauncherStatus()).label).toBe('Not available');
    installLanguageModel({ availability: { text: 'downloadable', image: 'unavailable' } });
    expect((await computeLauncherStatus()).label).toBe('Download needed');
    fakes.nano.config.availability.text = 'unavailable';
    expect((await computeLauncherStatus()).label).toBe('Not available');
    fakes.nano.config.availability.text = 'available';
    expect((await computeLauncherStatus()).label).toBe('Ready');
    expect(fakes.permissions.contains).not.toHaveBeenCalled();
  });
});

describe('popup: opening the app', () => {
  it('queries app tabs, including #settings', async () => {
    const { openAppTab } = await openPopup();
    await openAppTab();
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['TAB'],
      documentUrls: [BASE, `${BASE}#settings`, `${BASE}#`]
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: BASE });
  });

  it('reuses an existing app tab and focuses its window (no reload of the same page)', async () => {
    fakes.contexts.push({ contextType: 'TAB', tabId: 5, windowId: 2, documentUrl: BASE });
    const { openAppTab } = await openPopup();
    await openAppTab();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('Settings navigates the existing tab to #settings', async () => {
    fakes.contexts.push({ contextType: 'TAB', tabId: 5, windowId: 2, documentUrl: BASE });
    const { openAppTab } = await openPopup();
    await openAppTab({ settings: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { active: true, url: `${BASE}#settings` });
  });

  it('from #settings back to the workflow by fragment only', async () => {
    fakes.contexts.push({ contextType: 'TAB', tabId: 7, windowId: 3, documentUrl: `${BASE}#settings` });
    const { openAppTab } = await openPopup();
    await openAppTab();
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true, url: `${BASE}#` });
  });

  it('creates a new tab when the old one was closed meanwhile', async () => {
    fakes.contexts.push({ contextType: 'TAB', tabId: 5, windowId: 2, documentUrl: BASE });
    chrome.tabs.update.mockRejectedValueOnce(new Error('No tab with id: 5'));
    const { openAppTab } = await openPopup();
    await openAppTab({ settings: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${BASE}#settings` });
  });
});
