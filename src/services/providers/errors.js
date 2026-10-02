/**
 * ProviderError and the error mapping table (SPEC-P3 §4.6).
 *
 * The message is always written here, from a template. The constructor never
 * receives response bodies, headers or request data, and no `cause` is kept.
 */
import { valueHasKey } from '../keyGuard';

const RETRYABLE = new Set(['rate_limit', 'server', 'overloaded', 'timeout', 'network']);

const TEMPLATES = {
  not_configured: ({ provider, missing }) => `${provider} is not set up: ${missing}. Open Settings.`,
  permission: ({ host }) => `Chrome needs your permission to contact ${host}. Open Settings and click Grant access.`,
  auth: ({ provider }) => `${provider} rejected the API key. Check it in Settings.`,
  forbidden: ({ provider }) => `${provider} refused the request (403). The key may lack access to this model or region.`,
  bad_request: ({ provider }) => `${provider} rejected the request. The model may not support this feature (for example structured output or images).`,
  not_found: ({ provider }) => `${provider} does not know the model or address. Check the model name and region.`,
  rate_limit: ({ provider }) => `${provider} rate limit reached. Try again in a minute.`,
  server: ({ provider }) => `${provider} had a server error. Try again later.`,
  overloaded: ({ provider }) => `${provider} is overloaded. Try again later.`,
  billing: ({ provider }) => `${provider} reports a billing or credit problem on this account.`,
  too_long: ({ provider }) => `The request is too large for ${provider}. Remove images or shorten the text.`,
  nano_too_long: () => 'The input is too long for Gemini Nano. Shorten the abstract or table of contents.',
  invalid_output: ({ provider }) => `${provider} returned an answer in the wrong format.`,
  nano_constraint: () => 'Gemini Nano cannot produce this structured output.',
  timeout: ({ provider }) => `${provider} did not answer in time.`,
  cancelled: () => 'Cancelled.',
  network: ({ host }) => `Could not reach ${host}. Check your connection.`,
  truncated: () => 'The answer was cut off (token limit reached).',
  refused: ({ provider }) => `${provider} declined to answer this request.`,
  images_unsupported: () => 'This model cannot read images. Remove the images or choose another model.',
  unavailable: () => 'Gemini Nano is not available on this device or browser right now.'
};

/** Error for every provider failure. `message` is a locally written user message. */
export class ProviderError extends Error {
  /**
   * @param {string} kind - One of the §4.6 kinds
   * @param {{providerId?:string|null, provider?:string, host?:string, status?:number|null,
   *   missing?:string, variant?:string}} [ctx] - Only local facts; never response data
   */
  constructor(kind, ctx = {}) {
    const template = TEMPLATES[ctx.variant] || TEMPLATES[kind] || TEMPLATES.invalid_output;
    super(template({
      provider: ctx.provider || 'The AI provider',
      host: ctx.host || 'the server',
      missing: ctx.missing || 'a required setting'
    }));
    this.name = 'ProviderError';
    this.providerId = ctx.providerId ?? null;
    this.kind = kind;
    this.status = typeof ctx.status === 'number' ? ctx.status : null;
    this.retryable = RETRYABLE.has(kind);
  }
}

/**
 * Local context for error messages, taken from a ProviderConfig.
 * @param {object|null} cfg - ProviderConfig (or null)
 * @returns {{providerId:string|null, provider:string, host:string}}
 */
export const errorContext = (cfg) => {
  let host = 'the server';
  try {
    if (cfg?.baseURL) host = new URL(cfg.baseURL).host;
  } catch (e) {
    // keep the neutral host name
  }
  return {
    providerId: cfg?.providerId ?? null,
    provider: cfg?.entry?.name || 'The AI provider',
    host
  };
};

/**
 * Map a final (non-2xx) HTTP status to a ProviderError.
 * @param {number} status - HTTP status
 * @param {object} ctx - Result of errorContext()
 * @returns {ProviderError}
 */
export const errorFromStatus = (status, ctx) => {
  const withStatus = { ...ctx, status };
  if (status === 401) return new ProviderError('auth', withStatus);
  if (status === 402) return new ProviderError('billing', withStatus);
  if (status === 403) return new ProviderError('forbidden', withStatus);
  if (status === 404) return new ProviderError('bad_request', { ...withStatus, variant: 'not_found' });
  if (status === 413) return new ProviderError('too_long', withStatus);
  if (status === 429) return new ProviderError('rate_limit', withStatus);
  if (status === 503 || status === 529) return new ProviderError('overloaded', withStatus);
  if (status >= 500) return new ProviderError('server', withStatus);
  return new ProviderError('bad_request', withStatus);
};

/**
 * Throw `invalid_output` when a consumed response value gives the request's
 * non-empty API key back. Run it before a value is returned, cached,
 * rendered, or used to build another URL. The test depends on the key's
 * length (P6 security review finding 5, lead decision B), so a short key
 * never rejects an ordinary answer:
 *  - 8+ characters: any string or property name CONTAINS the key;
 *  - 2–7 characters: any string or property name contains it as a WHOLE
 *    token (bounded by start/end or a character that is not a letter or digit);
 *  - 1 character (for example LM Studio's "a"): a string value EQUALS the key
 *    after trimming.
 * The matching itself is the shared keyGuard matcher (one implementation of
 * the length rules for the raw answer and for every exit).
 * @param {object} cfg - ProviderConfig (its apiKey is the secret)
 * @param {any} value - Parsed response data or answer text
 */
export const rejectEchoedKey = (cfg, value) => {
  const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey : '';
  if (key.length === 0) return;
  if (valueHasKey(value, [key])) throw new ProviderError('invalid_output', errorContext(cfg));
};

/**
 * Log a provider error without any secret or response data.
 * @param {ProviderError} err - The error to log
 */
export const logProviderError = (err) => {
  console.error('[provider]', { providerId: err.providerId, kind: err.kind, status: err.status });
};

export default ProviderError;
