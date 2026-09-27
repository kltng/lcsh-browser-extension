/**
 * Google Gemini generateContent adapter (SPEC-P3 §4.3).
 */
import { ProviderError, errorContext } from './errors';
import { fetchWithDeadline, parseJsonBody } from './http';
import { ensureAccess } from './permissions';
import { toGeminiSchema } from './schema';

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

/**
 * The base64 part of a data URL.
 * @param {string} dataUrl - `data:<mime>;base64,<data>`
 * @returns {string}
 */
export const base64Of = (dataUrl) => {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
};

/**
 * Build the exact request (pure; used by the fixture tests).
 * @param {object} cfg - ProviderConfig
 * @param {object} req - GenerateRequest (maxOutputTokens already resolved)
 * @returns {{url:string, init:{method:string, headers:object, body:string}}}
 */
export const buildGeminiRequest = (cfg, req) => {
  const { caps } = cfg;
  const images = req.images || [];
  const model = String(cfg.model).replace(/^models\//, '');
  const generationConfig = {
    ...(caps.sendTemperature && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    maxOutputTokens: req.maxOutputTokens
  };
  if (req.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(req.schema);
  }
  const body = {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: [{
      role: 'user',
      parts: [
        { text: req.userText },
        ...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: base64Of(i.dataUrl) } }))
      ]
    }],
    generationConfig
  };
  return {
    url: `${cfg.baseURL}/models/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify(body)
    }
  };
};

/**
 * Map a parsed 2xx body to `{text, finish, usage}` or throw a ProviderError.
 * @param {object} cfg - ProviderConfig
 * @param {object} data - Parsed response body
 * @returns {{text:string, finish:'stop'|'other', usage:object}}
 */
export const parseGeminiResponse = (cfg, data) => {
  const ctx = errorContext(cfg);
  if (data?.promptFeedback?.blockReason) throw new ProviderError('refused', ctx);
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  if (!candidate || typeof candidate !== 'object') throw new ProviderError('invalid_output', ctx);
  const reason = candidate.finishReason;
  if (REFUSAL_REASONS.has(reason)) throw new ProviderError('refused', ctx);
  if (reason === 'MAX_TOKENS') throw new ProviderError('truncated', ctx);
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter((p) => p && p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!text.trim()) throw new ProviderError('invalid_output', ctx);
  const usage = data.usageMetadata || {};
  return {
    text,
    finish: reason === 'STOP' ? 'stop' : 'other',
    usage: {
      inputTokens: Number.isFinite(usage.promptTokenCount) ? usage.promptTokenCount : null,
      outputTokens: Number.isFinite(usage.candidatesTokenCount) ? usage.candidatesTokenCount : null
    }
  };
};

/**
 * One generation call.
 * @param {object} cfg - ProviderConfig
 * @param {object} req - GenerateRequest (maxOutputTokens already resolved)
 * @param {object} op - Operation from createOperation()
 * @returns {Promise<{text:string, finish:string, usage:object}>}
 */
export const generateGemini = async (cfg, req, op) => {
  const ctx = errorContext(cfg);
  const { url, init } = buildGeminiRequest(cfg, req);
  await ensureAccess(cfg);
  const res = await fetchWithDeadline(url, init, { op, ctx });
  return parseGeminiResponse(cfg, parseJsonBody(res.text, ctx));
};

export default generateGemini;
