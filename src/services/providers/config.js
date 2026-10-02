/**
 * resolveConfig() and resolveConfigFromDraft() (SPEC-P3 §3.4).
 * Providers read settings only through these functions.
 */
import { ProviderError } from './errors';
import {
  getProviderEntry, regionFor, modelMetaKey, baseURLFor, findModelMeta, resolveCapabilities, userJsonMode, isKeyBound
} from './capabilities';
import { IMAGE_OPTS, nanoAvailability } from './geminiNano';

const notConfigured = (entry, missing) => new ProviderError('not_configured', {
  providerId: entry?.id ?? null,
  provider: entry?.name || 'The AI provider',
  missing
});

/**
 * Build a ProviderConfig from a registry entry and a provider value (stored or draft).
 * @param {object} entry - Registry entry
 * @param {object} draft - `provider:<id>` value or an unsaved form draft
 * @param {{purpose?:'generate'|'list', modelMeta?:object|null}} [opts] - Purpose and the cached model list
 * @returns {Promise<{providerId:string, entry:object, region:string|null, metaKey:string,
 *   baseURL:string|null, apiKey:string|null, model:string|null, caps:object}>}
 */
export const resolveConfigFromDraft = async (entry, draft = {}, { purpose = 'generate', modelMeta = null } = {}) => {
  if (!entry) throw notConfigured(null, 'no provider is selected');
  const value = draft || {};
  const region = regionFor(entry, value);
  const base = baseURLFor(entry, value);
  if (!base.ok) {
    throw notConfigured(entry, base.missing ? 'the server address is missing' : `the server address is invalid (${base.reason})`);
  }
  const apiKey = typeof value.apiKey === 'string' && value.apiKey.trim() ? value.apiKey.trim() : null;
  // P6 security review finding 1: a key is only ever sent to the origin it
  // was entered for. This is the one place every Test, Load models and
  // generation request gets its credential, so a key bound to another origin
  // (or to none) is refused here, never sent.
  if (apiKey && !isKeyBound(entry, value)) {
    throw notConfigured(entry, 'the API key belongs to another server address; enter the key again');
  }
  if (entry.keyRequired === 'yes' && !apiKey) throw notConfigured(entry, 'the API key is missing');
  const typedModel = typeof value.model === 'string' ? value.model.trim() : '';
  const model = entry.adapter === 'chrome-nano' ? entry.defaultModel : (typedModel || entry.defaultModel || null);
  if (!model && purpose === 'generate') throw notConfigured(entry, 'no model is chosen');
  if (entry.json === 'user-choice' && !userJsonMode(value).ok) {
    throw notConfigured(entry, 'the JSON mode is not supported');
  }

  let meta = findModelMeta(modelMeta, model);
  if (entry.images === 'nano-availability') {
    meta = { images: (await nanoAvailability(IMAGE_OPTS)) === 'available' };
  }
  return {
    providerId: entry.id,
    entry,
    region,
    metaKey: modelMetaKey(entry.id, region),
    baseURL: base.url,
    apiKey,
    model,
    caps: resolveCapabilities(entry, value, meta)
  };
};

/**
 * Build the ProviderConfig of a stored provider.
 * @param {object} settings - Result of settings.getSettings()
 * @param {string} providerId - Provider id
 * @param {{purpose?:'generate'|'list'}} [opts] - Purpose
 * @returns {Promise<object>} - ProviderConfig; throws ProviderError{kind:'not_configured'}
 */
export const resolveConfig = async (settings, providerId, { purpose = 'generate' } = {}) => {
  const entry = getProviderEntry(providerId);
  const value = settings?.providers?.[providerId] || {};
  const metaKey = entry ? modelMetaKey(entry.id, regionFor(entry, value)) : null;
  return resolveConfigFromDraft(entry, value, { purpose, modelMeta: settings?.modelMeta?.[metaKey] || null });
};
