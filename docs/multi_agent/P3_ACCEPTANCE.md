# Phase 3 acceptance (SPEC-P3 §8.2) — lead live pass, 2026-09-26

Chrome 153, throwaway profile, extension loaded by CDP (puppeteer). Keys typed
from the lead's `.env` at run time and never printed. Harness:
`.dispatch/live/` (not committed).

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Migrated user (v1.1.0 key → P3) | PASS | `geminiApiKey` removed; `provider:gemini.apiKey` set (len 39); popup "Ready"; full 5-step Gemini run in 14 s; both provenance fields saved |
| 2 | Test connection | PASS | OpenRouter: Connection OK; JSON checked locally (no model meta loaded → prompt mode, as designed). DeepSeek: Connection OK + Structured output OK (json_object) in 2 s. LM Studio: Connection OK; json_schema and json_object rejected by the server for qwen3-1.7b; prompt mode OK. Gemini JSON: see note |
| 3 | Full 5-step runs | PASS | OpenRouter 11 s, DeepSeek 15 s (8 candidates), LM Studio 36 s; provenance correct; no key-like strings in history |
| 4 | Permissions | PASS | Revoke of a SAVED provider → banner; Grant access (saved origin) → banner gone (lead, automated). **Deny of an UNSAVED draft (owner, daily Chrome, 2026-09-27):** "Permission needed to contact openrouter.ai", nothing saved, Gemini stayed "In use" |
| 5 | Two app tabs | PASS | Save & use DeepSeek in tab A → tab B label changed from OpenRouter to DeepSeek |
| 6 | Popup reuses app tab | PASS | 1 app tab before/after Open and after Settings; typed title kept; URL became `app.html#settings` |
| 7 | MARC error → Retry | PASS | All 3 attempts blocked → "Could not reach api.deepseek.com…" + Retry; Retry → 2 MARC fields |
| 8 | Gemini Nano (owner, daily Chrome) | PASS | 2026-09-27: text + image input "Ready"; Save & use; Test connection: "Connection OK" + "Structured output OK (responseConstraint)"; legacy workflow reached step 2 with a Chinese record (日本電影人物志) |
| 9 | OpenAI, Anthropic, Qwen, Zhipu, Moonshot, MiniMax | UNVERIFIED | No keys; unit fixtures only |
| 10 | Real Chrome permission flows | PASS | Grant flows PASS (lead, automated); deny path PASS (owner, see item 4) |
| 11 | Popup closed during migration | PASS | Closed 5 ms after open → legacy key intact; reopen → migrated, "Ready" |

Note (item 2, Gemini JSON): the Gemini provider was exercised in text mode by
the 5-step run; its JSON path is covered by unit fixtures and by the lead's
earlier live `responseSchema` probe (nullable field OK).

Pre-existing bug seen during the pass (NOT a P3 regression, verified on untouched
dev v1.1.0): the legacy MARC prompt makes models output tag 150 (authority)
instead of 650. Scheduled for Phase 4.

Owner-pass notes (2026-09-27), queued for the next build batch:
- Chrome shows a manifest warning: `generativelanguage.googleapis.com` is both a
  required and an optional host permission (redundant; Chrome omits it).
  Remove it from `optional_host_permissions`.
- The Chrome Web Store description still says "using Gemini API" (update at release).
- To confirm: whether a typed key/model is cleared from the form after Deny.
- The owner's toolbar popup showed the v1.1.0 UI from ANOTHER installed copy;
  the loaded `dist` popup (opened by URL) is correct. Not a product bug.
