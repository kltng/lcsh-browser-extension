# SPEC — Multi-provider AI, Gemini Nano, and local LCSH database

Status: DRAFT v1, 2026-09-26. Author: tech lead. Phases 3–5 of
`docs/multi_agent/PLAN.md`. It must be reviewed (CONFIRMED) before any code
is written. Base branch: `feat/multi-provider-local-db` (from `dev`, v1.1.0).

## 0. Ground rules

- JavaScript + React 18 + MUI 5 + webpack 5, as today (`AGENTS.md`). No
  TypeScript, no framework change.
- Read `docs/multi_agent/HOUSE_RULES.md` before building.
- Reference code (read-only, in `.dispatch/ref/`):
  `lcsh-pwa/lib/*.ts` (provider list, prompts, pipeline) and
  `litert-lm/src/lib/pipeline/db*.ts` (sqlite-wasm + OPFS worker, download).
- Measured facts from probes (2026-09-26, Chrome 153, see JOURNAL):
  - sqlite-wasm 3.53.4 works in a module Worker of an MV3 extension page
    with CSP `script-src 'self' 'wasm-unsafe-eval'`: OPFS SAH-pool VFS,
    `importDb(name, asyncChunkCallback)`, FTS5 with
    `unicode61 remove_diacritics 2`. Quota about 35 GB.
  - From a `chrome-extension://` page with host_permissions: Gemini,
    OpenRouter, DeepSeek, LM Studio (`http://localhost:1234`), LOC suggest2
    and HF all return 200; Anthropic and OpenAI return 401 for a fake key,
    so there is no CORS block.
  - Gemini Nano (owner's Chrome): `LanguageModel.availability()` gives
    "available" for text and image; `create` about 18 s the first time;
    one JSON prompt with `responseConstraint` about 9 s; contextWindow
    9,216 tokens; `LanguageModel.params()` returns `{}`; image input works.
    Nano invents non-LCSH forms, so lookup + selection are essential.
  - SQLite query-plan trap: without `ANALYZE` stats,
    `label_normalized=? AND authority=?` used the authority index and ran
    12x slower. The new DBs ship with `ANALYZE` and a composite index;
    extension queries must still be written so the plan is correct (§5.4).

## 1. Scope

In: provider layer (12 providers + Gemini Nano), settings UI and
migration, JSON pipeline ported from the PWA, lookup backends (LOC API,
local core DB, local full DB), DB download manager, unit tests (vitest).
Out: Ollama (owner dropped it), TypeScript, embeddings/vector search,
batch/CSV input, and a new stepper design beyond renaming.

## 2. Architecture

```
src/services/
  settings.js            load/save/migrate settings (chrome.storage.local)
  providers/
    registry.js          PROVIDERS: static metadata (§3.1)
    index.js             generate() dispatcher + testConnection() + listModels()
    openaiCompat.js      OpenAI + every OpenAI-compatible provider + LM Studio
    gemini.js            Google Gemini (generateContent)
    anthropic.js         Anthropic Messages API
    geminiNano.js        Chrome LanguageModel adapter
    json.js              extractJson(), schema helpers, repair of fenced JSON
  pipeline/
    suggest.js           step 1: bibliographic info -> {subjectAnalysis, terms[]}
    select.js            step 3: candidates -> selections (AI, with fallback)
    marc.js              step 4: MARC fields (dev's rules kept)
    budget.js            prompt size budgeting (Nano's 9,216-token window)
  lookup/
    index.js             getLookupBackend(settings) -> backend
    locApi.js            wraps dev's locService.js (suggest2), + LCGFT
    localDb.js           talks to the DB worker via a promise RPC
    normalize.js         normalizeLabel() — byte-identical port of the builder's
  db/
    db.worker.js         sqlite-wasm, OPFS SAH pool, queries (§5)
    dbManager.js         latest.json check, download, import, swap, delete
src/components/
  SettingsPage.jsx       provider + model + key + lookup backend + DB manager
  ProviderSettings.jsx
  LookupSettings.jsx     (includes DatabaseManager)
  NanoStatus.jsx         availability + "Download Gemini Nano" button
```

`geminiService.js` is replaced by `providers/` + `pipeline/`. Its callers
(`BibliographicInfoForm`, `FinalRecommendations`) are updated.
`locService.js` stays; `lookup/locApi.js` wraps it. `contentScript.js` is
unused on dev (not in the webpack entries or the manifest) and is deleted.

## 3. Providers

### 3.1 Registry (`registry.js`)

Each entry: `id`, `name`, `kind` (`openai` | `openai-compatible` | `gemini`
| `anthropic` | `chrome-nano`), `baseURL` (fixed, or `null` if user-set),
`keyRequired` (bool), `keyHelpUrl`, `defaultModel`, `supportsImages`
(default guess; the user can override per model), `jsonMode`
(`json_schema` | `json_object` | `prompt`), `hostPermission` (match pattern
or `null` if optional).

| id | kind | baseURL | key |
|---|---|---|---|
| `openai` | openai | `https://api.openai.com/v1` | required |
| `gemini` | gemini | `https://generativelanguage.googleapis.com/v1beta` | required |
| `anthropic` | anthropic | `https://api.anthropic.com/v1` | required |
| `deepseek` | openai-compatible | from PWA `provider-groups.ts` | required |
| `qwen` | openai-compatible | from PWA | required |
| `zhipu` | openai-compatible | from PWA | required |
| `moonshot` | openai-compatible | from PWA | required |
| `minimax` | openai-compatible | from PWA | required |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | required |
| `lmstudio` | openai-compatible | `http://localhost:1234/v1` (editable) | none |
| `custom` | openai-compatible | user-set, required | optional |
| `gemini-nano` | chrome-nano | — | none |

Base URLs for the Chinese providers: the coder takes them from the PWA,
then checks whether each provider now documents a different
(international) endpoint. Any change is reported, not silently applied.
Default models: `gemini` → `gemini-2.5-flash` (current default, verified
live); `deepseek` → the first chat model returned by its `/models` (live
2026-09-26: `deepseek-flash`, `deepseek-v4-pro`); others → from the PWA
registry, marked "unverified" in code comments. The model field is always
free text, with a list from `listModels()` when available.

### 3.2 Common interface (`providers/index.js`)

```js
/**
 * @param {ProviderConfig} cfg   {providerId, apiKey, baseURL, model}
 * @param {GenerateRequest} req  {system, userText, images:[{mimeType, dataUrl}],
 *                                schema (JSON Schema object) | null,
 *                                temperature, maxOutputTokens, signal}
 * @returns {Promise<{text: string, json: object|null, usage: object|null}>}
 */
export async function generate(cfg, req) {}
export async function testConnection(cfg) {}      // tiny prompt; returns {ok, message}
export async function listModels(cfg) {}          // [] if not supported
```

Rules for every adapter:
- Timeout: an AbortController with 90 s for generate (Nano: 180 s), 15 s
  for list/test. The caller's `signal` also aborts.
- Retry: only on 429 and 5xx, at most 2 retries, backoff 1 s then 2 s.
  Honor `Retry-After` if it is at most 10 s.
- Errors: throw `ProviderError {providerId, status, userMessage}`. The
  user message says what to do ("Invalid API key for DeepSeek — check
  Settings"). Never include the key, the request body or response headers.
- Keys go in headers, never in URLs (Gemini: `x-goog-api-key`; dev
  currently uses `?key=`, which must be removed).
- JSON: if `schema` is given, use the strongest mode the provider supports
  (§3.3). Always pass the result through `extractJson()` (strips ```` ``` ````
  fences, takes the first balanced JSON object) and a small validator for
  the required keys. If JSON still fails, `json` is `null` and the pipeline
  falls back (§4).
- Images: only sent if the provider/model supports images. Otherwise the
  UI shows a warning before running: "This model cannot read images; they
  will be ignored."

### 3.3 Adapter specifics

- **openaiCompat.js:** `POST {baseURL}/chat/completions`, `Authorization:
  Bearer` (omitted if there is no key). Images as `image_url` data URLs.
  JSON: `openai` → `response_format: {type: "json_schema", json_schema:
  {name, schema, strict: true}}`; others → `response_format: {type:
  "json_object"}`, plus the schema text in the system prompt. If the
  provider rejects `response_format` (400 that mentions it), retry once
  without it. `listModels`: `GET {baseURL}/models`.
- **gemini.js:** `POST {baseURL}/models/{model}:generateContent`,
  `x-goog-api-key`. `systemInstruction`, `inlineData` images,
  `generationConfig.responseMimeType = "application/json"` +
  `responseSchema` (convert the JSON Schema to Gemini's OpenAPI subset:
  drop `additionalProperties`, `$schema`). `listModels`:
  `GET {baseURL}/models`, keep models whose `supportedGenerationMethods`
  include `generateContent`.
- **anthropic.js:** `POST {baseURL}/messages` with headers `x-api-key`,
  `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access:
  true`. Images as base64 `image` blocks. JSON: a single tool whose
  `input_schema` is the schema, with `tool_choice: {type: "tool", name}`;
  read `content[].input`. `listModels`: `GET {baseURL}/models`.
- **geminiNano.js:** uses the global `LanguageModel`.
  - `availability(opts)` with `expectedInputs` text (+ image when there
    are images) and `expectedOutputs` text `en`.
  - States: `available` → use; `downloadable`/`downloading` → the UI shows
    a "Download Gemini Nano" button; `create()` must be called inside that
    click (user activation) with a `monitor` for `downloadprogress`;
    `unavailable` → provider disabled, with the reason text.
  - JSON through `responseConstraint: schema`.
  - Create a new session per pipeline step (`initialPrompts` with the
    system prompt) and `destroy()` it after the step.
  - Context budget: before prompting, measure the input with
    `session.measureContextUsage?.(input) ?? session.measureInputUsage?.(input)`
    if available, otherwise estimate tokens as chars/3. Keep the input at or
    below 75% of `contextWindow` (fallback `inputQuota`) by trimming per
    `budget.js` (§4.4).
  - `listModels` returns `["gemini-nano"]`.

### 3.4 Permissions

- `host_permissions` (fixed): id.loc.gov, api.openai.com,
  generativelanguage.googleapis.com, api.anthropic.com, openrouter.ai, and
  the four Chinese-provider hosts.
- `optional_host_permissions`: `https://*/*`, `http://localhost/*`,
  `http://127.0.0.1/*`. On saving LM Studio or a custom base URL, call
  `chrome.permissions.request({origins: [origin + "/*"]})` inside the Save
  click. If refused, show why and do not save.
- Hugging Face: NOT in host permissions. HF sends
  `access-control-allow-origin: *` (probe confirmed), so no permission is
  needed.
- Add `"unlimitedStorage"` to `permissions` (DB files of several GB must
  not be evicted). Update `STORE_PERMISSIONS.txt` with a justification for
  each new permission.
- CSP: `"content_security_policy": {"extension_pages": "script-src 'self'
  'wasm-unsafe-eval'; object-src 'self'"}`.

### 3.5 Settings (`settings.js`)

`chrome.storage.local` key `settings`:

```js
{
  version: 2,
  activeProviderId: 'gemini',
  providers: { [id]: { apiKey?: string, model?: string, baseURL?: string, supportsImages?: boolean } },
  lookup: { backend: 'loc-api' | 'local-core' | 'local-full' },
  systemPromptRules: string   // moved from the top-level key
}
```

Migration (runs once, idempotent): if there is no `settings` and there is
a legacy `geminiApiKey`, create settings with `providers.gemini.apiKey` =
that key and `activeProviderId: 'gemini'`. Move a legacy `systemPromptRules`
too. Remove the legacy keys only AFTER the new object is written and read
back. Unit-tested, including "migration interrupted midway".

The popup becomes a launcher: it shows the active provider/model and a
status (key set? Nano available?), with buttons "Open LCSH Tool" and
"Settings". The API key form moves to the Settings page. The Launch button
is enabled when the active provider is usable (key present, or keyless).

## 4. Pipeline (port of `lcsh-pwa/lib/ai-pipeline.ts`)

### 4.1 Suggest (`suggest.js`)

JSON Schema:
`{subjectAnalysis: string, terms: [{suggestedHeading: string, reason: string,
kind: "topical"|"name"|"geographic"|"genre"}]}` (1–8 terms). `kind`
routes lookups: topical/geographic → LCSH; name → LCNAF (+ LCSH); genre →
LCGFT. The system prompt = the user's editable rules + the fixed output
instructions (ported from the PWA prompt, adding `kind`). Temperature 0.3.
Text fallback: if JSON fails, ask again once in plain text for "one heading
per line", and parse the lines (strip numbering and bullets).

### 4.2 Lookup (`lookup/`)

```js
/** @returns {Promise<Candidate[]>} Candidate = {uri, id, label, authority:'lcsh'|'lcnaf'|'lcgft',
 *   matchKind:'exact'|'variant'|'text'|'api', altLabels?:string[], note?:string,
 *   deprecated?:boolean, useInstead?:Candidate[]} */
backend.search(term, {kind, limit})
backend.info()   // {name, release?, ready:boolean, reason?}
```

- `locApi`: dev's suggest2 code: LCSH (+ LCNAF for `name`, + a new
  `authorities/genreForms/suggest2` call for `genre`). Keep dev's
  concurrency (3), spacing (500 ms) and retry.
- `localDb`: see §5.4.
- If the local backend is selected but not ready (no DB, or a DB with a
  wrong `schema_version`), the pipeline stops with a clear message and a
  "Use LOC API this time" button. It never silently switches.

### 4.3 Select (`select.js`)

JSON Schema (from the PWA `aiSelectionSchema`, plus `lcgft` in the source
enum): per original term, `bestMatchUri` (or null), `confidence` 0–100 and a
reason; `additionalTerms` at most 3, and only URIs that were in the
candidate list. **Any URI not in the candidate list is dropped** (no
invented headings). Fallback when the AI step fails: Levenshtein best
match per term (dev's `similarityUtils`), marked `method: 'similarity'`.
Deprecated candidates: shown with "deprecated — use X"; the AI sees
`useInstead` and may choose the replacement.

### 4.4 Budget (`budget.js`)

Candidate limits per term: cloud 10, Nano 4. Text caps: abstract 2,000
chars, TOC 1,500, notes 800 for Nano (cloud: 8,000 / 4,000 / 2,000). If
still over budget, drop the lowest-ranked candidates first, then trim the
TOC, then the abstract. Unit-tested with a fake measure function.

### 4.5 MARC (`marc.js`)

Keep dev's current MARC step and rules (651 for geographic headings,
second indicator 0 for LCSH/LCNAF), but called through `generate()`. Add
655 _7 $2 lcgft for genre terms. Validate each field with a regex
(`^6(00|10|11|30|50|51|55) [0-9 ][0-9 ] \$a`). If validation fails, build
a minimal field from the heading: split on `--`, first part `$a`,
the other parts `$x`, and mark it "check subfield codes".

### 4.6 UI flow

Keep the 5-step stepper. Rename "Review Scraped Results" → "Review LOC
Matches" ("Review Matches" when a local DB is used). Show the provider and
model used, and the lookup source with the DB release, on the results
screen and in the saved history. The CSV export escapes quotes (`"` → `""`)
and includes the source + release.

## 5. Local database

### 5.1 Source (from the `lcsh-db-builder` spec)

HF dataset `kltng/lcsh-db-lite`:
`https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/main/latest.json`,
then `lcsh-core.db.gz` or `lcsh-full.db.gz`. Schema v2 is documented in
`lcsh-db-builder/docs/SCHEMA.md` (to be copied into this repo as
`docs/DB_SCHEMA.md` when it is final). Until the first release exists,
tests use a small fixture DB built with the same schema (§7).

### 5.2 Worker (`db.worker.js`)

- One module Worker, created once per app page. Message RPC:
  `{id, op, args}` → `{id, ok, result|error}`. Ops: `status`, `open`,
  `search`, `lookupExact`, `importStart/Chunk/Finish`, `delete`, `meta`.
- sqlite-wasm from npm `@sqlite.org/sqlite-wasm`. Its `.wasm` is copied
  into `dist/` by webpack (CopyPlugin) and loaded from the extension
  package. No remote code.
- VFS: `installOpfsSAHPoolVfs({name: 'lcsh-pool'})`. The DB file name
  includes the profile and release: `/lcsh-<profile>-<release>.db`. The DB
  is opened read-only (`?mode=ro` / flags `r`) after import.

### 5.3 Download manager (`dbManager.js`)

1. `GET latest.json` (no cache). Show the release, date, sizes and counts
   before downloading. Warn if the free quota
   (`navigator.storage.estimate`) is below 2.5× `db_size`.
2. `navigator.storage.persist()`.
3. `fetch(file.gz)` → `body.pipeThrough(new DecompressionStream('gzip'))`
   → worker `importDb(newName, asyncChunkCallback)`. Progress = compressed
   bytes read / `gz_size`. A Cancel button aborts and deletes the partial
   file.
4. After import: open read-only, check `schema_version == 2`, `profile`,
   `release`, `PRAGMA quick_check == ok` and the row counts against
   `latest.json`. On any mismatch: delete the new file and show an error.
5. Only then switch `settings.lookup.backend` and delete the old file.
   At most one DB file at a time, except during a swap.
6. Update check: when the app page opens, at most once per 24 h, fetch
   `latest.json`. If there is a newer release than the installed one,
   show "New LCSH data available (release X, N changes)" with a link to
   `CHANGES.md`. Never auto-download.
7. The UI warns "Keep this tab open until the download finishes". A
   download does not survive closing the tab; it restarts from zero.

### 5.4 Queries (in the worker; the SQL lives in a pure module `lookup/sql.js` so node tests can run it)

For `search(term, {kind, limit})`:
1. `n = normalizeLabel(term)`. Exact: `SELECT … FROM auth WHERE
   label_normalized = ?1 AND authority IN (…)` → `matchKind 'exact'`.
2. Variant: `SELECT a.… FROM alt_label l JOIN auth a ON a.id = l.auth_id
   WHERE l.label_normalized = ?1 AND a.authority IN (…)` → `'variant'`.
3. If the main heading (before the first `--`) differs from the term,
   repeat 1–2 for it.
4. Text: FTS5 on `auth_fts` and `alt_label_fts`, the query built from
   quoted tokens (every `"` doubled; FTS operators never injected), joined
   to `auth`, `ORDER BY bm25`, filtered by authority. `'text'`.
5. Merge and dedupe by `uri`; order exact > variant > text; cut to `limit`.
6. Deprecated rows (`deprecated = 1`) are returned with `useInstead` from
   `hierarchy WHERE rel = 'use'`.
- Every query in `sql.js` has a test that runs `EXPLAIN QUERY PLAN` on the
  fixture DB (after `ANALYZE`) and asserts it uses the label index, not a
  scan or the authority index.

`normalizeLabel` must be byte-identical to the builder's `normalize_label`
(§6 of the builder spec). Tests run the builder's shared
`normalize_vectors.json` (copied into `src/services/lookup/__fixtures__/`).

## 6. Security and privacy

- Keys: only in `chrome.storage.local`. Never logged, never in errors,
  never in history, CSV or copied text. The Settings key field is a
  password field with a show/hide toggle.
- History saves the provider id and model, never the key; images are still
  stripped (existing behavior).
- `PRIVACY_POLICY.md`: update the list of third parties (each provider,
  used only if the user picks it; Hugging Face for the DB download; LOC).
  Nano runs on the device.

## 7. Tests (vitest, `npm test`)

Add `vitest` as a devDependency and the script `"test": "vitest run"`.
Required unit tests:
- settings: migration (fresh, legacy key, already migrated, interrupted).
- each adapter: request building (URL, headers, body, JSON mode, images)
  and response parsing, with a mocked `fetch`; error mapping (401, 429 then
  200, 500 ×3, timeout); proof that the key never appears in thrown
  messages.
- json.js: fenced JSON, prose around JSON, nested braces in strings,
  invalid JSON.
- geminiNano.js: a fake `LanguageModel` (available / downloadable /
  unavailable, `responseConstraint` passed through, `destroy` called,
  budget trimming).
- pipeline: suggest → lookup (fake backend) → select with a hallucinated
  URI (must be dropped) → fallback path.
- lookup/sql.js + normalize: run against a fixture DB built in the test
  with the node build of `@sqlite.org/sqlite-wasm` (or `better-sqlite3` if
  the wasm node build cannot load FTS5; say which). Includes query-plan
  assertions, FTS quoting of `"`, `*`, `-`, `AND`, `NEAR(`, and diacritics.
- marc.js: validation + fallback.
- CSV escaping.
Gate: `npm run build` (only the 3 baseline size warnings) and `npm test`
with the PASSED COUNT reported.

## 8. Build phases (each with its own review loop)

- **Phase 3:** §3 (all of it) + settings UI + popup + migration +
  vitest + tests for §3. No pipeline changes yet: the old Gemini path must
  keep working, through the new `generate()`.
- **Phase 4:** §4 + `lookup/locApi.js` + UI renames + CSV fix + tests.
- **Phase 5:** §5 + `lookup/localDb.js` + LookupSettings/DatabaseManager +
  tests. Needs the first `lcsh-db-lite` release, or a fixture-only build
  until then.

## 9. Open questions for review

- Q1. Is a hand-written adapter set (§3) better than the Vercel AI SDK
  used by the PWA? The lead's reasons for hand-written: bundle size (the
  popup is already 320 KiB), no Zod, full control of timeouts, headers and
  errors, and Nano needs a custom adapter anyway. Counter-argument: the AI
  SDK already solves structured output across providers.
- Q2. Is 75% of the context window the right Nano budget?
- Q3. Should the DB worker live in an offscreen document so downloads
  survive closing the tab? (Proposed: no; keep the tab open.)
