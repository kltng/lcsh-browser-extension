/**
 * The "Using <provider> · <model>" label (moved from legacyBridge.js).
 */
import { getProviderEntry } from '../providers/capabilities';
import { getSettings } from '../settings';

/**
 * The label for a provider id and its stored settings.
 * @param {string} providerId - Registry id
 * @param {object} [stored] - Stored `provider:<id>` value
 * @returns {string}
 */
export const providerLabel = (providerId, stored = {}) => {
  const entry = getProviderEntry(providerId);
  const model = (typeof stored?.model === 'string' && stored.model.trim()) || entry?.defaultModel || 'no model chosen';
  return `Using ${entry?.name || providerId} · ${model}`;
};

/**
 * The "Using <provider> · <model>" label of the active provider.
 * @returns {Promise<string>}
 */
export async function describeActiveProvider() {
  const settings = await getSettings();
  return providerLabel(settings.activeProviderId, settings.providers[settings.activeProviderId] || {});
}

export default describeActiveProvider;
