/**
 * Legacy bridge (SPEC-P3 §7): runs the existing 5-step workflow on any
 * configured provider. Components call this module; it calls the prompt
 * builders/parsers in geminiService.js and generate() in providers/.
 */
import {
  buildSuggestionPrompt,
  buildMarcPrompt,
  selectMarcEligible,
  parseMarcRecords
} from './geminiService';
import { generate, resolveConfig, ProviderError } from './providers/index';
import { getProviderEntry } from './providers/capabilities';
import { getSettings, onSettingsChanged } from './settings';

export { parseLcshSuggestions } from './geminiService';
export { onSettingsChanged };

/** One settings snapshot: the resolved config of the active provider. */
const snapshotConfig = async () => {
  const settings = await getSettings();
  return resolveConfig(settings, settings.activeProviderId);
};

const envelope = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

const provenanceOf = (cfg) => ({ providerId: cfg.providerId, model: cfg.model });

/**
 * Generate LCSH suggestions with the active provider.
 * @param {object} bibliographicInfo - Form data; `images` is `[{data, name, type, size}]`
 * @param {string} systemPromptRules - The user-editable rules
 * @param {{signal?:AbortSignal}} [opts] - Caller signal
 * @returns {Promise<{candidates:object[], provenance:{providerId:string, model:string}}>}
 */
export async function legacyGenerateSuggestions(bibliographicInfo, systemPromptRules, { signal } = {}) {
  const cfg = await snapshotConfig();
  const images = (bibliographicInfo.images || []).map((image) => ({ mimeType: image.type, dataUrl: image.data }));
  const result = await generate(cfg, {
    ...buildSuggestionPrompt(bibliographicInfo, systemPromptRules),
    images,
    schema: null,
    temperature: 0.2,
    maxOutputTokens: 4096,
    signal
  });
  return { ...envelope(result.text), provenance: provenanceOf(cfg) };
}

/**
 * Generate MARC records for the eligible recommendations with the active provider.
 * With zero eligible terms it needs no configuration and makes no network call.
 * @param {Array} recommendations - Recommendations with similarity scores and best matches
 * @param {{signal?:AbortSignal}} [opts] - Caller signal
 * @returns {Promise<{marcRecords:Object<string,string>, provenance:{providerId:string, model:string}|null}>}
 */
export async function legacyGenerateMarc(recommendations, { signal } = {}) {
  const terms = selectMarcEligible(recommendations);
  if (terms.length === 0) return { marcRecords: {}, provenance: null };
  const cfg = await snapshotConfig();
  const result = await generate(cfg, {
    ...buildMarcPrompt(terms),
    schema: null,
    temperature: 0.1,
    maxOutputTokens: 4096,
    signal
  });
  return { marcRecords: parseMarcRecords(envelope(result.text), terms), provenance: provenanceOf(cfg) };
}

/**
 * The "Using <provider> · <model>" label of the active provider.
 * @returns {Promise<string>}
 */
export async function describeActiveProvider() {
  const settings = await getSettings();
  const entry = getProviderEntry(settings.activeProviderId);
  const stored = settings.providers[settings.activeProviderId] || {};
  const model = (typeof stored.model === 'string' && stored.model.trim()) || entry?.defaultModel || 'no model chosen';
  return `Using ${entry?.name || settings.activeProviderId} · ${model}`;
}

/**
 * The shared catch-block logging of the workflow screens. Safe by construction:
 * a ProviderError logs only {providerId, kind, status}; any other value logs only
 * a fixed classification from `typeof` and a fixed message. No property of a
 * non-ProviderError value is read (a getter could throw or return a secret).
 * @param {string} label - What failed
 * @param {any} err - The error
 */
export function logWorkflowError(label, err) {
  let isProviderError = false;
  try {
    isProviderError = err instanceof ProviderError;
  } catch (e) {
    // A hostile value (for example a Proxy) is treated as a non-provider error.
  }
  if (isProviderError) {
    console.error(label, { providerId: err.providerId, kind: err.kind, status: err.status });
    return;
  }
  const LOCAL_CLASSES = {
    object: 'non-provider error (object)',
    string: 'non-provider error (string)',
    undefined: 'non-provider error (undefined)'
  };
  const errorType = LOCAL_CLASSES[typeof err] || 'non-provider error (other)';
  console.error(label, { errorType, message: 'Unexpected error (details are not logged).' });
}
