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

## Rules from fixed findings (P4 code reviews and P5 spec reviews, 2026-09-27)

13. **Operation identity comes first.** An async operation reserves its
    token/revision and AbortController SYNCHRONOUSLY, before its first
    `await`. After every `await` it checks that it is still current, and it
    checks once more immediately before any commit (state write, storage
    write, file deletion), with no `await` in between. Detection: any
    `await` between "check current" and "commit".
14. **Every change invalidates what depends on it.** When an input changes
    (a retry, a new choice, a new run, a new installation), every result
    derived from the old input is invalidated or regenerated in the same
    transition. Detection: a state transition that changes an input but
    does not touch its dependents.
15. **Verify what you will use, not what you sent.** Hashes/counts of a
    stream prove the stream, not the stored copy; verify the bytes that will
    later be read. Detection: an integrity claim about data at rest that was
    computed only in flight.
16. **Contracts are copied, never paraphrased.** Queries, normalization, MARC
    parsing and similar shared contracts are reproduced byte-for-byte from
    the lead-owned source and pinned by a test (sha256 or the shared
    vectors). Lead-owned fixtures are never edited by the coder.
