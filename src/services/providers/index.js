/**
 * Provider layer entry point: generate(), testConnection(), listModels(), resolveConfig()
 * (SPEC-P3 §4.1, §4.7). No adapter ever retries in a different JSON mode.
 */
import { ProviderError, errorContext, logProviderError, rejectEchoedKey } from './errors';
import { createOperation, abortError } from './http';
import { validate, TEST_SCHEMA } from './schema';
import { extractJson } from './extract';
import { generateOpenAI } from './openaiStyle';
import { generateGemini } from './gemini';
import { generateAnthropic } from './anthropic';
import { generateNano } from './geminiNano';

export { resolveConfig, resolveConfigFromDraft } from './config';
export { listModels } from './models';
export { ProviderError } from './errors';

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const THINKING_MIN_OUTPUT_TOKENS = 8192;
export const GENERATE_DEADLINE_MS = 120000;
export const NANO_DEADLINE_MS = 240000;
export const TEST_DEADLINE_MS = 45000;

const ADAPTERS = {
  'openai-style': generateOpenAI,
  gemini: generateGemini,
  anthropic: generateAnthropic,
  'chrome-nano': generateNano
};

const isNano = (cfg) => cfg?.entry?.adapter === 'chrome-nano';

/**
 * Generate an answer.
 * GenerateRequest: { system, userText, images?:{mimeType,dataUrl}[], schema?:object|null,
 *   temperature?, maxOutputTokens? (default 4096; ≥8192 when caps.thinkingOn), signal?, deadlineMs? }
 * @param {object} cfg - ProviderConfig from resolveConfig()
 * @param {object} req - GenerateRequest
 * @returns {Promise<{text:string, json:object|null, finish:'stop'|'other', mode:string,
 *   usage:{inputTokens:number|null, outputTokens:number|null}}>}
 */
export const generate = async (cfg, req) => {
  const ctx = errorContext(cfg);
  const schema = req.schema ?? null;
  const images = Array.isArray(req.images) ? req.images : [];
  let op = null;
  try {
    if (!cfg?.caps || !cfg.model) {
      throw new ProviderError('not_configured', { ...ctx, missing: 'no model is chosen' });
    }
    if (images.length > 0 && !cfg.caps.images) throw new ProviderError('images_unsupported', ctx);
    const requested = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const maxOutputTokens = cfg.caps.thinkingOn ? Math.max(requested, THINKING_MIN_OUTPUT_TOKENS) : requested;
    const deadlineMs = req.deadlineMs ?? (isNano(cfg) ? NANO_DEADLINE_MS : GENERATE_DEADLINE_MS);
    op = createOperation({ deadlineMs, signal: req.signal });

    const adapter = ADAPTERS[cfg.entry.adapter];
    const answer = await adapter(cfg, { ...req, schema, images, maxOutputTokens }, op);
    // An answer that echoes the key must never be returned, shown, saved or copied.
    rejectEchoedKey(cfg, answer.text);
    if (!schema) return { ...answer, json: null, mode: 'text' };

    const json = extractJson(answer.text, { stripThinkTags: cfg.caps.stripThinkTags });
    if (!json || !validate(schema, json).ok) throw new ProviderError('invalid_output', ctx);
    // JSON escapes (sk-…) could hide the key from the text check.
    rejectEchoedKey(cfg, json);
    return { ...answer, json, mode: cfg.caps.jsonMode };
  } catch (err) {
    let mapped = err;
    if (!(err instanceof ProviderError)) {
      mapped = op?.reason() ? abortError(op, ctx) : new ProviderError('invalid_output', ctx);
    }
    logProviderError(mapped);
    throw mapped;
  } finally {
    op?.close();
  }
};

const isOk = (text) => text.trim().toUpperCase().replace(/[.!]$/, '') === 'OK';

/**
 * Test one mode of a (possibly unsaved) configuration.
 * @param {object} cfg - ProviderConfig
 * @param {{mode:'text'|'json', signal?:AbortSignal, jsonModeOverride?:string}} opts - Mode, signal, temporary JSON mode
 * @returns {Promise<{ok:boolean, mode:string, effectiveJsonMode:string|null, error?:ProviderError}>}
 */
export const testConnection = async (cfg, { mode = 'text', signal, jsonModeOverride } = {}) => {
  const deadlineMs = isNano(cfg) ? NANO_DEADLINE_MS : TEST_DEADLINE_MS;
  try {
    if (mode === 'text') {
      const result = await generate(cfg, {
        system: 'You are a test.',
        userText: 'Reply with the single word OK.',
        maxOutputTokens: 16,
        signal,
        deadlineMs
      });
      if (!isOk(result.text)) {
        return { ok: false, mode, effectiveJsonMode: null, error: new ProviderError('invalid_output', errorContext(cfg)) };
      }
      return { ok: true, mode, effectiveJsonMode: null };
    }
    const testCfg = jsonModeOverride && cfg?.caps
      ? { ...cfg, caps: { ...cfg.caps, jsonMode: jsonModeOverride, openrouterRequireParameters: false } }
      : cfg;
    const result = await generate(testCfg, {
      system: 'You are a library cataloger.',
      userText: 'Give one Library of Congress subject heading for a book about cats. Use kind "topical", confidence 90, uri null, and a one-sentence analysis.',
      schema: TEST_SCHEMA,
      signal,
      deadlineMs
    });
    return { ok: true, mode, effectiveJsonMode: result.mode };
  } catch (err) {
    const error = err instanceof ProviderError ? err : new ProviderError('invalid_output', errorContext(cfg));
    return { ok: false, mode, effectiveJsonMode: null, error };
  }
};

/** JSON modes tried for custom and LM Studio, in order. */
export const PROBE_JSON_MODES = ['json_schema', 'json_object', 'prompt'];

/**
 * Custom / LM Studio: test json once per mode with a temporary override. Saves nothing.
 * @param {object} cfg - ProviderConfig
 * @param {{signal?:AbortSignal}} [opts] - Caller signal
 * @returns {Promise<{results:object[], suggested:string|null}>}
 */
export const probeJsonModes = async (cfg, { signal } = {}) => {
  const results = [];
  for (const jsonModeOverride of PROBE_JSON_MODES) {
    results.push({ jsonMode: jsonModeOverride, ...(await testConnection(cfg, { mode: 'json', signal, jsonModeOverride })) });
    if (signal?.aborted) break;
  }
  const first = results.find((r) => r.ok);
  return { results, suggested: first ? first.jsonMode : null };
};
