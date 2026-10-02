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
import { OLD_DEFAULT_RULES } from './pipeline/legacyRules';
import { validateLocalDbSnapshot, isValidRecord } from './localdb/record';
import { resolveDelimiter, SUBFIELD_DELIMITERS } from './pipeline/marcFormat';

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

export const LOOKUP_BACKENDS = ['loc-api', 'local-db'];
/** Keys of the local database (SPEC-P5 §2). `localDb` changes ONLY at a §4.5 or §4.7 commit. */
export const LOCAL_DB_KEYS = ['localDb', 'localDbPendingDeletes', 'localDbUpdateCheck'];
/** The patch fields the §3.3 bridge accepts; everything else is preserved. */
export const LOCAL_DB_PATCH_KEYS = ['localDb', 'lookupBackend', 'pendingDeletesAdd', 'pendingDeletesRemove'];

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
/** SPEC-UI2 §4: an independent output preference (never part of a provider or database write). */
export const DELIMITER_KEY = 'outputSubfieldDelimiter';
const FIXED_KEYS = ['settingsVersion', 'activeProviderId', 'systemPromptRules', 'lookupBackend', ...LOCAL_DB_KEYS, DELIMITER_KEY];

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
 * Every API key stored now, for the exit key guard (P6 fix 13): the key of
 * every provider and a not-yet-migrated legacy Gemini key. A plain read: no
 * migration and no lock, so it never writes anything.
 * @returns {Promise<string[]>}
 */
export const readStoredApiKeys = async () => {
  const all = await storage().get([...PROVIDERS.map((p) => providerKey(p.id)), LEGACY_KEY]);
  const keys = PROVIDERS.map((p) => all[providerKey(p.id)]?.apiKey);
  keys.push(all[LEGACY_KEY]);
  return keys.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
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
    lookupBackend: LOOKUP_BACKENDS.includes(all.lookupBackend) ? all.lookupBackend : DEFAULT_LOOKUP_BACKEND,
    // An incomplete record is NOT an installation: the lookup and the UI must
    // never build an installation identity or a file name out of it.
    localDb: isValidRecord(all.localDb) ? all.localDb : null,
    localDbInvalid: all.localDb !== undefined && all.localDb !== null && !isValidRecord(all.localDb),
    localDbPendingDeletes: Array.isArray(all.localDbPendingDeletes) ? all.localDbPendingDeletes : [],
    localDbUpdateCheck: all.localDbUpdateCheck ?? null,
    // Missing or invalid → `$` (SPEC-UI2 §4).
    subfieldDelimiter: resolveDelimiter(all[DELIMITER_KEY])
  };
};

/**
 * The local-database settings, read under the lock (SPEC-P5 §3.3 `read`).
 * `valid` reports whether the COMPLETE snapshot passes §2 validation; the
 * installer must not open or delete anything when it is false (§3.4 step 2).
 * The raw values are returned unchanged, so nothing is silently repaired.
 * @returns {Promise<{lookupBackend:string, localDb:object|null, localDbPendingDeletes:any, valid:boolean, invalidReason:string|null}>}
 */
export const readLocalDbSettings = async () => {
  await ready();
  return withLock(async () => {
    const all = await storage().get(['lookupBackend', 'localDb', 'localDbPendingDeletes']);
    const snapshot = {
      lookupBackend: LOOKUP_BACKENDS.includes(all.lookupBackend) ? all.lookupBackend : DEFAULT_LOOKUP_BACKEND,
      localDb: all.localDb ?? null,
      localDbPendingDeletes: all.localDbPendingDeletes === undefined ? [] : all.localDbPendingDeletes
    };
    const { valid, reason } = validateLocalDbSnapshot(snapshot);
    return { ...snapshot, valid, invalidReason: reason };
  });
};

/**
 * The commit of the §3.3 bridge, under the `'lcsh-settings'` lock:
 * (2) reread, (3) compare `expectedLocalDb` STRUCTURALLY with the fresh value,
 * (4) run `fence()` immediately before the write with NO await in between
 * (HOUSE_RULES 13), (5) apply the allowlisted patch and write.
 * @param {{expectedLocalDb:object|null, patch:object, fence?:()=>boolean}} args - Expected base, patch, generation fence
 * @param {(()=>void)|null} [faultHook] - Fault build only (§21 `settings-write`)
 * @returns {Promise<{ok:boolean, reason?:string, current:object}>}
 */
export const commitLocalDb = async ({ expectedLocalDb = null, patch = {}, fence = () => true }, faultHook) => {
  for (const key of Object.keys(patch)) {
    if (!LOCAL_DB_PATCH_KEYS.includes(key)) throw new Error(`Not a local database patch field: ${key}`);
  }
  if (Object.hasOwn(patch, 'lookupBackend') && !LOOKUP_BACKENDS.includes(patch.lookupBackend)) {
    throw new Error('Unknown lookup backend');
  }
  await ready();
  return withLock(async () => {
    const all = await storage().get(['lookupBackend', 'localDb', 'localDbPendingDeletes']);
    const fresh = {
      lookupBackend: LOOKUP_BACKENDS.includes(all.lookupBackend) ? all.lookupBackend : DEFAULT_LOOKUP_BACKEND,
      localDb: all.localDb ?? null,
      localDbPendingDeletes: Array.isArray(all.localDbPendingDeletes) ? all.localDbPendingDeletes : []
    };
    if (stableStringify(fresh.localDb) !== stableStringify(expectedLocalDb ?? null)) {
      return { ok: false, reason: 'changed', current: fresh };
    }
    const writes = {};
    if (Object.hasOwn(patch, 'localDb')) writes.localDb = patch.localDb;
    if (Object.hasOwn(patch, 'lookupBackend')) writes.lookupBackend = patch.lookupBackend;
    if (patch.pendingDeletesAdd || patch.pendingDeletesRemove) {
      // The add/remove lists apply to the FRESH list read in step 2.
      const pending = new Set(fresh.localDbPendingDeletes);
      for (const name of patch.pendingDeletesAdd || []) pending.add(name);
      for (const name of patch.pendingDeletesRemove || []) pending.delete(name);
      writes.localDbPendingDeletes = [...pending];
    }
    const next = { ...fresh, ...writes };
    if (Object.keys(writes).length === 0) return { ok: true, current: next };
    if (!fence()) return { ok: false, reason: 'stale-generation', current: fresh };
    try {
      // SPEC-P5 §21 `settings-write`: synchronous, after the final fence, and
      // only for a patch that carries `localDb` (install/uninstall).
      if (__LCSH_FAULTS__ && faultHook && Object.hasOwn(patch, 'localDb')) faultHook();
      await storage().set(writes);
    } catch (err) {
      return { ok: false, reason: 'write-failed', current: fresh };
    }
    return { ok: true, current: next };
  });
};

/**
 * Locked write of the subfield delimiter (SPEC-UI2 §4, Settings → Output).
 * @param {'$'|'‡'} value - The delimiter
 * @returns {Promise<void>}
 */
export const setSubfieldDelimiter = async (value) => {
  if (!SUBFIELD_DELIMITERS.includes(value)) throw new Error('Unknown subfield delimiter');
  await ready();
  return withLock(async () => {
    // Only this key is written: provider and database settings stay as they are.
    await storage().set({ [DELIMITER_KEY]: value });
  });
};

/**
 * Locked write of the lookup backend (the Settings radio buttons).
 * @param {'loc-api'|'local-db'} id - Backend id
 * @returns {Promise<void>}
 */
export const setLookupBackend = async (id) => {
  if (!LOOKUP_BACKENDS.includes(id)) throw new Error('Unknown lookup backend');
  await ready();
  return withLock(async () => {
    await storage().set({ lookupBackend: id });
  });
};

/**
 * The PAGE-owned update check (§4.6), outside the installed record and outside
 * the bridge.
 * @param {{lastCheckedAt:number, latestSeen:string|null}|null} [value] - New value, or omitted to read
 * @returns {Promise<{lastCheckedAt:number, latestSeen:string|null}|null>}
 */
export const localDbUpdateCheck = async (value) => {
  await ready();
  return withLock(async () => {
    if (value === undefined) return (await storage().get(['localDbUpdateCheck'])).localDbUpdateCheck ?? null;
    await storage().set({ localDbUpdateCheck: value });
    return value;
  });
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
 * Read the stored rules (locked). The default is written first when no rules
 * are stored, or when the stored rules are EXACTLY an old version's default
 * (never edited by the user). Every other string, including whitespace-only
 * edits of an old default, is custom and is kept unchanged.
 * @param {string} defaultRules - Default rules text
 * @returns {Promise<string>}
 */
export const loadSystemPromptRules = async (defaultRules) => {
  await ready();
  return withLock(async () => {
    const { systemPromptRules } = await storage().get(['systemPromptRules']);
    const isOldDefault = OLD_DEFAULT_RULES.includes(systemPromptRules);
    if (typeof systemPromptRules === 'string' && systemPromptRules && !isOldDefault) return systemPromptRules;
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
