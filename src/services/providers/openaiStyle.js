/**
 * OpenAI-style chat/completions adapter (SPEC-P3 §4.3).
 * Used by OpenAI, DeepSeek, Qwen, Zhipu, Moonshot, MiniMax, OpenRouter, LM Studio and custom.
 */
import { ProviderError, errorContext } from './errors';
import { fetchWithDeadline, parseJsonBody } from './http';
import { ensureAccess } from './permissions';
import { stripThinkTags } from './extract';

/**
 * The system-prompt suffix used by the json_object and prompt modes.
 * @param {object} schema - Canonical schema
 * @returns {string}
 */
export const jsonSuffix = (schema) => (
  `\n\nReturn only a JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`
);

/**
 * Build the exact request (pure; used by the fixture tests).
 * @param {object} cfg - ProviderConfig
 * @param {object} req - GenerateRequest (maxOutputTokens already resolved)
 * @returns {{url:string, init:{method:string, headers:object, body:string}}}
 */
export const buildOpenAIRequest = (cfg, req) => {
  const { caps } = cfg;
  const schema = req.schema || null;
  const images = req.images || [];
  const addSuffix = schema && (caps.jsonMode === 'json_object' || caps.jsonMode === 'prompt');
  const system = addSuffix ? `${req.system || ''}${jsonSuffix(schema)}` : (req.system || '');
  const userContent = images.length > 0
    ? [{ type: 'text', text: req.userText }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } }))]
    : req.userText;
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: userContent }
  ];
  const body = {
    model: cfg.model,
    messages,
    ...(caps.sendTemperature && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(caps.maxTokensParam ? { [caps.maxTokensParam]: req.maxOutputTokens } : {}),
    ...(caps.extraBody || {})
  };
  if (schema && caps.jsonMode === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };
    if (caps.openrouterRequireParameters) body.provider = { require_parameters: true };
  } else if (schema && caps.jsonMode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return {
    url: `${cfg.baseURL}/chat/completions`,
    init: { method: 'POST', headers, body: JSON.stringify(body) }
  };
};

/**
 * Map a parsed 2xx body to `{text, finish, usage}` or throw a ProviderError.
 * @param {object} cfg - ProviderConfig
 * @param {object} data - Parsed response body
 * @returns {{text:string, finish:'stop'|'other', usage:{inputTokens:number|null, outputTokens:number|null}}}
 */
export const parseOpenAIResponse = (cfg, data) => {
  const ctx = errorContext(cfg);
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!choice || typeof choice !== 'object') throw new ProviderError('invalid_output', ctx);
  const message = choice.message || {};
  const finishReason = choice.finish_reason;
  if (typeof message.refusal === 'string' && message.refusal.trim()) throw new ProviderError('refused', ctx);
  if (finishReason === 'content_filter') throw new ProviderError('refused', ctx);
  if (finishReason === 'length') throw new ProviderError('truncated', ctx);
  if (typeof message.content !== 'string') throw new ProviderError('invalid_output', ctx);
  const text = cfg.caps.stripThinkTags ? stripThinkTags(message.content) : message.content;
  if (!text.trim()) throw new ProviderError('invalid_output', ctx);
  const usage = data.usage || {};
  return {
    text,
    finish: finishReason === 'stop' ? 'stop' : 'other',
    usage: {
      inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null
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
export const generateOpenAI = async (cfg, req, op) => {
  const ctx = errorContext(cfg);
  const { url, init } = buildOpenAIRequest(cfg, req);
  await ensureAccess(cfg);
  const res = await fetchWithDeadline(url, init, { op, ctx });
  return parseOpenAIResponse(cfg, parseJsonBody(res.text, ctx));
};

export default generateOpenAI;
