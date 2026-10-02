/**
 * SPEC-UI2 §7: the "Configured" mark of the provider list. It looks only at
 * the SAVED configuration (never an unsaved draft) and says nothing about
 * whether a connection or access works.
 */
import { validateBaseURL } from '../services/providers/permissions';

export const CONFIGURED_LABEL = 'Configured';
export const CONFIGURED_TOOLTIP = 'Saved configuration; connection and access have not been verified.';
export const NANO_AVAILABLE_LABEL = 'Available';

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Whether a provider's SAVED value counts as configured: a non-empty key for
 * a key-required provider, or an explicitly saved valid endpoint for LM Studio
 * and Custom. Nano has its own availability mark.
 * @param {object} entry - Registry entry
 * @param {object|undefined} stored - The saved `provider:<id>` value
 * @returns {boolean}
 */
export const isProviderConfigured = (entry, stored) => {
  const value = stored || {};
  if (entry.adapter === 'chrome-nano') return false;
  if (entry.id === 'lmstudio' || entry.id === 'custom') {
    return filled(value.baseURL) && validateBaseURL(value.baseURL.trim()).ok;
  }
  if (entry.keyRequired === 'yes') return filled(value.apiKey);
  return false;
};

/**
 * Whether a Nano availability result may be shown as "Available": only
 * `available` (downloadable, downloading, unavailable, unknown or a failed
 * check do not qualify).
 * @param {any} availability - Result of LanguageModel.availability()
 * @returns {boolean}
 */
export const isNanoAvailable = (availability) => availability === 'available';
