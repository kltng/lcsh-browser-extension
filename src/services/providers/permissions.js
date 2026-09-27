/**
 * Optional host permissions and base-URL validation (SPEC-P3 §5).
 */
import { ProviderError, errorContext } from './errors';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validate a user-set server address (custom, LM Studio). Synchronous.
 * @param {string} str - The address typed by the user
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export const validateBaseURL = (str) => {
  const raw = typeof str === 'string' ? str.trim() : '';
  if (!raw) return { ok: false, reason: 'The server address is empty.' };
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return { ok: false, reason: 'The server address is not a valid URL.' };
  }
  if (url.hostname.startsWith('[')) {
    return { ok: false, reason: 'IPv6 addresses are not supported. Use localhost or 127.0.0.1.' };
  }
  const httpsOk = url.protocol === 'https:';
  const httpOk = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!httpsOk && !httpOk) {
    return { ok: false, reason: 'Use https://, or http:// only for localhost or 127.0.0.1.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'The server address must not contain a user name or password.' };
  }
  if (url.search || raw.includes('?')) {
    return { ok: false, reason: 'The server address must not contain a query (?…).' };
  }
  if (url.hash || raw.includes('#')) {
    return { ok: false, reason: 'The server address must not contain a fragment (#…).' };
  }
  return { ok: true, url: url.href.replace(/\/$/, '') };
};

/**
 * The permission origin pattern for a config, or null for Nano.
 * @param {{entry?:object, baseURL?:string|null}} cfg - ProviderConfig
 * @returns {string|null}
 */
export const originFor = (cfg) => {
  if (!cfg || cfg.entry?.adapter === 'chrome-nano' || !cfg.baseURL) return null;
  return `${new URL(cfg.baseURL).origin}/*`;
};

/**
 * Whether Chrome has granted access to an origin pattern.
 * @param {string} origin - Pattern such as `https://api.openai.com/*`
 * @returns {Promise<boolean>}
 */
export const hasAccess = (origin) => chrome.permissions.contains({ origins: [origin] });

/**
 * Ask Chrome for access. Not async on purpose: the call to
 * chrome.permissions.request happens synchronously, inside the user gesture.
 * @param {string} origin - Pattern such as `https://api.openai.com/*`
 * @returns {Promise<boolean>}
 */
export const requestAccess = (origin) => chrome.permissions.request({ origins: [origin] });

/**
 * Throw a `permission` ProviderError when the config's origin is not granted.
 * Nano never touches permissions.
 * @param {object} cfg - ProviderConfig
 * @returns {Promise<void>}
 */
export const ensureAccess = async (cfg) => {
  const origin = originFor(cfg);
  if (!origin) return;
  let granted = false;
  try {
    granted = await hasAccess(origin);
  } catch (e) {
    granted = false;
  }
  if (!granted) throw new ProviderError('permission', errorContext(cfg));
};

export default { validateBaseURL, originFor, hasAccess, requestAccess, ensureAccess };
