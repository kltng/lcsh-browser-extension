/**
 * Capability resolver and model-metadata helpers (SPEC-P3 §3.3).
 */
import { PROVIDERS } from './registry';
import { validateBaseURL } from './permissions';

/**
 * Look up a registry entry.
 * @param {string} id - Provider id
 * @returns {object|null}
 */
export const getProviderEntry = (id) => PROVIDERS.find((p) => p.id === id) || null;

/**
 * The region a provider uses: the stored one if the provider has it, else the default.
 * @param {object} entry - Registry entry
 * @param {object} [providerSettings] - Stored `provider:<id>` value or a draft
 * @returns {'intl'|'cn'|null}
 */
export const regionFor = (entry, providerSettings = {}) => {
  if (!entry.regions) return null;
  const wanted = providerSettings?.region;
  if (wanted && entry.regionSelectable && entry.regions[wanted]) return wanted;
  return entry.defaultRegion;
};

/**
 * Storage key of the model-metadata cache.
 * @param {string} id - Provider id
 * @param {string|null} region - Region, or null
 * @returns {string}
 */
export const modelMetaKey = (id, region) => `modelMeta:${id}:${region || 'default'}`;

/**
 * Every possible model-metadata key, for reading the cache.
 * @returns {string[]}
 */
export const allModelMetaKeys = () => PROVIDERS.flatMap((p) => (
  p.regions ? Object.keys(p.regions).map((r) => modelMetaKey(p.id, r)) : [modelMetaKey(p.id, null)]
));

/**
 * The base URL a provider uses (region URL, or the validated user URL).
 * @param {object} entry - Registry entry
 * @param {object} [providerSettings] - Stored value or draft
 * @returns {{ok:true, url:string|null}|{ok:false, reason:string, missing:boolean}}
 */
export const baseURLFor = (entry, providerSettings = {}) => {
  if (entry.adapter === 'chrome-nano') return { ok: true, url: null };
  const typed = typeof providerSettings?.baseURL === 'string' ? providerSettings.baseURL.trim() : '';
  if (entry.id === 'custom' || (entry.id === 'lmstudio' && typed)) {
    if (!typed) return { ok: false, reason: 'The server address is empty.', missing: true };
    const checked = validateBaseURL(typed);
    return checked.ok ? { ok: true, url: checked.url } : { ok: false, reason: checked.reason, missing: false };
  }
  return { ok: true, url: entry.regions[regionFor(entry, providerSettings)].baseURL };
};

/**
 * Find one model's cached metadata.
 * @param {object|null} metaEntry - `{fetchedAt, models:[...]}` or null
 * @param {string|null} model - Model id
 * @returns {object|null}
 */
export const findModelMeta = (metaEntry, model) => {
  if (!metaEntry || !Array.isArray(metaEntry.models) || !model) return null;
  return metaEntry.models.find((m) => m.id === model) || null;
};

/** JSON modes a user may choose for custom and LM Studio. */
export const USER_JSON_MODES = ['json_schema', 'json_object', 'prompt'];

/**
 * The user's JSON mode: blank or missing means 'json_schema'.
 * @param {object} [providerSettings] - Stored value or draft
 * @returns {{ok:true, mode:string}|{ok:false}} - ok:false for an unsupported non-blank value
 */
export const userJsonMode = (providerSettings) => {
  const raw = providerSettings?.jsonMode;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, mode: 'json_schema' };
  }
  return USER_JSON_MODES.includes(raw) ? { ok: true, mode: raw } : { ok: false };
};

const resolveJsonMode = (entry, providerSettings, modelMeta) => {
  if (entry.json === 'user-choice') {
    const chosen = userJsonMode(providerSettings);
    // An unsupported value is rejected in resolveConfigFromDraft; here it falls back safely.
    return { jsonMode: chosen.ok ? chosen.mode : 'json_schema', openrouterRequireParameters: false };
  }
  if (entry.json === 'from-model-meta') {
    const params = Array.isArray(modelMeta?.supportedParameters) ? modelMeta.supportedParameters : [];
    if (params.includes('structured_outputs')) return { jsonMode: 'json_schema', openrouterRequireParameters: true };
    if (params.includes('response_format')) return { jsonMode: 'json_object', openrouterRequireParameters: false };
    return { jsonMode: 'prompt', openrouterRequireParameters: false };
  }
  return { jsonMode: entry.json, openrouterRequireParameters: false };
};

const resolveImages = (entry, providerSettings, modelMeta) => {
  let known = null;
  if (entry.images === 'yes') known = true;
  else if (entry.images === 'no') known = false;
  else if (entry.images === 'from-model-meta' || entry.images === 'nano-availability') {
    known = typeof modelMeta?.images === 'boolean' ? modelMeta.images : null;
  }
  if (known !== null) return { images: known, imagesKnown: true };
  return { images: providerSettings?.imagesOverride === true, imagesKnown: false };
};

/**
 * Resolve what a provider/model can do.
 * For Nano, pass `{images: availability(IMAGE_OPTS) === 'available'}` as the metadata.
 * @param {object} entry - Registry entry
 * @param {object} providerSettings - Stored value or draft
 * @param {object|null} modelMetaEntry - The model's cached metadata, or null
 * @returns {{jsonMode:string, openrouterRequireParameters:boolean, images:boolean, imagesKnown:boolean,
 *   sendTemperature:boolean, maxTokensParam:string|null, extraBody:object|null,
 *   thinkingOn:boolean, stripThinkTags:boolean}}
 */
export const resolveCapabilities = (entry, providerSettings, modelMetaEntry) => ({
  ...resolveJsonMode(entry, providerSettings, modelMetaEntry),
  ...resolveImages(entry, providerSettings, modelMetaEntry),
  sendTemperature: entry.request.sendTemperature,
  maxTokensParam: entry.request.maxTokensParam,
  extraBody: entry.request.extraBody,
  thinkingOn: entry.request.thinkingOn,
  stripThinkTags: entry.answer.stripThinkTags
});

export default resolveCapabilities;
