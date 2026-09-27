# House rules

Rules for every build dispatch. The lead adds a rule each time a review
finding is fixed. Each rule names a defect CLASS and how to detect it.

## Standing rules (from AGENTS.md and the plan)

1. Follow `AGENTS.md`: JavaScript + JSX, React function components, MUI
   `sx`, JSDoc on exported functions, semicolons. New code uses 2-space
   indentation.
2. Secrets: never read, print or write `.env`. API keys live only in
   `chrome.storage.local`. They are never logged (`console.*`), never put
   in error messages, and never saved into conversation history or CSV
   export.
3. No remote code: every script and every `.wasm` file ships inside the
   extension package (Chrome Web Store rule).
4. Every `fetch` to an AI provider or LOC has a timeout (AbortController)
   and shows a user-friendly error.
5. Do not touch `.claude/`, `.codex/`, or other harness config.

## Rules from fixed findings (spec reviews, 2026-09-26)

Each rule names a defect CLASS and how to detect it.

6. **No response text in errors.** A user message, log line or thrown
   error must never contain text from a provider response (body, headers,
   raw exception, `cause`). Detect: grep for `.message` built from
   `response`/`data`/`body`, and for `cause:`; unit test with echoed keys.
7. **Keys only in headers.** An API key must never appear in a URL, a
   query string, a log, history, CSV or copied text. Detect: grep for
   `?key=` and `key=${`.
8. **Cross-page read-modify-write needs the lock.** Any write that depends
   on a value read from `chrome.storage` goes through the
   `'lcsh-settings'` Web Lock and checks a stale base where a form is
   involved. Detect: a `storage.local.set`/`remove` of a SETTINGS key (`provider:*`, `activeProviderId`, `settingsVersion`, `modelMeta:*`, `geminiApiKey`, `systemPromptRules`) outside `settings.js`.
9. **Permission request first.** In a click handler that may call
   `chrome.permissions.request`, nothing asynchronous comes before it.
   Detect: any `await` before `permissions.request` in the same handler.
10. **No silent guarantee changes.** No automatic fallback may weaken
    output guarantees (for example a JSON-mode downgrade) or switch
    backends without the user seeing it. Failures surface as ProviderError.
11. **Send only documented, capability-gated parameters.** Request fields
    (temperature, thinking, token-limit name, response_format) come from
    the registry/capability resolver, never hard-coded per call site.
12. **Every cleanup in `finally`.** Sessions, locks, object URLs and
    AbortControllers are released on success, error AND cancel. Detect:
    `create(`/`request(` without a matching `finally`.
