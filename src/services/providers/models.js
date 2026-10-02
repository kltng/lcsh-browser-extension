/**
 * listModels() for every registry `models` kind (SPEC-P3 §4.4).
 * One 20 s deadline is shared by ALL pages of one call.
 */
import { ProviderError, errorContext, logProviderError, rejectEchoedKey } from './errors';
import { createOperation, fetchWithDeadline, parseJsonBody, abortError } from './http';
import { ensureAccess } from './permissions';
import { IMAGE_OPTS, nanoAvailability } from './geminiNano';
import { saveModelMeta } from '../settings';

export const LIST_DEADLINE_MS = 20000;
const MAX_PAGES = 5;
const UNSUPPORTED = Object.freeze({ supported: false, models: [], partial: false });

const imagesFromOpenAIItem = (item) => {
  if (Array.isArray(item.input_modalities)) return item.input_modalities.includes('image');
  if (typeof item.supports_image_in === 'boolean') return item.supports_image_in;
  if (Array.isArray(item.architecture?.input_modalities)) return item.architecture.input_modalities.includes('image');
  return null;
};

const bearer = (cfg) => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

const getJson = async (cfg, url, headers, op, passStatuses = []) => {
  const ctx = errorContext(cfg);
  await ensureAccess(cfg);
  const res = await fetchWithDeadline(url, { method: 'GET', headers }, { op, ctx, passStatuses });
  if (passStatuses.includes(res.status)) return { status: res.status, data: null };
  const data = parseJsonBody(res.text, ctx);
  // Before any id, label or page token is cached, returned or put into the next URL.
  rejectEchoedKey(cfg, data);
  return { status: res.status, data };
};

const listOpenAI = async (cfg, op) => {
  const { status, data } = await getJson(cfg, `${cfg.baseURL}/models`, bearer(cfg), op, [404]);
  if (status === 404) return null;
  if (!Array.isArray(data.data)) throw new ProviderError('invalid_output', errorContext(cfg));
  const models = data.data
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      label: m.id,
      images: imagesFromOpenAIItem(m),
      ...(cfg.providerId === 'openrouter' && Array.isArray(m.supported_parameters)
        ? { supportedParameters: [...m.supported_parameters] }
        : {})
    }));
  return { models, partial: false };
};

const listGemini = async (cfg, op) => {
  const models = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${cfg.baseURL}/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const { data } = await getJson(cfg, url, { 'x-goog-api-key': cfg.apiKey }, op);
    if (!Array.isArray(data.models)) throw new ProviderError('invalid_output', errorContext(cfg));
    for (const m of data.models) {
      if (!m || typeof m.name !== 'string') continue;
      if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      models.push({ id, label: typeof m.displayName === 'string' && m.displayName ? m.displayName : id, images: null });
    }
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;
    if (!pageToken) return { models, partial: false };
  }
  return { models, partial: true };
};

const listAnthropic = async (cfg, op) => {
  const models = [];
  let afterId = null;
  const headers = {
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${cfg.baseURL}/models?limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
    const { data } = await getJson(cfg, url, headers, op);
    if (!Array.isArray(data.data)) throw new ProviderError('invalid_output', errorContext(cfg));
    for (const m of data.data) {
      if (!m || typeof m.id !== 'string') continue;
      const images = typeof m.capabilities?.image_input === 'boolean' ? m.capabilities.image_input : null;
      models.push({ id: m.id, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id, images });
    }
    afterId = typeof data.last_id === 'string' ? data.last_id : null;
    if (!data.has_more || !afterId) return { models, partial: false };
  }
  return { models, partial: true };
};

const LISTERS = { 'openai-list': listOpenAI, 'gemini-paged': listGemini, 'anthropic-paged': listAnthropic };

/**
 * List the provider's models and refresh the modelMeta cache.
 * @param {object} cfg - ProviderConfig (purpose 'list' is enough)
 * @param {{signal?:AbortSignal}} [opts] - Caller signal
 * @returns {Promise<{supported:boolean, models:{id:string,label:string,images:boolean|null}[], partial:boolean}>}
 */
export const listModels = async (cfg, { signal } = {}) => {
  const kind = cfg.entry.models;
  if (kind === 'none') return { ...UNSUPPORTED, models: [] };
  if (kind === 'fixed-nano') {
    const images = (await nanoAvailability(IMAGE_OPTS)) === 'available';
    return { supported: true, partial: false, models: [{ id: 'gemini-nano', label: 'Gemini Nano (on-device)', images }] };
  }
  const lister = LISTERS[kind];
  if (!lister) return { ...UNSUPPORTED, models: [] };

  const ctx = errorContext(cfg);
  const op = createOperation({ deadlineMs: LIST_DEADLINE_MS, signal });
  let result;
  try {
    result = await lister(cfg, op);
  } catch (err) {
    let mapped = err;
    if (!(err instanceof ProviderError)) mapped = op.reason() ? abortError(op, ctx) : new ProviderError('invalid_output', ctx);
    logProviderError(mapped);
    throw mapped;
  } finally {
    op.close();
  }
  if (!result) return { ...UNSUPPORTED, models: [] };
  // P6 security re-review: the raw answer was checked page by page; the ids
  // are normalized afterwards (Gemini's "models/" prefix is stripped), so the
  // FINAL list is checked again before it is cached or returned.
  try {
    rejectEchoedKey(cfg, result.models.map(({ id, label, supportedParameters }) => ({ id, label, supportedParameters })));
  } catch (err) {
    logProviderError(err);
    throw err;
  }

  try {
    await saveModelMeta(cfg.metaKey, {
      fetchedAt: Date.now(),
      models: result.models.map(({ id, images, supportedParameters }) => (
        supportedParameters ? { id, images, supportedParameters } : { id, images }
      ))
    });
  } catch (e) {
    console.error('[provider] could not save the model list');
  }
  return {
    supported: true,
    partial: result.partial,
    models: result.models.map(({ id, label, images }) => ({ id, label, images }))
  };
};

export default listModels;
