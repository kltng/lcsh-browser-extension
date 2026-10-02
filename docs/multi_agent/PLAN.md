# Plan: multi-provider, Gemini Nano, and local LCSH database

Status: APPROVED by owner 2026-09-26.

## Goal

Make the extension work like `kltng/lcsh-pwa`:

1. **Many AI providers, not only Gemini.** The PWA's list (refreshed to
   current models): OpenAI, Google Gemini, DeepSeek, Qwen, Zhipu, Moonshot,
   MiniMax, OpenRouter, custom OpenAI-compatible URL. Added: **Anthropic
   Claude**, **LM Studio**. (Ollama dropped by owner 2026-09-26.)
2. **Chrome built-in Gemini Nano** (the Prompt API, `LanguageModel`). It
   runs on the user's computer and needs no API key.
3. **Three ways to check headings** (the user picks one in settings):
   - LOC online API (`id.loc.gov/.../suggest2`, the same as the PWA)
   - Local database, **core**: LCSH + LCGFT only
   - Local database, **full**: LCSH + LCGFT + LCNAF (names)

## Owner decisions (2026-09-26)

| Question | Decision |
|---|---|
| Database | Two slim databases (core, full), both without vector data, plus the LOC API option |
| Pipeline | Port the PWA pipeline (JSON output, lookup, AI selection, MARC) |
| Providers | PWA list refreshed + Anthropic + LM Studio + Gemini Nano. **Ollama skipped** (no dedicated provider, no live test) |
| Git | Feature branch `feat/multi-provider-local-db`, **based on `dev`** (v1.1.0); commit and push allowed; no merge to main or dev |
| Database | Rebuild from LOC source in new public repo `kltng/lcsh-db-builder`; weekly GitHub Actions check + rebuild; publish to HF `kltng/lcsh-db-lite` |
| Signing key | `dist.pem`/`dist.crx` purged from all history on main and dev, force-pushed 2026-09-26 (backup in `~/work/_backups/`) |

## Team

| Role | Agent | How it runs |
|---|---|---|
| Tech lead | Claude (this session) | Plans, writes specs, dispatches, verifies, runs builds and ops. Writes no product code. |
| Coder | Opus 5.5 | `claude -p` headless, `--model claude-opus-5-5`, `CLAUDE_CONFIG_DIR=$ACCOUNT_A_DIR` (account A) |
| Reviewer | gpt-6-astra, medium reasoning | `codex exec --sandbox read-only --ignore-user-config --disable apps -m gpt-6-astra -c model_reasoning_effort="medium"` |

Fallbacks:
- Coder: account B account, explicit `CLAUDE_CONFIG_DIR=$ACCOUNT_B_DIR`.
- Reviewer: Opus 5.5 in read-only mode. This is NOT independent (same vendor
  as the coder), so an independent spot-check follows once codex is back.

## Facts found during planning

- **lcsh-pwa** uses the Vercel AI SDK: `@ai-sdk/openai` and `@ai-sdk/google`
  natively, everything else through `@ai-sdk/openai-compatible`. It uses
  `generateObject` with Zod schemas, and falls back to plain text when a
  model can't produce JSON. It checks headings with LOC `suggest2`, not
  scraping. It has **no SQLite database** and **no Anthropic support**.
- **lcsh-browser-extension-litert-lm** already has working local-database
  code: official sqlite WASM in a Web Worker, stored in OPFS (the browser's
  private file storage) using the "SAH pool" method, with a streamed
  download, progress bar, version marker and delete. We reuse its approach
  (not its embedding/vector search).
- **HF database** `kltng/lcsh-db-ft/lcsh.db` is 4.35 GB. Tables: `auth`
  (LCSH 512,644 · LCGFT 2,637 · LCNAF 12,255,750), `alt_label`, `auth_fts`,
  `alt_label_fts`, `auth_embeddings` (vectors). HF serves it with
  `access-control-allow-origin: *` and byte ranges.
- **Gemini Nano (Prompt API)** is stable in extensions from Chrome 138. This
  Mac has Chrome 153. It needs macOS 13+, more than 4 GB of GPU memory (or
  16 GB RAM and 4 cores), and **22 GB free disk**. The first download needs
  a user click. English, Japanese, Spanish, German and French are
  supported. It can force JSON output with `responseConstraint`.
- **Live test resources (checked 2026-09-26).** Keys in `.env` (git-ignored):
  Gemini, OpenRouter, DeepSeek. All three answer. There are no OpenAI or
  Anthropic keys, so those two native paths are tested with mocked
  responses only.
  - The Gemini key sees gemini-2.5 through gemini-3.8 models.
  - DeepSeek's `/models` lists `deepseek-flash` and `deepseek-v4-pro`, but
    the old `deepseek-chat` still works. The PWA's model lists are stale.
  - LM Studio (`localhost:1234`) answers with `qwen/qwen3-1.7b` and sends
    `Access-Control-Allow-Origin: *`.
  - **Ollama 0.34.4 returns HTTP 403 to any request with a
    `chrome-extension://` Origin**, on both its native API and its
    OpenAI-compatible API. It returns 200 when there is no Origin.
    `OLLAMA_ORIGINS` is not set. Ollama also has no models pulled yet.
- **Build server** `<build-server>`: Ubuntu, 12 cores, 47 GB RAM, 464 GB free,
  Python sqlite 3.45.1, uv. Its `~/projects/lcsh-benchmark/data/lcsh-ft.db`
  has sha256 `fd531a9f…b738`, the same as HF `kltng/lcsh-db-ft` (x-linked-etag),
  so it is the exact published source. `lcsh.db` (stock embeddings) is next
  to it. Schema version 1: `auth`, `alt_label`, `hierarchy`
  (broader/narrower/related), `auth_fts`, `alt_label_fts` (external-content
  FTS5, `unicode61 remove_diacritics 2`), `auth_embeddings` (vec0, 256-d),
  `db_meta`. The slim DBs keep `hierarchy`. The database build and HF upload
  run on this server.
- **Gemini Nano is already downloaded** in your daily Chrome
  (`OptGuideOnDeviceModel`, v3Nano, 4.0 GB). A throwaway test profile would
  download it again. Phase 1 tries an APFS clone copy (`cp -c`, uses no
  extra disk) of the model folder into the test profile.
- **Claude accounts:** with `CLAUDE_CONFIG_DIR` unset, `claude` is account A;
  with `CLAUDE_CONFIG_DIR=$ACCOUNT_B_DIR` set explicitly, it is account B. Main
  coder = `$ACCOUNT_A_DIR` (account A). Backup coder = explicit `$ACCOUNT_B_DIR`
  (account B). Check `auth status` right before every dispatch.
- **This Mac has 31 GB free disk.** That is tight for building the
  databases and testing Nano. See Risks.

## Architecture (to be detailed in SPEC.md and reviewed before any code)

```
src/services/
  providers/        one "call the model" interface for all providers
    registry.js     provider list: id, name, base URL, key needed?, native/compatible
    aiSdk.js        OpenAI, Gemini, Anthropic, OpenAI-compatible (DeepSeek, Qwen,
                    Zhipu, Moonshot, MiniMax, OpenRouter, custom, LM Studio)
    geminiNano.js   Chrome LanguageModel adapter (same interface)
  pipeline/         ported from lcsh-pwa/lib/ai-pipeline.ts
    suggest.js      JSON: subject analysis + candidate headings
    select.js       AI picks the best LCSH match per term (Levenshtein fallback)
    marc.js         MARC 650/600/610/655 fields
  lookup/           one "find headings" interface, three backends
    locApi.js       id.loc.gov suggest2
    localDb.js      talks to the database worker
  db/
    db.worker.js    sqlite WASM + OPFS; exact, FTS and variant-label search
    dbDownload.js   download core/full from HF, progress, version, delete
```

Main design points:
- **JSON everywhere, with a text fallback.** Structured output where the
  provider supports it. Nano uses `responseConstraint`. If a model returns
  bad JSON, fall back to plain text parsing (same as the PWA).
- **Permissions.** Fixed cloud hosts go in `host_permissions`. A custom base
  URL (and LM Studio on localhost) use `optional_host_permissions`:
  the extension asks the user for that one origin when they save it.
- **Manifest CSP** adds `'wasm-unsafe-eval'` so sqlite WASM can run. All
  WASM ships inside the extension; no remote code (Chrome Web Store rule).
- **LOC suggest2 lookup already exists on `dev`** (`src/services/locService.js`, with retry on 429/503). It becomes the "LOC API" backend behind the new lookup interface.
- **Settings migration.** The old `geminiApiKey` becomes the Gemini
  provider key automatically.
- **Images.** Sent to providers that accept images. For text-only models
  (and Nano if image input is unavailable) the user sees a clear warning.
- **Keep the current stack** (JavaScript, React 18, MUI 5, webpack) to keep
  the change small. Add **vitest** for unit tests of pure logic (parsers,
  normalize, SQL builders, similarity, settings migration).

## Phases

Each phase goes through the full loop:
spec (lead) → spec review until CONFIRMED (reviewer) → build (coder) →
lead ops pass (build + tests) → strict review (reviewer) → fix loop →
live pass in Chrome (lead) → commit + push at the phase gate.

### Phase 0: Setup (lead)
- Create `WORKFLOW.md`, `JOURNAL.md`, `HOUSE_RULES.md`, watchdog script.
- Gitignore dispatch logs (`*_output.log`, `*_result.json`): this repo is
  public and those logs leak paths and usernames.
- `npm install` + `npm run build` baseline. Baseline commit.
- Smoke-test both agents: coder can write files and run `npm run build`;
  reviewer is read-only, and lists **0** `mcp__` tools (field report #90).
- Live tests use a **throwaway Chrome profile** in the repo (gitignored),
  not your daily Chrome profile.

### Phase 1: Spec + probes (lead writes, reviewer reviews)
Small experiments that settle design questions before any code:
- A. Can official sqlite WASM open the source `lcsh.db` (which contains a
  vector table it cannot read), and can FTS5 run on it? Open a small test
  DB in an extension worker with OPFS SAH pool.
- B. Gemini Nano on Chrome 153 in an extension page: `availability()`,
  JSON output with `responseConstraint`, image input.
- C. Provider calls from a `chrome-extension://` page: Anthropic (needs the
  `anthropic-dangerous-direct-browser-access` header), LM Studio.
- D. LOC `suggest2` from the extension.
- Check the current Vercel AI SDK version and each provider's current
  model list and endpoints (the PWA list is some months old).

### Phase 2: Database builder repo `kltng/lcsh-db-builder` (new, public)
Owner decisions 2026-09-26: rebuild from LOC source (not from the old
`lcsh-ft.db`), in a new public repo, scheduled on GitHub Actions.

- Source: LOC bulk N-Triples from `id.loc.gov/download/authorities/`
  (`subjects.skosrdf`, `subjects.madsrdf`, `genreForms.skosrdf`,
  `names.skosrdf`). On 2026-09-26 LOC's LCSH/LCGFT files were dated
  2026-09-23 and LCNAF 2026-06-29; the current DBs were built 2026-05-24,
  so they are stale.
- Start from the parser and schema in `kltng/lcsh-onnx/db-builder` (copied,
  with attribution), minus embeddings. Python + uv, pytest.
- Outputs: `lcsh-core.db` (LCSH + LCGFT) and `lcsh-full.db` (+ LCNAF), each
  with `auth`, `alt_label`, `hierarchy`, FTS5 tables, and `db_meta` (schema
  version, build date, LOC source ETags/Last-Modified, row counts, sha256).
- **Freshness check** (weekly cron): compare LOC ETags with the ones in the
  last release; stop if nothing changed.
- **Change report**: headings added, deleted and relabeled since the last
  release, published with each release.
- **Checks before publish**: row counts per authority, `PRAGMA
  integrity_check`, a fixed sample of lookups, and a mutation check (a
  corrupt DB must fail the gate).
- **Publish** to HF dataset `kltng/lcsh-db-lite` with a version tag. HF
  token as a GitHub secret (preferably a fine-grained token limited to that
  dataset).
- First, the lead measures a full build on the build server (time, peak
  disk, peak RAM, output sizes) to confirm it fits a GitHub runner (4 cores,
  16 GB RAM, about 14 GB disk, 6 h per job). If `full` does not fit, it
  falls back to the server and the owner decides.
- The first release is built on the server and uploaded with its HF token
  (user kltng, write role, checked 2026-09-26).

### Phase 3: Provider layer + settings UI
- Provider registry, AI SDK adapters, Nano adapter, model list fetch,
  "Test connection", optional host permission request, key migration.
- Settings screen in the app (provider, key, base URL, model); the popup
  shows the current provider and opens the app.

### Phase 4: Pipeline port + lookup interface
- Port suggest → lookup → select → MARC from the PWA to JSON.
- Wrap dev's existing suggest2 code as the `locApi.js` backend. Keep dev's
  MARC rules (651 for places, second indicator 0).
- Update the stepper screens, history saving and CSV export (also fix the
  CSV quote-escaping bug found earlier).

### Phase 5: Local database
- Worker + OPFS storage, downloader for core/full (progress bar; on
  failure it restarts from zero, like litert-lm), version check against
  the HF ETag, delete button, storage use shown.
- `localDb.js` lookup backend: exact match on normalized label, then FTS,
  then variant labels. Settings: choose LOC API / core / full.

### Phase 6: Whole-branch review + release prep
- One combined review of the whole branch (includes a privacy hunt: no API
  keys, paths or usernames in committed files).
- Full live pass: each lookup backend, Gemini Nano, Gemini, OpenRouter,
  DeepSeek, LM Studio.
- Update README and privacy policy (new providers + HF download; needed for
  the Chrome Web Store). Bump version. Push the branch. You decide on the
  PR and the merge.

## Owner answers (2026-09-26)

1. Plan: **approved**.
2. Keys: Gemini, OpenRouter, DeepSeek in `.env` (git-ignored). No OpenAI or
   Anthropic key: those paths are tested with mocks only. Ollama dropped.
   LM Studio runs locally.
3. Disk: database work runs on the build server. Gemini Nano is already
   in the owner's Chrome.
4. HF: publishing is approved; the server token (kltng, write) is used for
   the first upload.
5. Fallbacks: backup coder = account B account (explicit
   `CLAUDE_CONFIG_DIR=$ACCOUNT_B_DIR`). Reviewer = codex; no fallback needed
   unless it fails.

## Risks

- **Disk space** (see above). The Nano test may have to use your real Chrome
  profile if a throwaway profile would download the model again.
- **Full DB size.** With 12.3 million name records, `lcsh-full.db` may
  still be large (not measured yet; Phase 2 measures it).
- **Small-model quality.** Nano may give weak headings or break JSON rules.
  The text fallback and Levenshtein fallback limit the damage; the live
  pass measures it.
- **Store review.** New host permissions and `wasm-unsafe-eval` can slow
  Chrome Web Store review.

## Out of scope (found earlier, not part of this plan unless you ask)

- `dist.pem` (the extension signing key) is committed in this public repo.
  It should be removed and replaced with a new key. Separate task.
- Moving the code to TypeScript/Vite.
