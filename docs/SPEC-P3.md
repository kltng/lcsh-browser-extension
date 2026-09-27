# SPEC-P3 — Provider layer, settings, Gemini Nano, legacy bridge

Status: v5 FINAL for Phase 3 = v4 + the 5 exact edits from fold-in round 4 (APPROVE-WITH-CHANGES, edits applied verbatim), 2026-09-26. Round history: v1
(`docs/SPEC.md` §3) REJECTED, 32 findings; v2 (`.dispatch/SPEC-P3.v2.md`)
REJECTED, 16 findings (`.dispatch/spec-review-p3-2/last_message.md`).
v3 folds in all 16; §10 lists the changes.

Branch `feat/multi-provider-local-db` (from `dev` v1.1.0). Nothing is
released between phases; only the Phase 6 build ships.

Binding inputs: `AGENTS.md`, `docs/multi_agent/HOUSE_RULES.md`,
`.dispatch/provider_research.md` (docs survey, with URLs),
`.dispatch/provider_probe_facts.md` (live probes).

## 0. Scope

IN:
1. A provider registry and a capability resolver.
2. Four adapters (OpenAI-style, Gemini, Anthropic, Gemini Nano) behind
   `generate()`.
3. A canonical JSON-Schema subset, per-provider schema converters, and a
   local validator. No `ajv`: it uses `new Function`, which MV3 CSP
   forbids.
4. Settings storage with cross-page locking, and migration.
5. The Settings screen and the popup launcher.
6. Optional host permissions.
7. A legacy bridge, so today's 5-step workflow runs on any configured
   provider.
8. vitest and the tests in §8.

OUT: the JSON pipeline (P4), lookup backends and the local DB (P4/P5), and
a history redesign (P3 adds two provenance fields only).

## 1. Files and ownership

```
src/services/settings.js               storage keys, Web-Lock RMW, migration, change events
src/services/providers/registry.js     PROVIDERS table (§3) — data only
src/services/providers/capabilities.js resolveCapabilities() + model metadata cache (§3.3)
src/services/providers/index.js        generate(), testConnection(), listModels(), resolveConfig()
src/services/providers/errors.js       ProviderError + mapping table (§4.6)
src/services/providers/http.js         fetchWithDeadline() (§4.5)
src/services/providers/schema.js       assertSchema(), validate(), toGeminiSchema(), toAnthropicSchema(), TEST_SCHEMA
src/services/providers/extract.js      answer text → JSON; <think> stripping
src/services/providers/openaiStyle.js | gemini.js | anthropic.js | geminiNano.js
src/services/providers/permissions.js  originFor(), hasAccess(), requestAccess(), validateBaseURL()
src/services/legacyBridge.js           the old workflow's facade (§7)
src/services/geminiService.js          keeps ONLY prompt builders and parsers (exported); no fetch, no keys
src/components/SettingsPage.jsx, ProviderSettings.jsx, NanoStatus.jsx
src/popup.jsx (launcher), src/app.jsx (Settings entry + #settings route)
test/setup.js, vitest.config.js, src/**/__tests__/*.test.js
```

Dependency direction (no cycles):
- components → `legacyBridge` → `geminiService` (prompts and parsers) and
  `providers/index`.
- `providers/*` reads `settings` only through `resolveConfig`.
- `geminiService` imports nothing from `providers` or `legacyBridge`.

## 2. Settings (`settings.js`)

Keys in `chrome.storage.local`:

| Key | Value |
|---|---|
| `settingsVersion` | `2` |
| `activeProviderId` | a registry id (default `'gemini'`) |
| `provider:<id>` | `{ apiKey?, model?, region?: 'intl'\|'cn', baseURL?, jsonMode?: 'json_schema'\|'json_object'\|'prompt', imagesOverride?: boolean }` (`jsonMode` is used only by `custom`/`lmstudio`) |
| `modelMeta:<id>:<region\|default>` | `{fetchedAt, models:[{id, images, supportedParameters?}]}` (§3.3) |
| `systemPromptRules` | the existing key, unchanged |
| `lookupBackend` | written as `'loc-api'` if missing (reserved for P4/P5) |

**Cross-page serialization.** Every read-modify-write runs inside
`navigator.locks.request('lcsh-settings', {mode:'exclusive'}, fn)`. That
covers migration, provider updates and changing the active provider. The
lock is shared by every page of the extension origin (popup, app tabs).
Inside the lock: read the current stored values, apply the change, write,
release. Plain reads do not take the lock.

API:
```js
await ready()                          // resolves after migrateLegacy() completes; every caller awaits it
getSettings(): Promise<Settings>       // merged view with defaults
updateProvider(id, patch)              // locked RMW: patch keys replace, the other keys are kept
setActiveProvider(id)                  // locked write
saveProviderAndActivate(id, patch, base) // locked: ONE combined write of provider:<id> + activeProviderId
saveProviderDraft(id, draft, base)     // locked: see stale-draft rule below
onSettingsChanged(cb) -> unsubscribe   // chrome.storage.onChanged, area 'local', the keys above
```

**Stale-draft rule.** The Settings form keeps `base` = the stored
`provider:<id>` value it was loaded from. `saveProviderDraft` and
`saveProviderAndActivate` compare `base` with the CURRENT stored value
inside the lock. If they differ, nothing is written, and the call returns
`{saved:false, reason:'stale'}`. The form then says "Settings changed in
another tab — reload them" and keeps the user's unsaved edits visible.
Clean (unedited) forms refresh automatically on `onSettingsChanged`.
Locked functions never call other locked public functions. The one lock
covers one combined write, and `ready()` is awaited BEFORE the lock is
requested.

**Migration.** `migrateLegacy()` runs from `ready()` in both the popup and
the app, inside the lock:
1. Read `geminiApiKey`, `provider:gemini`, `activeProviderId`,
   `settingsVersion`.
2. If `geminiApiKey` is a non-empty string:
   - if `provider:gemini.apiKey` is empty, write
     `provider:gemini = {...current, apiKey: geminiApiKey}`;
   - if it is non-empty and DIFFERENT, keep it (the user already saved a
     newer key).
3. If `activeProviderId` is missing, write `'gemini'`.
4. Write `settingsVersion: 2`.
5. Read back `provider:gemini`. If it holds a non-empty key, remove
   `geminiApiKey`. If this removal fails, the next start repeats steps 1–5.
   That is harmless: steps 2–4 change nothing the second time.

All other readers and writers of `geminiApiKey` and `apiKey` are removed
(`popup.jsx`, `AppContext.jsx`, components, `geminiService.js`).
`SystemPromptEditor` and the prompt reset keep using the key
`systemPromptRules`, now through `settings.js`.

## 3. Registry and capabilities

### 3.1 Registry entry shape (`registry.js`, data only)

```js
{
  id, name,
  adapter: 'openai-style' | 'gemini' | 'anthropic' | 'chrome-nano',
  regions: { intl?: {baseURL}, cn?: {baseURL} } | null, // null = user-set URL (custom) or none (nano)
  defaultRegion: 'intl' | 'cn' | null,
  regionSelectable: boolean,                             // true only when both regions exist
  keyRequired: 'yes' | 'no' | 'optional',
  keyHelpUrl: string | null,
  defaultModel: string | null,                           // null = the user must pick one
  request: {
    maxTokensParam: 'max_tokens' | 'max_completion_tokens' | 'maxOutputTokens' | null,
    sendTemperature: boolean,
    extraBody: object | null,                            // merged into every request body
    thinkingOn: boolean                                  // the model may spend output tokens on reasoning
  },
  json: 'json_schema' | 'json_object' | 'prompt' | 'responseSchema' | 'output_config'
      | 'responseConstraint' | 'from-model-meta' | 'user-choice',
  images: 'yes' | 'no' | 'from-model-meta' | 'nano-availability' | 'unknown',
  answer: { stripThinkTags: boolean },
  models: 'openai-list' | 'gemini-paged' | 'anthropic-paged' | 'fixed-nano' | 'none'
}
```

### 3.2 Registry values (binding; sources in `.dispatch/provider_research.md`)

| id | adapter | regions (intl / cn) | key | keyHelpUrl | defaultModel | maxTokensParam | sendTemperature | extraBody | thinkingOn | json | images | stripThinkTags | models |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| openai | openai-style | `https://api.openai.com/v1` / — | yes | `https://platform.openai.com/api-keys` | null | max_completion_tokens | **false** | null | true | json_schema | yes | false | openai-list |
| gemini | gemini | `https://generativelanguage.googleapis.com/v1beta` / — | yes | `https://aistudio.google.com/apikey` | `gemini-2.5-flash` | maxOutputTokens | true | null | true | responseSchema | yes | false | gemini-paged |
| anthropic | anthropic | `https://api.anthropic.com/v1` / — | yes | `https://console.anthropic.com/settings/keys` | `claude-sonnet-5` | max_tokens | **false** | null | true | output_config | yes | false | anthropic-paged |
| deepseek | openai-style | `https://api.deepseek.com` / — | yes | `https://platform.deepseek.com/api_keys` | `deepseek-flash` | max_tokens | true | `{"thinking":{"type":"disabled"}}` | false | json_object | from-model-meta | false | openai-list |
| qwen | openai-style | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` / `https://dashscope.aliyuncs.com/compatible-mode/v1` | yes | `https://modelstudio.console.alibabacloud.com/` | `qwen3.7-plus` | max_tokens | true | `{"enable_thinking":false}` | false | json_object | unknown | true | none |
| zhipu | openai-style | `https://api.z.ai/api/paas/v4` / `https://open.bigmodel.cn/api/paas/v4` | yes | `https://z.ai/manage-apikey/apikey-list` | `glm-5.3` | max_tokens | true | null | true | json_object | unknown | true | none |
| moonshot | openai-style | `https://api.moonshot.ai/v1` / `https://api.moonshot.cn/v1` | yes | `https://platform.kimi.ai/console/api-keys` | `kimi-k3` | max_completion_tokens | true | null | true | json_schema | from-model-meta | true | openai-list |
| minimax | openai-style | `https://api.minimax.io/v1` / `https://api.minimax.cn/v1` | yes | `https://platform.minimax.io/user-center/basic-information/interface-key` | `MiniMax-M3` | max_completion_tokens | true | `{"reasoning_split":true}` | true | prompt | unknown | true | openai-list |
| openrouter | openai-style | `https://openrouter.ai/api/v1` / — | yes | `https://openrouter.ai/keys` | null | max_tokens | true | null | true | from-model-meta | from-model-meta | true | openai-list |
| lmstudio | openai-style | `http://localhost:1234/v1` (editable) / — | no | null | null | max_tokens | true | null | true | user-choice | unknown | true | openai-list |
| custom | openai-style | user-set / — | optional | null | null | max_tokens | true | null | true | user-choice | unknown | true | openai-list |
| gemini-nano | chrome-nano | — | no | null | `gemini-nano` | null | false | null | false | responseConstraint | nano-availability | false | fixed-nano |

- `defaultRegion` is `intl` for every provider with regions.
  `regionSelectable` is true for qwen, zhipu, moonshot and minimax only.
- DeepSeek, OpenAI, Gemini, Anthropic and OpenRouter each document one
  endpoint, so they get no region selector. This is a fact about the
  providers, not a product choice.
- Qwen workspace endpoints (`{WorkspaceId}.<region>.maas.aliyuncs.com`)
  are not supported in P3. The `custom` provider can call them, but
  without Qwen's `enable_thinking` setting, and the Settings help text
  says so.
- Zhipu gets no thinking parameter. GLM-5.3 cannot turn thinking off (Z.ai
  docs), and its reasoning arrives in `reasoning_content`, which is
  ignored.

### 3.3 Capability resolver (`capabilities.js`)

```js
/** @returns {{jsonMode:'json_schema'|'json_object'|'prompt'|'responseSchema'|'output_config'|'responseConstraint',
 *   openrouterRequireParameters:boolean, images:boolean, imagesKnown:boolean,
 *   sendTemperature:boolean, maxTokensParam:string|null, extraBody:object|null,
 *   thinkingOn:boolean, stripThinkTags:boolean}} */
resolveCapabilities(entry, providerSettings, modelMetaEntry /* the model's cached metadata or null */)
```

Rules:
- **`json`.** Fixed values pass through unchanged.
  - `from-model-meta` (OpenRouter): if the model's
    `supportedParameters` includes `structured_outputs`, use
    `json_schema` with `openrouterRequireParameters: true`. Else if it
    includes `response_format`, use `json_object`. Else, or if there is no
    metadata, use `prompt`.
  - `user-choice`: `providerSettings.jsonMode ?? 'json_schema'`.
- **`images`.**
  - `yes` means true; `no` means false.
  - `from-model-meta` uses the model's cached `images`. This is DeepSeek's
    `input_modalities` containing `image`, Moonshot's
    `supports_image_in`, or OpenRouter's `architecture.input_modalities`
    containing `image`. Missing metadata means unknown.
  - `unknown` stays unknown.
  - An unknown value gives `images=false, imagesKnown=false`, unless
    `providerSettings.imagesOverride === true`.
  - `nano-availability`: images is true when
    `availability(IMAGE_OPTS) === 'available'`, which is checked when the
    config is resolved.
- **Model metadata cache.** `listModels()` stores the normalized list in
  `modelMeta:<id>:<region|default>` with `fetchedAt`, and
  `resolveConfig()` reads it. Nothing refreshes it automatically; "Load
  models" refreshes it. A model id that is not in the cache (typed by
  hand) gets the unknown rules.
- **OpenAI temperature** is never sent. GPT-6 Astra rejects a custom
  temperature, and the other models use their default.

### 3.4 `resolveConfig(settings, providerId, {purpose})` → `ProviderConfig`

`purpose` is `'generate'` (default; also used by testConnection) or
`'list'`. For `'list'`, the model is NOT required and `caps` may be
`null`; only the endpoint and a required key are checked. The Settings
form builds the config from the DRAFT through the same rules
(`resolveConfigFromDraft(entry, draft, {purpose})`).

Returns `{providerId, entry, baseURL, apiKey|null, model, caps}`.
- `baseURL` comes from the region, or from the user's URL.
- `caps` is the `resolveCapabilities` result.
- It throws `ProviderError{kind:'not_configured'}` when: the key is
  required and missing; the model is null AND `purpose === 'generate'`; or the custom/LM Studio URL is
  missing or invalid (§5.3).

## 4. Generation contract

### 4.1 Interface (`providers/index.js`)

```js
/**
 * GenerateRequest: { system: string, userText: string,
 *   images?: {mimeType:string, dataUrl:string}[],
 *   schema?: object|null,          // canonical subset (§4.2); null → text mode
 *   temperature?: number,          // ignored when caps.sendTemperature is false
 *   maxOutputTokens?: number,      // default 4096; when caps.thinkingOn → max(value, 8192)
 *   signal?: AbortSignal, deadlineMs?: number }
 * GenerateResult: { text: string (non-empty), json: object|null,
 *   finish: 'stop'|'other', mode: 'text'|<the JSON mode used>,
 *   usage: {inputTokens:number|null, outputTokens:number|null} }
 */
generate(cfg, req)
testConnection(cfg, {mode: 'text'|'json', signal})  // §4.7
listModels(cfg, {signal})  // → {supported:boolean, models:[{id,label,images:boolean|null}], partial:boolean}
```

- `schema == null` means text mode: no structured-output controls at all.
- `schema != null`: use `caps.jsonMode`, then run the answer through
  `extract.js`, then `validate()` it against the FULL canonical schema.
  An invalid answer gives `ProviderError{kind:'invalid_output'}`.
- **No adapter ever retries in a different JSON mode.** There is no
  downgrade anywhere.
- Images: if `req.images` is non-empty and `caps.images` is false, throw
  `ProviderError{kind:'images_unsupported'}` before any network call.

### 4.2 Canonical schema subset (`schema.js`)

`assertSchema(schema)` runs when a schema module loads, and rejects:
- a root that is not `{type:'object'}` (the root must be a non-null object);
- any keyword other than: `type`, `properties`, `required`,
  `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`,
  `minLength`, `maxLength`, `minimum`, `maximum`, `description`;
- an object without `additionalProperties:false`, or whose `required` is
  not exactly the set of its `properties` keys;
- a `type` other than `object|array|string|integer|number|boolean`, or
  `[T,'null']` where T is a scalar type;
- `enum` anywhere except on `string` (or `['string','null']`, where `null`
  is also allowed); an enum containing only `null`;
- a negative or non-integer bound, `min* > max*`, depth greater than 5,
  or more than 100 properties in total.

`validate(schema, value)` returns `{ok, errors[]}`. It checks: types (an
integer must pass `Number.isInteger`; a number must be finite), required
keys, no extra keys, enum, and bounds. String length is counted in Unicode
code points (`[...s].length`).

Converters. The FULL schema is always used for local validation.
- `toGeminiSchema`: recursive.
  - `type` is upper-cased; `[T,'null']` becomes `{type:T, nullable:true}`.
  - `null` is removed from wire `enum` arrays (`nullable:true` carries it).
  - Kept: `properties`, `required`, `items`, `enum`, `minItems`,
    `maxItems`, `description`.
  - Dropped: `additionalProperties`, `minLength`, `maxLength`, `minimum`,
    `maximum`. This is a conservative choice; the local validator still
    enforces them.
- `toAnthropicSchema`: a recursive deep copy that removes `minLength`,
  `maxLength`, `minimum`, `maximum`, `maxItems`, and any `minItems` other
  than 0 or 1. The removed constraints are added in plain words to the
  `description` of the field they belonged to.
- Provider preflight (before any request): Anthropic — at most 16
  properties with a nullable union type in the whole schema; otherwise
  `bad_request` locally. Every schema used in the code passes all
  preflights (unit-tested).
- OpenAI-style `json_schema`: the canonical schema as it is (base models
  only; fine-tuned OpenAI models are outside this guarantee). It already
  meets OpenAI's strict rules: object root, every property required,
  `additionalProperties:false`, nullable through type arrays.

`TEST_SCHEMA` (literal, exported):
```js
export const TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['analysis', 'terms'],
  properties: {
    analysis: { type: 'string', minLength: 1, maxLength: 400 },
    terms: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      required: ['heading', 'kind', 'confidence', 'uri'],
      properties: {
        heading: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: ['topical', 'name', 'geographic', 'genre'] },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
        uri: { type: ['string', 'null'], maxLength: 300 }
      } } }
  }
};
```
The tests hold the exact expected output of both converters for
`TEST_SCHEMA`, plus at least 12 valid and invalid values.

### 4.2b Answer extraction (`extract.js`)

1. Remove reasoning first (`stripThinkTags` when set).
2. Trim. If the whole text parses as JSON and is an object → use it.
3. Else remove one surrounding code fence (```json … ``` or ``` … ```) if
   present; if the rest parses as an object → use it.
4. Else scan for top-level `{…}` objects with a string- and escape-aware
   brace counter. Exactly ONE complete object → parse it. Zero, more than
   one, or a parse error → `invalid_output`. The code never chooses
   between several objects.

### 4.3 Adapters

**openai-style** (`openaiStyle.js`):
- Endpoint: `POST {baseURL}/chat/completions`.
- Headers: `Content-Type: application/json`, and `Authorization: Bearer
  <key>` when there is a key.
- Body: `{model, messages, ...(sendTemperature ? {temperature} : {}),
  [maxTokensParam]: n, ...extraBody}`.
- `messages`: `[{role:'system', content: system}, {role:'user', content:
  userText}]`. With images, the user `content` is `[{type:'text', text},
  {type:'image_url', image_url:{url: dataUrl}}]`.
- JSON modes:
  - `json_schema`: `response_format:{type:'json_schema',
    json_schema:{name:'result', strict:true, schema}}`, plus
    `provider:{require_parameters:true}` when
    `caps.openrouterRequireParameters` is true.
  - `json_object`: `response_format:{type:'json_object'}`, and this suffix
    is added to the system prompt: `"\n\nReturn only a JSON object that
    matches this JSON Schema:\n" + JSON.stringify(schema)`.
  - `prompt`: the same suffix, without `response_format`.
- Answer: `choices[0].message.content`.
  - `finish_reason` `stop` means stop; `length` gives a `truncated` error;
    `content_filter` gives a `refused` error; anything else means `other`.
  - A non-empty `message.refusal` gives `refused`.
  - When `stripThinkTags` is true, `<think>…</think>` blocks are removed,
    and so is an unclosed `<think>` block at the start.
  - Content that is empty after stripping gives `truncated` if the finish
    reason was `length`, and `invalid_output` otherwise.
  - The `reasoning_content` and `reasoning` fields are ignored.

**gemini** (`gemini.js`):
- Endpoint: `POST {baseURL}/models/{model}:generateContent`. The model id
  is stored without `models/`. Header: `x-goog-api-key`.
- Body:
  - `systemInstruction:{parts:[{text:system}]}`;
  - `contents:[{role:'user', parts:[{text:userText}, ...images.map(i =>
    ({inlineData:{mimeType, data: <the base64 part of dataUrl>}}))]}]`;
  - `generationConfig:{temperature, maxOutputTokens}`.
  - With a schema, `generationConfig` also gets `responseMimeType:
    'application/json'` and `responseSchema: toGeminiSchema(schema)`.
- Answer: concatenate the `text` of the `candidates[0].content.parts`
  whose `thought !== true`.
  - `finishReason` `STOP` means stop; `MAX_TOKENS` gives `truncated`;
    `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` or a
    `promptFeedback.blockReason` give `refused`; anything else means
    `other`.
  - No candidates, or empty text, gives `invalid_output` (or `refused` if
    `promptFeedback.blockReason` exists).

**anthropic** (`anthropic.js`):
- Endpoint: `POST {baseURL}/messages`.
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true`, `content-type:
  application/json`.
- Body: `{model, max_tokens: n, system, messages:[{role:'user',
  content:[{type:'text', text:userText}, ...images.map(i => ({type:'image',
  source:{type:'base64', media_type:i.mimeType, data:<base64>}}))]}]}`.
  With a schema, add `output_config:{format:{type:'json_schema', schema:
  toAnthropicSchema(schema)}}`. No `tools`, no `tool_choice`, no
  `thinking` field. No `temperature` (models after Opus 4.6 reject values
  other than 1.0; `sendTemperature` is false and the adapter honors it).
- Answer: concatenate the `content[]` blocks with `type:'text'`.
  `stop_reason` `end_turn` or `stop_sequence` means stop; `max_tokens`
  gives `truncated`; `refusal` gives `refused`; anything else means
  `other`.

**gemini-nano** (`geminiNano.js`):
- Exists only if `typeof LanguageModel !== 'undefined'` (Chrome 138+).
- `TEXT_OPTS = {expectedInputs:[{type:'text', languages:['en']}],
  expectedOutputs:[{type:'text', languages:['en']}]}`. `IMAGE_OPTS` is
  TEXT_OPTS with `{type:'image'}` added to `expectedInputs`.
- `generate()` flow. It all runs inside ONE operation deadline (default
  240 s) together with the caller's signal:
  1. `opts = images?.length > 0 ? IMAGE_OPTS : TEXT_OPTS`.
     `availability(opts)` must be `'available'`; otherwise throw
     `ProviderError{kind:'unavailable'}`. A download is never started here.
  2. `session = await LanguageModel.create({...opts, initialPrompts:
     [{role:'system', content:system}], signal})`.
  3. `input` is the text, or with images `[{role:'user',
     content:[{type:'text', value:userText}, ...images.map(i =>
     ({type:'image', value:<Blob from i.dataUrl>}))]}]` (every image, in
     order; the same `input` is used for measuring and prompting).
  4. Budget:
     - `used = session.contextUsage ?? session.inputUsage`;
     - `need = await (session.measureContextUsage ??
       session.measureInputUsage).call(session, input, schema ?
       {responseConstraint:schema, signal} : {signal})`;
     - `cap = session.contextWindow ?? session.inputQuota`.
     - If `used + need + 1024 > cap`, throw `too_long`. The 1,024 is a
       heuristic reserve for the answer; Nano offers no enforceable output
       limit here.
  5. `text = await session.prompt(input, schema ? {responseConstraint:
     schema, signal} : {signal})`.
  6. In `finally`: `session?.destroy()`. If `create()` resolves AFTER a
     cancel or timeout, the late session is destroyed as soon as it arrives.
- `temperature` and `maxOutputTokens` are ignored.
  `LanguageModel.params()` returned `{}` in the extension probe.
- Exception mapping:

  | Exception | kind |
  |---|---|
  | abort from the deadline (recorded source) | `timeout` |
  | abort from the caller (recorded source) | `cancelled` |
  | `QuotaExceededError` | `too_long` |
  | `NotSupportedError` thrown while using a `responseConstraint` | `invalid_output` (message: "Gemini Nano cannot produce this structured output") |
  | `NotSupportedError` otherwise | `unavailable` |
  | `NotAllowedError` | `unavailable` |
  | anything else during a prompt with a constraint | `invalid_output` |
  | anything else | `unavailable` |

- Download (UI only, in `NanoStatus`): text readiness and image readiness
  are shown separately. Each one that is `downloadable` or `downloading`
  gets its own button ("Download for text" uses TEXT_OPTS; "Enable image
  input" uses IMAGE_OPTS).
  - Its click handler calls `LanguageModel.create({...<that button's opts>,
    monitor(m){ m.addEventListener('downloadprogress', e =>
    setProgress(e.loaded)) }, signal})` as its FIRST statement, with no
    `await` before it.
  - It shows progress and a Cancel button (which aborts the signal), then
    destroys the session, then rechecks both availabilities.

### 4.4 Model lists

- `openai-list`: `GET {baseURL}/models` (with Bearer if there is a key).
  Items come from `data[]`: `id`, plus `images`, taken from DeepSeek's
  `input_modalities`, Moonshot's `supports_image_in` or OpenRouter's
  `architecture.input_modalities`; otherwise `null`. For OpenRouter,
  `supported_parameters` is also stored in `modelMeta`. A 404 returns
  `{supported:false, models:[], partial:false}`.
- `gemini-paged`: `GET {baseURL}/models?pageSize=100`, following
  `pageToken` for at most 5 pages (after that, `partial:true`). Keep the
  models whose `supportedGenerationMethods` includes `generateContent`.
  `id` is `name` without the `models/` prefix.
- `anthropic-paged`: `GET {baseURL}/models?limit=100`, following
  `after_id` while `has_more`, for at most 5 pages. `images` comes from
  `capabilities.image_input`.
- `none` (qwen, zhipu): `{supported:false, models:[], partial:false}`. The UI shows only
  a text field.
- `fixed-nano`: `{supported:true, partial:false, models:[{id:'gemini-nano',
  label:'Gemini Nano (on-device)', images:
  availability(IMAGE_OPTS)==='available'}]}`.
- Every branch returns exactly `{supported, models, partial}`
  (`models:[]`, `partial:false` when unsupported).

### 4.5 HTTP (`http.js`)

`fetchWithDeadline(url, init, {deadlineMs, signal, maxRetries=2})`:
- One `AbortController` for the whole operation (the deadline plus the
  caller's signal). It covers every attempt, every body read and every
  backoff sleep; the sleep can be aborted.
- Retries on 429, 500, 502, 503, 504, 529 and on a network `TypeError`: at
  most 2 retries, with a 1 s then 2 s backoff.
- `Retry-After` (in seconds or as an HTTP date) is honored if it fits in
  the remaining time. If it does not, stop at once with `rate_limit`
  (429) or `overloaded` (503, 529).
- Options: `credentials:'omit'`, `referrerPolicy:'no-referrer'`,
  `cache:'no-store'`.
- Deadlines are ABSOLUTE per public operation: `generate` 120 s (Nano 240 s);
  `listModels` 20 s shared by ALL pages; each `testConnection` mode is its
  own operation: 45 s for cloud providers, 240 s for Nano. The Settings
  button runs the modes one after another.
- Abort classification comes BEFORE the exception name: an abort caused
  by the deadline → `timeout`; by the caller's signal → `cancelled`.
  The operation records which one fired.

### 4.6 Errors (`errors.js`)

`class ProviderError extends Error`, with the fields `{providerId, kind,
status, retryable}`.
- `message` is the locally written user message, because existing callers
  display `err.message`.
- The constructor never receives response bodies, headers or request data.
- Logging is `console.error('[provider]', {providerId, kind, status})`
  only.

| Condition | kind | retryable | message (template) |
|---|---|---|---|
| resolveConfig: key/model/URL missing or invalid | not_configured | no | "<Provider> is not set up: <what is missing>. Open Settings." |
| no host permission (`permissions.contains` is false) | permission | no | "Chrome needs your permission to contact <host>. Open Settings and click Grant access." |
| HTTP 401 | auth | no | "<Provider> rejected the API key. Check it in Settings." |
| HTTP 403 | forbidden | no | "<Provider> refused the request (403). The key may lack access to this model or region." |
| HTTP 404 | bad_request | no | "<Provider> does not know the model or address. Check the model name and region." |
| other HTTP 400/422 | bad_request | no | "<Provider> rejected the request. The model may not support this feature (for example structured output or images)." |
| 429 after retries, or Retry-After too long | rate_limit | yes | "<Provider> rate limit reached. Try again in a minute." |
| 500/502/504 after retries | server | yes | "<Provider> had a server error. Try again later." |
| 503 or 529 after retries (529 is retried like 503) | overloaded | yes | "<Provider> is overloaded. Try again later." |
| HTTP 402 | billing | no | "<Provider> reports a billing or credit problem on this account." |
| HTTP 413 | too_long | no | "The request is too large for <Provider>. Remove images or shorten the text." |
| any other non-2xx status | server (5xx) or bad_request (4xx) | 5xx yes / 4xx no | the matching template above |
| 2xx with non-JSON body, malformed JSON, missing fields, non-string or whitespace-only answer | invalid_output | no | "<Provider> returned an answer in the wrong format." |
| deadline reached | timeout | yes | "<Provider> did not answer in time." |
| the caller aborted | cancelled | no | "Cancelled." |
| network TypeError after retries | network | yes | "Could not reach <host>. Check your connection." |
| finish length, or empty after length | truncated | no | "The answer was cut off (token limit reached)." |
| refusal / content filter / safety | refused | no | "<Provider> declined to answer this request." |
| JSON extraction or validation failed; empty answer | invalid_output | no | "<Provider> returned an answer in the wrong format." |
| images present but caps.images is false | images_unsupported | no | "This model cannot read images. Remove the images or choose another model." |
| Nano not available or not supported | unavailable | no | "Gemini Nano is not available on this device or browser right now." |
| Nano context overflow | too_long | no | "The input is too long for Gemini Nano. Shorten the abstract or table of contents." |

No error message is ever built from a response body, and no raw
exception or `cause` is attached to a ProviderError. (The v2 idea of
reading provider error codes is dropped.)

### 4.7 Test connection

`testConnection(cfg, {mode})`:
- **`text` mode:** `generate(cfg, {system:'You are a test.',
  userText:'Reply with the single word OK.', maxOutputTokens:
  16})` (§4.1 raises it to 8192 when `thinkingOn`). Success means
  `text.trim().toUpperCase().replace(/[.!]$/, '') === 'OK'`.
- **`json` mode:** `generate(cfg, {system:'You are a library cataloger.',
  userText:'Give one Library of Congress subject heading for a book about
  cats. Use kind "topical", confidence 90, uri null, and a one-sentence
  analysis.', schema: TEST_SCHEMA})`. Success means a valid result.
- Returns `{ok, mode, effectiveJsonMode, error?: ProviderError}`.
- The Settings "Test connection" button runs text first, then json, and
  shows both lines ("Connection OK", then "Structured output OK
  (json_object)" or the error message).
- For `custom` and `lmstudio`, it runs json once per mode with a
  temporary, unsaved override (`testConnection(cfg, {mode:'json',
  jsonModeOverride})`), in the order `json_schema` → `json_object` →
  `prompt`, and suggests the first that passed. `effectiveJsonMode` comes
  from `GenerateResult.mode`. Prompt-mode success is labeled "JSON checked
  locally (not enforced by the server)". The user saves the choice as
  `jsonMode`.
- Missing configuration returns the `not_configured` error without any
  network call. Nano runs text and json through the same `generate()`.

## 5. Permissions

### 5.1 Manifest

- `host_permissions`: `https://id.loc.gov/*` (unchanged).
- `optional_host_permissions`: every `regions` origin in §3.2 as
  `<origin>/*` (both regions), plus `https://*/*`, `http://localhost/*`
  and `http://127.0.0.1/*`.
- `permissions`: `storage` (unchanged). Nothing else changes in P3.

### 5.2 Helpers (`permissions.js`)

- `originFor(cfg)` → `new URL(cfg.baseURL).origin + '/*'`, or `null` for
  Nano.
- `hasAccess(origin)` → `chrome.permissions.contains({origins:[origin]})`.
- `requestAccess(origin)` → `chrome.permissions.request(...)`.
- Adapters call `hasAccess` before every network request; false gives a
  `permission` error. Nano never touches permissions.

### 5.3 URL validation (custom, LM Studio)

Synchronous `validateBaseURL(str)`:
- `new URL()` must parse it.
- The scheme is `https:`, or `http:` only for the hosts `localhost` and
  `127.0.0.1`. IPv6 `[::1]` is REJECTED.
- No username or password, no query and no fragment.
- A trailing `/` is removed.
- Returns `{ok, url}` or `{ok:false, reason}`.

### 5.4 Settings transaction (draft vs saved)

**Gesture rule.** For every cloud action below, the click handler does, in
this order and with no `await` before step 3: (1) synchronous draft
validation (URL via `validateBaseURL`), (2) synchronous origin
calculation from the draft and the registry, (3)
`chrome.permissions.request({origins:[origin]})`, which is called EVERY
time (it does not prompt again when the permission is already granted).
Only after it resolves may the handler await `ready()`, take locks, or
use the network. Nano skips steps 2–3.

`ProviderSettings` edits a DRAFT (React state) for one provider. The
actions:

| Button | Gesture work (synchronous start) | Then |
|---|---|---|
| **Save** | Follow the Gesture rule above (origin from the DRAFT) | granted → `saveProviderDraft(id, draft, base)` (stale → reload message); denied → save NOTHING and show "Permission needed to contact <host>" |
| **Save & use** | same | granted → `saveProviderAndActivate(id, draft, base)` |
| **Test connection** | same permission step, using the draft | runs §4.7 against the DRAFT (unsaved) |
| **Load models** | same permission step, using the draft | `listModels` on the draft; updates the `modelMeta` cache |
| **Grant access** (shown when a saved provider lacks permission) | Gesture rule, but the origin is validated and computed from the SAVED configuration, not the draft | re-check |

- Nano: Save and Save & use skip the permission step.
- Revocation (the user removes the permission in Chrome): the next call
  fails with `permission`, and Settings shows Grant access.

## 6. UI

- **Popup (launcher).** After `settings.ready()` it shows the active
  provider and model, and ONE status. The status precedence is:
  1. "Settings could not be loaded" (error)
  2. "Choose a model" (model is null)
  3. "API key missing"
  4. "Server address missing" (custom/lmstudio)
  5. "Permission needed"
  6. Nano "Not available" or "Download needed" (from a fresh availability
     check)
  7. "Ready"

  "Open LCSH Tool" is enabled only when the status is Ready. "Settings" is
  always enabled.
- **Opening the app.** Call `chrome.runtime.getContexts({contextTypes:
  ['TAB'], documentUrls:[chrome.runtime.getURL('app.html')]})`, also
  matching `app.html#settings`.
  - If an app tab exists: `chrome.tabs.update(tabId, {active:true, url:
    <app.html or app.html#settings>})` and `chrome.windows.update(windowId,
    {focused:true})`. If that throws (the tab was closed meanwhile), create
    a new tab.
  - Otherwise, create a new tab.
- **App.**
  - A Settings button in the header. `#settings` opens `SettingsPage`, and
    `hashchange` is handled.
  - `SettingsPage` shows the provider list and `ProviderSettings`, or
    `NanoStatus` for Nano.
  - `ProviderSettings` is the draft form: region (when
    `regionSelectable`), key (a password field with show/hide), base URL
    (custom, lmstudio), model (free text plus a "Load models" list), JSON
    mode (custom, lmstudio), images override (when the caps say images are
    unknown), and the buttons of §5.4.
- **Workflow screens.**
  - The suggestion step shows "Using <provider> · <model>" next to its
    button.
  - The MARC step (automatic today) shows the same label in its status
    area. On an error it shows an inline message and a **Retry MARC
    generation** button.

## 7. Legacy bridge (`legacyBridge.js`)

`geminiService.js` is reduced to exported pure functions, with no fetch and
no keys:
- the existing default prompt text;
- `buildSuggestionPrompt(bibliographicInfo, systemPromptRules) → {system,
  userText}`;
- `buildMarcPrompt(highScoringTerms) → {system:'', userText}`;
- `selectMarcEligible(recommendations)`, the existing
  `similarity > 30 && bestMatch` filter;
- `parseLcshSuggestions(response)`, unchanged;
- `parseMarcRecords(response, terms)`, unchanged, now exported.

```js
export async function legacyGenerateSuggestions(bibliographicInfo, systemPromptRules, {signal} = {})
// → { candidates:[{content:{parts:[{text}]}}], provenance:{providerId, model} }
export async function legacyGenerateMarc(recommendations, {signal} = {})
// → { marcRecords: {[term]: string}, provenance:{providerId, model} | null }
```

- Suggestions take ONE settings snapshot at the start of the call
  (`resolveConfig` of the active provider) and use it for the whole call.
- MARC order: (1) `terms = selectMarcEligible(recommendations)`; (2) if
  empty, return `{marcRecords:{}, provenance:null}` (no config needed, no
  network, even when no provider is set up); (3) otherwise take the ONE
  snapshot and continue.
- Both pass their `signal` into `generate()`.
- Images: `bibliographicInfo.images` (`[{data, name, type, size}]`) becomes
  `[{mimeType: type, dataUrl: data}]`.
- **Suggestions:** `generate(cfg, {...buildSuggestionPrompt(...),
  schema:null, temperature:0.2, maxOutputTokens:4096})`. When `thinkingOn`
  is true, §4.1 raises the limit to 8192. The function returns the
  Gemini-shaped envelope, which `parseLcshSuggestions` reads unchanged.
- **MARC:** `terms = selectMarcEligible(recommendations)`.
  - If `terms` is empty, return `{marcRecords:{}, provenance:null}` with no
    network call (the current behavior).
  - Otherwise call `generate(... temperature:0.1, maxOutputTokens:4096)`,
    wrap the text in the envelope, call `parseMarcRecords(envelope,
    terms)`, and return `{marcRecords, provenance}`.
- **Provenance (a small, additive P3 contract):**
  - `BibliographicInfoForm` stores the suggestion `provenance` in
    AppContext as `suggestionProvenance`.
  - `FinalRecommendations` stores the MARC `provenance` in local state.
  - The saved history entry adds `suggestionProvenance` and
    `marcProvenance`, each `{providerId, model}` or null. The rest of the
    entry is unchanged, and old entries without these fields still render.
- Nano through the bridge works when the prompt fits (§4.3 budget);
  otherwise the user sees the `too_long` message. Markdown quality with
  small models is not a P3 acceptance criterion.

## 8. Tests

### 8.1 Unit (vitest)

Set-up:
- Add `vitest` at a pinned exact version that supports the repo's Node 24
  (the coder states the version chosen).
- Add the script `"test": "vitest run"` and `vitest.config.js`
  (environment `node`).
- `test/setup.js` holds fakes for `chrome.storage.local` (with
  `onChanged`), `chrome.permissions`, `navigator.locks` (an in-memory
  exclusive lock shared by all fake pages), and `LanguageModel`.

Requirement → test matrix (each row has at least one `it`):

| # | Behavior | Test |
|---|---|---|
| 1 | migration | fresh; legacy key only; legacy key + a different new key (the new one is kept); already migrated; crash after step 4 (the next run removes the legacy key); two fake pages migrating while a third saves a new key and selects DeepSeek (forced interleaving through the fake lock): the final state keeps the user's key and choice |
| 2 | updateProvider | two pages patch different fields of the same provider → both are kept |
| 3 | registry | every entry has every field of §3.1 with the §3.2 value; every region URL is https except the lmstudio loopback default; every origin is in `manifest.json` `optional_host_permissions` |
| 4 | capabilities | every `json`/`images` rule of §3.3, including OpenRouter `structured_outputs` vs `response_format` vs neither; DeepSeek/Moonshot metadata; a hand-typed model → unknown; `imagesOverride`; OpenAI temperature omitted |
| 5 | schema | `assertSchema` rejects each forbidden form; `validate` on at least 12 valid/invalid values; exact `toGeminiSchema(TEST_SCHEMA)` and `toAnthropicSchema(TEST_SCHEMA)` fixtures |
| 6 | extract | fenced JSON; prose around JSON; braces inside strings; `<think>` blocks (closed and unclosed); no JSON |
| 7 | request fixtures | parameterized over EVERY registry entry and region: the exact URL, headers and body in text mode, in JSON mode and with an image |
| 8 | answer mapping | per adapter: stop; length → truncated; refusal; content_filter; safety; empty content; thought parts skipped (Gemini); only text blocks read (Anthropic) |
| 9 | errors | each row of §4.6; `err.message` is the template; the key string never appears in `message`, in `JSON.stringify(err)`, or in any `console.*` call, even when the mocked server echoes it in a JSON body, an HTML body and a header |
| 10 | http | 429 → 200 retry; 503 ×3 → overloaded; Retry-After as seconds and as a date, fitting and too long; a stalled body read hits the deadline; abort during backoff → cancelled; the deadline covers all attempts |
| 11 | no downgrade | a 400 in json mode comes back as `bad_request` for every provider, with exactly one fetch call |
| 12 | listModels | OpenAI-style list; 404 → unsupported; Gemini paging, prefix strip and the 5-page cap; Anthropic paging; missing permission → permission error; the cache is written |
| 13 | Nano | no API; each availability state; `create` options match the availability options; `responseConstraint` passed; image → Blob; budget fits / too_long with both API-name families; each exception mapping; destroy on success, on error and on cancel |
| 14 | permissions | `originFor`; `validateBaseURL` table (at least 3 valid and 8 invalid forms, including `[::1]`); Nano skips permissions |
| 15 | bridge | the suggestions envelope is parsed by the unchanged `parseLcshSuggestions`; MARC returns `{marcRecords}` keyed by the original terms; zero eligible terms → no network call; the snapshot is kept when settings change mid-call; image mapping |
| 16 | testConnection | text and json success and failure; "not OK" fails; not_configured without a fetch; custom tries all three modes with the override and saves nothing |
| 17 | stale drafts | tab A saves a key; tab B (dirty, older base) saves the model → `stale`, nothing written; a clean form auto-refreshes; Save & use = one write |
| 18 | listing without a model | fresh OpenAI/OpenRouter/LM Studio/custom draft with no model → Load models works; persisted metadata is reloaded after a restart; every branch returns `{supported, models, partial}` |
| 19 | bridge provenance | suggestions with provider A, MARC with provider B, then save → both fields right; a settings change during either request → snapshot kept; MARC with zero eligible terms and NO provider configured → `{marcRecords:{}}` |
| 20 | Nano extras | image download uses IMAGE_OPTS; cancel during create and during measure; deadline vs caller abort; a late session is destroyed; empty image array → text path; two images in order |
| 21 | transport/schema extras | 402, 413, 529, other 4xx/5xx; 200 with HTML / bad JSON / wrong types / a whitespace answer; nullable enum → Gemini wire enum without null; Anthropic 16-union preflight; listModels deadline shared across pages |
| 22 | extraction | escaped quotes and backslashes; two objects → invalid; trailing garbage after one object; fenced JSON |
| 23 | Anthropic temperature | bridge requests (0.2 / 0.1) to Anthropic contain no `temperature` |
| 24 | malformed 200 + secrets | a 200 response with HTML, bad JSON or wrong types that ECHOES the key → `invalid_output`; the key appears in no message, `JSON.stringify(err)`, or `console.*` call, including the existing caller logging path (`BibliographicInfoForm`, `FinalRecommendations` catch blocks) |
| 25 | settings readiness failure | `chrome.storage.local.get` rejects during `ready()` → the popup shows "Settings could not be loaded" and the app shows an error instead of crashing |
| 26 | old history | a history entry saved by dev v1.1.0 (no `suggestionProvenance`/`marcProvenance`) renders in `ConversationHistory` without errors |

Gate: `npm run build` exits 0 with only the 3 baseline bundle-size
warnings, and `npm test` passes completely. The lead records the passed
count and compares it with the count the coder reports.

### 8.2 Chrome acceptance (run by the LEAD, not the coder)

The lead's harness supplies the keys from the lead's `.env` at run time;
the coder never reads `.env`. The runs use the throwaway profile. Each item
is recorded as PASS, FAIL or UNVERIFIED, with evidence.

1. **Migrated user:** build dev v1.1.0, save a Gemini key the old way,
   then load the P3 build in the same profile. The key shows under Gemini,
   a full 5-step run with Gemini works, and `geminiApiKey` is gone from
   storage.
2. **Test connection** (text and json) for Gemini, OpenRouter (one strict
   model and one json_object-only model), DeepSeek and LM Studio. The
   Gemini json test proves the nested, nullable `responseSchema` path.
3. **One full 5-step run** each with OpenRouter, DeepSeek and LM Studio.
4. **Permissions (unsaved draft):** Save with permission denied →
   nothing is saved; clicking Save again shows the prompt again and, when
   granted, saves.
   **Permissions (saved configuration):** revoke the permission of a saved
   provider in chrome://extensions → the permission message appears and
   Grant access (origin from the SAVED configuration) restores it.
5. **Two app tabs:** a settings change in one appears in the other.
6. **Popup:** it reuses an existing app tab, and Settings navigates that
   tab to `#settings`.
7. **MARC error:** the Retry button works.
8. **Gemini Nano:** the owner runs Test connection (text and json) and one
   5-step flow in their daily Chrome. The throwaway profile cannot run
   Nano in an extension.
9. **OpenAI, Anthropic, Qwen, Zhipu, Moonshot, MiniMax:** there are no
   keys, so these are covered by unit fixtures only and reported as
   UNVERIFIED live.
10. **Real Chrome permission flows:** for a denied UNSAVED draft, Save,
    Save & use, Test and Load models each leave nothing saved and prompt
    again when retried; for a SAVED configuration lacking access, Grant
    access requests the saved origin. Nano shows no permission prompt.
11. **Popup closed during migration** (close it right after opening with a
    legacy key) → the next open completes the migration.

**Completion rule for P3:** the build and unit gates pass; acceptance
items 1–7, 10 and 11 PASS with the keyed providers; item 9 may stay
UNVERIFIED; item 8 (the owner's Nano check) is a DEFERRED gate that must
pass before the Phase 6 release, not before P3 is committed.

## 9. Constraints for the coder

- Do not read or modify `.env`, `.claude/`, `.codex/` or
  `docs/multi_agent/`.
- Do not change `src/services/locService.js` or the LOC workflow.
- Do not add dependencies other than `vitest` (and a DOM-free test helper
  if strictly needed; name it and say why).
- Follow the escalate-never-reconcile rule: if a spec statement is
  impossible or contradicts the code, classify it as BLOCKING or
  NON-BLOCKING and report it.

## 10. Changes from v2 (review round 2 → v3)

- **#1** MARC returns `{marcRecords, provenance}`; prompt and parser
  ownership is one-way (§1, §7).
- **#2** A Web Lock across pages; migration order and conflict handling
  (§2).
- **#3** An executable registry shape with every value filled in
  (§3.1–3.2).
- **#4** A capability resolver and persisted model metadata; OpenRouter
  uses `structured_outputs` for strict mode (§3.3).
- **#5** OpenAI temperature is never sent; Zhipu gets no thinking
  parameter; the thinking token default applies to the bridge; the Qwen
  workspace limit is stated (§3.2, §4.1).
- **#6** Anthropic also strips `maxItems` (§4.2).
- **#7** Object root, schema-definition checks, a literal `TEST_SCHEMA`,
  and code-point string lengths (§4.2).
- **#8** No downgrade at all, and no message parsing (§4.1, §4.6).
- **#9** A draft/saved transaction table; Nano is exempt; IPv6 is
  rejected; DeepSeek's single region is stated (§3.2, §5).
- **#10** A full error table; `ProviderError extends Error`; a `cancelled`
  kind; a neutral truncation message (§4.6).
- **#11** Nano: one deadline, ignored parameters, exception mapping, and
  the reserve stated as a heuristic (§4.3).
- **#12** Two provenance fields (§7).
- **#13** A defined test connection (§4.7).
- **#14** Popup status precedence, tab reuse with `#settings`, and the MARC
  status area with Retry (§6).
- **#15** A requirement → test matrix plus Chrome acceptance (§8).
- **#16** The lead (not the coder) supplies the keys; the Anthropic probe
  fact is attributed (`.dispatch/provider_probe_facts.md`).
