/**
 * Shared test fixtures: the fake key, config builders and provider answers.
 */
import util from 'node:util';
import { vi } from 'vitest';
import { PROVIDERS } from '../src/services/providers/registry';
import { resolveConfigFromDraft } from '../src/services/providers/config';
import { originFor } from '../src/services/providers/permissions';
import { fakes, response } from './setup';

/** A recognizable fake key; tests assert it never leaks. */
export const KEY = 'sk-SECRET-test-key-1234567890';

/** A valid answer for TEST_SCHEMA. */
export const VALID_TEST_ANSWER = {
  analysis: 'A book about cats.',
  terms: [{ heading: 'Cats', kind: 'topical', confidence: 90, uri: null }]
};

/** Exact expected toGeminiSchema(TEST_SCHEMA). */
export const GEMINI_TEST_SCHEMA = {
  type: 'OBJECT',
  required: ['analysis', 'terms'],
  properties: {
    analysis: { type: 'STRING' },
    terms: {
      type: 'ARRAY',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'OBJECT',
        required: ['heading', 'kind', 'confidence', 'uri'],
        properties: {
          heading: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['topical', 'name', 'geographic', 'genre'] },
          confidence: { type: 'INTEGER' },
          uri: { type: 'STRING', nullable: true }
        }
      }
    }
  }
};

/** Exact expected toAnthropicSchema(TEST_SCHEMA). */
export const ANTHROPIC_TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['analysis', 'terms'],
  properties: {
    analysis: { type: 'string', description: 'At least 1 character. At most 400 characters.' },
    terms: {
      type: 'array',
      minItems: 1,
      description: 'At most 3 items.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'kind', 'confidence', 'uri'],
        properties: {
          heading: { type: 'string', description: 'At least 1 character. At most 200 characters.' },
          kind: { type: 'string', enum: ['topical', 'name', 'geographic', 'genre'] },
          confidence: { type: 'integer', description: 'Minimum value 0. Maximum value 100.' },
          uri: { type: ['string', 'null'], description: 'At most 300 characters.' }
        }
      }
    }
  }
};

/**
 * The registry entry for an id.
 * @param {string} id - Provider id
 * @returns {object}
 */
export const entryOf = (id) => PROVIDERS.find((p) => p.id === id);

/**
 * A resolved config for a provider, with its host permission granted.
 * @param {string} id - Provider id
 * @param {object} [draft] - Overrides of the default draft
 * @param {{grant?:boolean, modelMeta?:object}} [opts] - Grant the origin (default true)
 * @returns {Promise<object>}
 */
export const makeCfg = async (id, draft = {}, { grant = true, modelMeta = null } = {}) => {
  const entry = entryOf(id);
  const base = {
    apiKey: KEY,
    model: 'test-model',
    ...(id === 'custom' ? { baseURL: 'https://llm.example.com/v1' } : {})
  };
  const cfg = await resolveConfigFromDraft(entry, { ...base, ...draft }, { purpose: 'generate', modelMeta });
  const origin = originFor(cfg);
  if (grant && origin) fakes.permissions.granted.add(origin);
  return cfg;
};

/**
 * A successful provider body carrying `text`, in the adapter's wire format.
 * @param {string} adapter - Registry adapter
 * @param {string} text - Answer text
 * @returns {object}
 */
export const successBody = (adapter, text) => {
  if (adapter === 'gemini') {
    return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } };
  }
  if (adapter === 'anthropic') {
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } };
  }
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
};

/**
 * Make fetch answer every call with the given responses (the last one repeats).
 * @param {...object} responses - Results of response()
 * @returns {Function} - The fetch mock
 */
export const mockFetch = (...responses) => {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === 'function') return r();
    return r;
  });
  return globalThis.fetch;
};

/**
 * Make fetch answer with the adapter's success body for `text`.
 * @param {string} adapter - Registry adapter
 * @param {string} text - Answer text
 * @returns {Function}
 */
export const mockAnswer = (adapter, text) => mockFetch(response(successBody(adapter, text)));

/**
 * Spy on every console method and return a function that tells whether `needle` was logged.
 * @returns {{spies:object[], logged:(needle:string)=>boolean, allText:()=>string}}
 */
export const spyConsole = () => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  const allText = () => spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 10, showHidden: true }))).join(' '))
    .join('\n');
  return { spies, allText, logged: (needle) => allText().includes(needle) };
};

/**
 * The parsed JSON body of a fetch call.
 * @param {Function} fetchMock - vi.fn fetch
 * @param {number} [n] - Call index
 * @returns {object}
 */
export const bodyOf = (fetchMock, n = 0) => JSON.parse(fetchMock.mock.calls[n][1].body);
