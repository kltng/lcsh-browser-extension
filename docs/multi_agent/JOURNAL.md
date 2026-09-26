# Journal

## 2026-09-26

- **Planning.** I read lcsh-pwa, lcsh-browser-extension-litert-lm and
  lcsh-onnx/db-builder. Owner decisions are in `PLAN.md`. Scope: the PWA
  provider list (refreshed) + Anthropic + LM Studio + Gemini Nano; Ollama
  dropped; three lookup backends (LOC API, core DB, full DB).
- **Signing key purge.** `dist.pem`/`dist.crx` were removed from all history
  on `main` and `dev` with git-filter-repo in a fresh clone. Checks: trees
  are byte-identical apart from the two files, and commit metadata is
  identical. Force-pushed with `--force-with-lease` against the backed-up
  SHAs. Backup: `~/work/_backups/lcsh-browser-extension-pre-purge-2026-09-26/`.
  GitHub still serves the old commits by SHA; the owner must ask GitHub
  Support to purge them.
- **Base branch.** `origin/dev` was 9 commits ahead of `main` (suggest2 API,
  MARC 651, store files). The feature branch was re-created from `dev`.
- **Secret exposure found.** `.env` (3 live keys) was NOT git-ignored in this
  public repo. I added `.env` and `.env.*` to `.gitignore` before any commit.
- **Live resources.** The Gemini, OpenRouter and DeepSeek keys work.
  LM Studio works (`Access-Control-Allow-Origin: *`). Ollama 0.34.4 returns
  403 to any `chrome-extension://` Origin; the owner dropped Ollama.
- **Accounts.** Unset `CLAUDE_CONFIG_DIR` gives the account A account; an
  explicit `$HOME/.claude` gives account B. This contradicts the global
  CLAUDE.md note. Main coder = `~/.claude-work` (account A); backup = explicit
  `~/.claude` (account B).
- **Databases.** The server's `lcsh-ft.db` sha256 matches HF `lcsh-db-ft`.
  LOC's source files are newer than the 2026-05-24 build (LCSH/LCGFT
  2026-09-23, LCNAF 2026-06-29). Owner: rebuild from LOC in a new public
  repo `kltng/lcsh-db-builder` with a weekly GitHub Actions check and
  rebuild. The builder base is `kltng/lcsh-onnx/db-builder`.
- **Phase 0.** Watchdog installed; dispatch artifacts and `.dev-profile/`
  git-ignored. Baseline `npm ci` + `npm run build`: exit 0, 3 bundle-size
  warnings (baseline).
- **Smoke tests: all PASS.** Coder main (account A) and backup (account B), each
  about $0.25–0.31 and 7 turns: write, build, git and network OK. Exact-match
  `--allowedTools` denied a compound build command; the coder retried it
  bare and said so. Reviewer (gpt-6-astra, verified in the rollout): 0 MCP
  tools, write blocked.
