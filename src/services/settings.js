/**
 * Settings storage, cross-page locking and migration (SPEC-P3 §2).
 *
 * Every read-modify-write runs inside the 'lcsh-settings' Web Lock, which is
 * shared by every page of the extension origin. Plain reads take no lock.
 * Locked functions never call other locked public functions, and ready() is
 * awaited BEFORE a lock is requested.
 */
import { PROVIDERS } from './providers/registry';
import { allModelMetaKeys } from './providers/capabilities';

export const SETTINGS_VERSION = 2;
export const DEFAULT_PROVIDER_ID = 'gemini';
export const DEFAULT_LOOKUP_BACKEND = 'loc-api';
const LOCK_NAME = 'lcsh-settings';
const LEGACY_KEY = 'geminiApiKey';

/**
 * Storage key of one provider's settings.
 * @param {string} id - Provider id
 * @returns {string}
 */
export const providerKey = (id) => `provider:${id}`;

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
const FIXED_KEYS = ['settingsVersion', 'activeProviderId', 'systemPromptRules', 'lookupBackend'];

const storage = () => chrome.storage.local;
const withLock = (fn) => navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, fn);

const isSettingsKey = (key) => FIXED_KEYS.includes(key)
  || key.startsWith('provider:') || key.startsWith('modelMeta:');

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/**
 * Remove empty fields (``, null, undefined) from a provider value.
 * @param {object} value - Provider settings
 * @returns {object}
 */
export const cleanProviderValue = (value = {}) => {
  const out = {};
  for (const [key, v] of Object.entries(value || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
};

/**
 * Whether two provider values are the same (missing = empty object).
 * @param {object|undefined} a - First value
 * @param {object|undefined} b - Second value
 * @returns {boolean}
 */
export const sameProviderValue = (a, b) => stableStringify(cleanProviderValue(a)) === stableStringify(cleanProviderValue(b));

const assertProviderId = (id) => {
  if (!PROVIDER_IDS.has(id)) throw new Error(`Unknown provider: ${id}`);
};

/**
 * Migrate the v1.1.0 `geminiApiKey` into `provider:gemini` (inside the lock).
 * Safe to run any number of times, from any number of pages.
 * @returns {Promise<void>}
 */
export const migrateLegacy = () => withLock(async () => {
  const gKey = providerKey('gemini');
  const current = await storage().get([LEGACY_KEY, gKey, 'activeProviderId', 'settingsVersion', 'lookupBackend']);
  const legacy = current[LEGACY_KEY];
  const writes = {};
  if (typeof legacy === 'string' && legacy.trim()) {
    const gemini = current[gKey] || {};
    if (!gemini.apiKey) writes[gKey] = { ...gemini, apiKey: legacy.trim() };
  }
  if (!current.activeProviderId) writes.activeProviderId = DEFAULT_PROVIDER_ID;
  if (!current.lookupBackend) writes.lookupBackend = DEFAULT_LOOKUP_BACKEND;
  if (current.settingsVersion !== SETTINGS_VERSION) writes.settingsVersion = SETTINGS_VERSION;
  if (Object.keys(writes).length > 0) await storage().set(writes);

  if (legacy === undefined) return;
  const back = await storage().get([gKey]);
  if (back[gKey]?.apiKey) {
    try {
      await storage().remove(LEGACY_KEY);
    } catch (e) {
      // The next start repeats the migration, which then only removes the key.
      console.error('[settings] could not remove the legacy key entry');
    }
  }
});

let readyPromise = null;

/**
 * Resolves after migrateLegacy() completes. Every caller awaits it.
 * A failure is not cached, so a later call tries again.
 * @returns {Promise<void>}
 */
export const ready = () => {
  if (!readyPromise) {
    readyPromise = migrateLegacy().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
};

/**
 * Merged view of all settings, with defaults.
 * @returns {Promise<{settingsVersion:number, activeProviderId:string, providers:Object<string,object>,
 *   modelMeta:Object<string,object>, systemPromptRules:string|null, lookupBackend:string}>}
 */
export const getSettings = async () => {
  await ready();
  const metaKeys = allModelMetaKeys();
  const keys = [...FIXED_KEYS, ...PROVIDERS.map((p) => providerKey(p.id)), ...metaKeys];
  const all = await storage().get(keys);
  const providers = {};
  for (const p of PROVIDERS) providers[p.id] = all[providerKey(p.id)] || {};
  const modelMeta = {};
  for (const key of metaKeys) {
    if (all[key]) modelMeta[key] = all[key];
  }
  const activeProviderId = PROVIDER_IDS.has(all.activeProviderId) ? all.activeProviderId : DEFAULT_PROVIDER_ID;
  return {
    settingsVersion: all.settingsVersion ?? SETTINGS_VERSION,
    activeProviderId,
    providers,
    modelMeta,
    systemPromptRules: typeof all.systemPromptRules === 'string' ? all.systemPromptRules : null,
    lookupBackend: all.lookupBackend || DEFAULT_LOOKUP_BACKEND
  };
};

/**
 * Locked read-modify-write: patch keys replace, the other keys are kept.
 * @param {string} id - Provider id
 * @param {object} patch - Fields to replace
 * @returns {Promise<object>} - The stored value
 */
export const updateProvider = async (id, patch) => {
  assertProviderId(id);
  await ready();
  return withLock(async () => {
    const key = providerKey(id);
    const current = (await storage().get([key]))[key] || {};
    const next = cleanProviderValue({ ...current, ...patch });
    await storage().set({ [key]: next });
    return next;
  });
};

/**
 * Locked write of the active provider.
 * @param {string} id - Provider id
 * @returns {Promise<void>}
 */
export const setActiveProvider = async (id) => {
  assertProviderId(id);
  await ready();
  return withLock(async () => {
    await storage().set({ activeProviderId: id });
  });
};

const saveIfFresh = async (id, draft, base, activate) => {
  assertProviderId(id);
  await ready();
  return withLock(async () => {
    const key = providerKey(id);
    const current = (await storage().get([key]))[key];
    if (!sameProviderValue(current, base)) return { saved: false, reason: 'stale' };
    const next = cleanProviderValue({ ...(current || {}), ...draft });
    await storage().set(activate ? { [key]: next, activeProviderId: id } : { [key]: next });
    return { saved: true, value: next };
  });
};

/**
 * Locked save of a Settings form draft. Writes nothing when the stored value
 * no longer equals `base` (the value the form was loaded from).
 * @param {string} id - Provider id
 * @param {object} draft - The form's draft
 * @param {object} base - The stored value the form was loaded from
 * @returns {Promise<{saved:true, value:object}|{saved:false, reason:'stale'}>}
 */
export const saveProviderDraft = (id, draft, base) => saveIfFresh(id, draft, base, false);

/**
 * Like saveProviderDraft, and also makes the provider active, in ONE write.
 * @param {string} id - Provider id
 * @param {object} draft - The form's draft
 * @param {object} base - The stored value the form was loaded from
 * @returns {Promise<{saved:true, value:object}|{saved:false, reason:'stale'}>}
 */
export const saveProviderAndActivate = (id, draft, base) => saveIfFresh(id, draft, base, true);

/**
 * Store a model list in the metadata cache (written by listModels()).
 * @param {string} key - `modelMeta:<id>:<region|default>`
 * @param {{fetchedAt:number, models:object[]}} value - Normalized list
 * @returns {Promise<void>}
 */
export const saveModelMeta = async (key, value) => {
  if (!key.startsWith('modelMeta:')) throw new Error('Not a model metadata key');
  await ready();
  return withLock(async () => {
    await storage().set({ [key]: value });
  });
};

/**
 * Read the stored rules, writing the default first if none is stored (locked).
 * @param {string} defaultRules - Default rules text
 * @returns {Promise<string>}
 */
export const loadSystemPromptRules = async (defaultRules) => {
  await ready();
  return withLock(async () => {
    const { systemPromptRules } = await storage().get(['systemPromptRules']);
    if (typeof systemPromptRules === 'string' && systemPromptRules) return systemPromptRules;
    await storage().set({ systemPromptRules: defaultRules });
    return defaultRules;
  });
};

/**
 * Locked save of the LCSH selection rules (key `systemPromptRules`, unchanged).
 * Writes nothing when the stored rules no longer equal `base` (the text the
 * editor was loaded from): another tab changed them.
 * @param {string} rules - Rules text to save
 * @param {string|null} base - The stored rules the editor was loaded from
 * @returns {Promise<{saved:true, value:string}|{saved:false, reason:'stale'}>}
 */
export const saveSystemPromptRules = async (rules, base) => {
  await ready();
  return withLock(async () => {
    const { systemPromptRules } = await storage().get(['systemPromptRules']);
    if ((systemPromptRules ?? null) !== (base ?? null)) return { saved: false, reason: 'stale' };
    await storage().set({ systemPromptRules: rules });
    return { saved: true, value: rules };
  });
};

/**
 * Subscribe to changes of the settings keys (area 'local').
 * @param {(changes:object)=>void} cb - Called with the changed settings keys only
 * @returns {()=>void} - Unsubscribe
 */
export const onSettingsChanged = (cb) => {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const relevant = {};
    for (const key of Object.keys(changes)) {
      if (isSettingsKey(key)) relevant[key] = changes[key];
    }
    if (Object.keys(relevant).length > 0) cb(relevant);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
};

export default {
  ready,
  getSettings,
  updateProvider,
  setActiveProvider,
  saveProviderAndActivate,
  saveProviderDraft,
  onSettingsChanged
};
