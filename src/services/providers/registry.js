/**
 * Provider registry (SPEC-P3 §3.1–3.2). Data only: no functions, no imports.
 * Sources for every value: .dispatch/provider_research.md and
 * .dispatch/provider_probe_facts.md.
 */

/** @type {Array<object>} Every supported provider, in display order. */
export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-style',
    regions: { intl: { baseURL: 'https://api.openai.com/v1' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'yes',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
    defaultModel: null,
    request: { maxTokensParam: 'max_completion_tokens', sendTemperature: false, extraBody: null, thinkingOn: true },
    json: 'json_schema',
    images: 'yes',
    answer: { stripThinkTags: false },
    models: 'openai-list'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    adapter: 'gemini',
    regions: { intl: { baseURL: 'https://generativelanguage.googleapis.com/v1beta' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'yes',
    keyHelpUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    request: { maxTokensParam: 'maxOutputTokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'responseSchema',
    images: 'yes',
    answer: { stripThinkTags: false },
    models: 'gemini-paged'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    adapter: 'anthropic',
    regions: { intl: { baseURL: 'https://api.anthropic.com/v1' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'yes',
    keyHelpUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5',
    request: { maxTokensParam: 'max_tokens', sendTemperature: false, extraBody: null, thinkingOn: true },
    json: 'output_config',
    images: 'yes',
    answer: { stripThinkTags: false },
    models: 'anthropic-paged'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'openai-style',
    regions: { intl: { baseURL: 'https://api.deepseek.com' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'yes',
    keyHelpUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-flash',
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: { thinking: { type: 'disabled' } }, thinkingOn: false },
    json: 'json_object',
    images: 'from-model-meta',
    answer: { stripThinkTags: false },
    models: 'openai-list'
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba Model Studio)',
    adapter: 'openai-style',
    regions: {
      intl: { baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      cn: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
    },
    defaultRegion: 'intl',
    regionSelectable: true,
    keyRequired: 'yes',
    keyHelpUrl: 'https://modelstudio.console.alibabacloud.com/',
    defaultModel: 'qwen3.7-plus',
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: { enable_thinking: false }, thinkingOn: false },
    json: 'json_object',
    images: 'unknown',
    answer: { stripThinkTags: true },
    models: 'none'
  },
  {
    id: 'zhipu',
    name: 'Zhipu / Z.ai (GLM)',
    adapter: 'openai-style',
    regions: {
      intl: { baseURL: 'https://api.z.ai/api/paas/v4' },
      cn: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' }
    },
    defaultRegion: 'intl',
    regionSelectable: true,
    keyRequired: 'yes',
    keyHelpUrl: 'https://z.ai/manage-apikey/apikey-list',
    defaultModel: 'glm-5.3',
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'json_object',
    images: 'unknown',
    answer: { stripThinkTags: true },
    models: 'none'
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    adapter: 'openai-style',
    regions: {
      intl: { baseURL: 'https://api.moonshot.ai/v1' },
      cn: { baseURL: 'https://api.moonshot.cn/v1' }
    },
    defaultRegion: 'intl',
    regionSelectable: true,
    keyRequired: 'yes',
    keyHelpUrl: 'https://platform.kimi.ai/console/api-keys',
    defaultModel: 'kimi-k3',
    request: { maxTokensParam: 'max_completion_tokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'json_schema',
    images: 'from-model-meta',
    answer: { stripThinkTags: true },
    models: 'openai-list'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    adapter: 'openai-style',
    regions: {
      intl: { baseURL: 'https://api.minimax.io/v1' },
      cn: { baseURL: 'https://api.minimax.cn/v1' }
    },
    defaultRegion: 'intl',
    regionSelectable: true,
    keyRequired: 'yes',
    keyHelpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    defaultModel: 'MiniMax-M3',
    request: { maxTokensParam: 'max_completion_tokens', sendTemperature: true, extraBody: { reasoning_split: true }, thinkingOn: true },
    json: 'prompt',
    images: 'unknown',
    answer: { stripThinkTags: true },
    models: 'openai-list'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-style',
    regions: { intl: { baseURL: 'https://openrouter.ai/api/v1' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'yes',
    keyHelpUrl: 'https://openrouter.ai/keys',
    defaultModel: null,
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'from-model-meta',
    images: 'from-model-meta',
    answer: { stripThinkTags: true },
    models: 'openai-list'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    adapter: 'openai-style',
    // The default address is editable in Settings (provider:lmstudio.baseURL).
    regions: { intl: { baseURL: 'http://localhost:1234/v1' } },
    defaultRegion: 'intl',
    regionSelectable: false,
    keyRequired: 'no',
    keyHelpUrl: null,
    defaultModel: null,
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'user-choice',
    images: 'unknown',
    answer: { stripThinkTags: true },
    models: 'openai-list'
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    adapter: 'openai-style',
    regions: null,
    defaultRegion: null,
    regionSelectable: false,
    keyRequired: 'optional',
    keyHelpUrl: null,
    defaultModel: null,
    request: { maxTokensParam: 'max_tokens', sendTemperature: true, extraBody: null, thinkingOn: true },
    json: 'user-choice',
    images: 'unknown',
    answer: { stripThinkTags: true },
    models: 'openai-list'
  },
  {
    id: 'gemini-nano',
    name: 'Gemini Nano (on-device)',
    adapter: 'chrome-nano',
    regions: null,
    defaultRegion: null,
    regionSelectable: false,
    keyRequired: 'no',
    keyHelpUrl: null,
    defaultModel: 'gemini-nano',
    request: { maxTokensParam: null, sendTemperature: false, extraBody: null, thinkingOn: false },
    json: 'responseConstraint',
    images: 'nano-availability',
    answer: { stripThinkTags: false },
    models: 'fixed-nano'
  }
];

export default PROVIDERS;
