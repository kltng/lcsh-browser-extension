/**
 * Anthropic Messages adapter (SPEC-P3 §4.3).
 */
import { ProviderError, errorContext } from './errors';
import { fetchWithDeadline, parseJsonBody } from './http';
import { ensureAccess } from './permissions';
import { toAnthropicSchema, countNullableUnions, ANTHROPIC_MAX_NULLABLE_UNIONS } from './schema';
import { base64Of } from './gemini';

/**
 * Local preflight: Anthropic accepts at most 16 nullable union types per schema.
 * @param {object} cfg - ProviderConfig
 * @param {object} schema - Canonical schema
 */
export const anthropicPreflight = (cfg, schema) => {
  if (countNullableUnions(schema) > ANTHROPIC_MAX_NULLABLE_UNIONS) {
    throw new ProviderError('bad_request', errorContext(cfg));
  }
};

/**
 * Build the exact request (pure; used by the fixture tests).
 * @param {object} cfg - ProviderConfig
 * @param {object} req - GenerateRequest (maxOutputTokens already resolved)
 * @returns {{url:string, init:{method:string, headers:object, body:string}}}
 */
export const buildAnthropicRequest = (cfg, req) => {
  const images = req.images || [];
  if (req.schema) anthropicPreflight(cfg, req.schema);
  const body = {
    model: cfg.model,
    max_tokens: req.maxOutputTokens,
    ...(req.system ? { system: req.system } : {}),
    ...(cfg.caps.sendTemperature && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: req.userText },
        ...images.map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mimeType, data: base64Of(i.dataUrl) }
        }))
      ]
    }]
  };
  if (req.schema) {
    body.output_config = { format: { type: 'json_schema', schema: toAnthropicSchema(req.schema) } };
  }
  return {
    url: `${cfg.baseURL}/messages`,
    init: {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json'
      },
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
export const parseAnthropicResponse = (cfg, data) => {
  const ctx = errorContext(cfg);
  const reason = data?.stop_reason;
  if (reason === 'refusal') throw new ProviderError('refused', ctx);
  if (reason === 'max_tokens') throw new ProviderError('truncated', ctx);
  if (!Array.isArray(data?.content)) throw new ProviderError('invalid_output', ctx);
  const text = data.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new ProviderError('invalid_output', ctx);
  const usage = data.usage || {};
  return {
    text,
    finish: reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : 'other',
    usage: {
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
      outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null
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
export const generateAnthropic = async (cfg, req, op) => {
  const ctx = errorContext(cfg);
  const { url, init } = buildAnthropicRequest(cfg, req);
  await ensureAccess(cfg);
  const res = await fetchWithDeadline(url, init, { op, ctx });
  return parseAnthropicResponse(cfg, parseJsonBody(res.text, ctx));
};

export default generateAnthropic;
