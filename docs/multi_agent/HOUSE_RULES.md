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

## Rules from fixed findings

(none yet)
