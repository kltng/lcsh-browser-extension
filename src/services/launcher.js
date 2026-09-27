/**
 * Popup launcher logic (SPEC-P3 §6): the one status line and tab reuse.
 */
import { getSettings } from './settings';
import { getProviderEntry, baseURLFor } from './providers/capabilities';
import { originFor, hasAccess } from './providers/permissions';
import { TEXT_OPTS, hasNanoApi, nanoAvailability } from './providers/geminiNano';

/** Status labels, in precedence order. */
export const LAUNCHER_STATUS = {
  error: 'Settings could not be loaded',
  noModel: 'Choose a model',
  noKey: 'API key missing',
  noAddress: 'Server address missing',
  permission: 'Permission needed',
  nanoUnavailable: 'Not available',
  nanoDownload: 'Download needed',
  ready: 'Ready'
};

/**
 * Compute the popup's status for the active provider.
 * @returns {Promise<{status:string, label:string, providerName:string|null, model:string|null}>}
 */
export const computeLauncherStatus = async () => {
  const result = (status, extra = {}) => ({
    status, label: LAUNCHER_STATUS[status], providerName: null, model: null, ...extra
  });
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    return result('error');
  }
  const entry = getProviderEntry(settings.activeProviderId);
  if (!entry) return result('error');
  const stored = settings.providers[entry.id] || {};
  const typedModel = typeof stored.model === 'string' ? stored.model.trim() : '';
  const model = entry.adapter === 'chrome-nano' ? entry.defaultModel : (typedModel || entry.defaultModel || null);
  const info = { providerName: entry.name, model };

  if (!model) return result('noModel', info);
  if (entry.keyRequired === 'yes' && !(typeof stored.apiKey === 'string' && stored.apiKey.trim())) {
    return result('noKey', info);
  }
  const base = baseURLFor(entry, stored);
  if (!base.ok) return result('noAddress', info);
  const origin = originFor({ entry, baseURL: base.url });
  if (origin) {
    let granted = false;
    try {
      granted = await hasAccess(origin);
    } catch (e) {
      granted = false;
    }
    if (!granted) return result('permission', info);
  }
  if (entry.adapter === 'chrome-nano') {
    if (!hasNanoApi()) return result('nanoUnavailable', info);
    const state = await nanoAvailability(TEXT_OPTS);
    if (state === 'downloadable' || state === 'downloading') return result('nanoDownload', info);
    if (state !== 'available') return result('nanoUnavailable', info);
  }
  return result('ready', info);
};

/**
 * Open the app, reusing an existing app tab when there is one.
 * @param {{settings?:boolean}} [opts] - Open the Settings screen (`#settings`)
 * @returns {Promise<void>}
 */
export const openAppTab = async ({ settings = false } = {}) => {
  const base = chrome.runtime.getURL('app.html');
  const target = settings ? `${base}#settings` : base;
  let contexts = [];
  try {
    contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [base, `${base}#settings`, `${base}#`]
    });
  } catch (e) {
    contexts = [];
  }
  const existing = contexts.find((c) => typeof c.tabId === 'number' && c.tabId >= 0);
  if (existing) {
    try {
      // Same document: only focus it (setting the same URL would reload the page and lose work).
      // Otherwise navigate by fragment only (`app.html#` / `app.html#settings`), which never reloads.
      const current = existing.documentUrl || '';
      const alreadyThere = settings ? current === target : (current === base || current === `${base}#`);
      const update = alreadyThere ? { active: true } : { active: true, url: settings ? target : `${base}#` };
      await chrome.tabs.update(existing.tabId, update);
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    } catch (e) {
      // The tab was closed meanwhile: open a new one below.
    }
  }
  await chrome.tabs.create({ url: target });
};
