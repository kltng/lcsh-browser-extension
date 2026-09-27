# Phase 3 acceptance (SPEC-P3 §8.2) — lead live pass, 2026-09-26

Chrome 153, throwaway profile, extension loaded by CDP (puppeteer). Keys typed
from the lead's `.env` at run time and never printed. Harness:
`.dispatch/live/` (not committed).

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Migrated user (v1.1.0 key → P3) | PASS | `geminiApiKey` removed; `provider:gemini.apiKey` set (len 39); popup "Ready"; full 5-step Gemini run in 14 s; both provenance fields saved |
| 2 | Test connection | PASS | OpenRouter: Connection OK; JSON checked locally (no model meta loaded → prompt mode, as designed). DeepSeek: Connection OK + Structured output OK (json_object) in 2 s. LM Studio: Connection OK; json_schema and json_object rejected by the server for qwen3-1.7b; prompt mode OK. Gemini JSON: see note |
| 3 | Full 5-step runs | PASS | OpenRouter 11 s, DeepSeek 15 s (8 candidates), LM Studio 36 s; provenance correct; no key-like strings in history |
| 4 | Permissions | PARTIAL | Revoke of a SAVED provider → banner; Grant access (saved origin) → banner gone: PASS. **Deny path of an UNSAVED draft: not automatable** (Chrome under automation auto-accepts) → owner manual check |
| 5 | Two app tabs | PASS | Save & use DeepSeek in tab A → tab B label changed from OpenRouter to DeepSeek |
| 6 | Popup reuses app tab | PASS | 1 app tab before/after Open and after Settings; typed title kept; URL became `app.html#settings` |
| 7 | MARC error → Retry | PASS | All 3 attempts blocked → "Could not reach api.deepseek.com…" + Retry; Retry → 2 MARC fields |
| 8 | Gemini Nano (owner, daily Chrome) | DEFERRED | Gate before the Phase 6 release (SPEC-P3 completion rule) |
| 9 | OpenAI, Anthropic, Qwen, Zhipu, Moonshot, MiniMax | UNVERIFIED | No keys; unit fixtures only |
| 10 | Real Chrome permission flows | PARTIAL | Save & use / Test / Load models grant flows PASS (auto-accepted); deny path → owner manual check (with item 4) |
| 11 | Popup closed during migration | PASS | Closed 5 ms after open → legacy key intact; reopen → migrated, "Ready" |

Note (item 2, Gemini JSON): the Gemini provider was exercised in text mode by
the 5-step run; its JSON path is covered by unit fixtures and by the lead's
earlier live `responseSchema` probe (nullable field OK).

Pre-existing bug seen during the pass (NOT a P3 regression, verified on untouched
dev v1.1.0): the legacy MARC prompt makes models output tag 150 (authority)
instead of 650. Scheduled for Phase 4.
