# Multi-Agent Team Workflow — LCSH extension: providers, Gemini Nano, local DB

This file is the contract for how the agent team works on this project. The
owner approved the ground rules, and the tech lead maintains this file.
Method: the `multi-agent-team` skill. At project start, check its open
field reports with
`gh issue list -R kltng/application-skills --label skill-feedback`.
Plan: `docs/multi_agent/PLAN.md`.

## Team roster

| Role | Agent/CLI | Model | Invocation (smoke-tested 2026-09-26) |
|---|---|---|---|
| Tech lead | this Claude session | the session's own model | — |
| Coder | `claude -p` | `opus` (alias) | `CLAUDE_CONFIG_DIR=$HOME/.claude-work claude -p "Read and follow the instructions in <ABS prompt path>" --model opus --permission-mode acceptEdits --allowedTools <list> --output-format json < /dev/null > <result.json>` |
| Backup coder | `claude -p` | `opus` (alias) | same, but with `CLAUDE_CONFIG_DIR=$HOME/.claude` set explicitly (account B) |
| Strict reviewer | `codex exec` 0.155.1 | `gpt-6-astra`, reasoning medium | `codex exec --sandbox read-only --ignore-user-config --disable apps --disable browser_use --disable computer_use --disable image_generation -m gpt-6-astra -c model_reasoning_effort="medium" -C <repo> -o <last_message.md> - < <prompt.md> > <output.log> 2>&1` |
| QC | lead-run scripts | — | — |

Account trap: with `CLAUDE_CONFIG_DIR` unset, `claude` is the account A
account. With `CLAUDE_CONFIG_DIR=$HOME/.claude` set explicitly, it is
account B. Before EVERY dispatch, run `claude auth status` with the exact same
environment and write the email in the journal (field report #91).

Reviewer fallback: Opus 5.5 read-only. It is not independent (same vendor
as the coder), so its reviews are flagged and get a codex spot-check later.

## Capability envelope (smoke tests, 2026-09-26)

- **Coder, both accounts:** PASS on writing files, `npm run build` (exit 0),
  `git status`, and network (id.loc.gov 200). `modelUsage` confirms
  the opus alias (plus the CLI's internal haiku helper). No managed
  permission rules on the account A account. The `--allowedTools` patterns
  match the WHOLE command: `Bash(npm run build)` denies
  `npm run build > log 2>&1; tail`. List the exact commands a phase needs,
  and tell the coder to run them bare.
- **Reviewer:** 0 `mcp__` tools with `--ignore-user-config --disable apps`
  (field report #90 cure works). Writes are blocked ("Operation not
  permitted"). The rollout shows `"model":"gpt-6-astra"`. It still has
  `collaboration.spawn_agent` and `web__run`, so every review prompt
  forbids spawning sub-agents.

## Owner ground rules

- The lead writes NO product code. Docs, specs, the journal, `.gitignore`
  and ops commands are the lead's.
- Git: work on the branch `feat/multi-provider-local-db` (based on `dev`).
  Commit and push are allowed. No merge to `main` or `dev`.
- Hugging Face publishing to `kltng/lcsh-db-lite` is approved. Creating the
  public repo `kltng/lcsh-db-builder` is approved.
- Field-report issues to `kltng/application-skills` are allowed.
- **Protected, never touched by agents:** `.env` (Gemini, OpenRouter and
  DeepSeek keys), `.claude/`, `.codex/`, any harness config. Keys never
  appear in prompts, logs, commits or screenshots.
- Trust but verify: agent claims are checked independently when it matters.

## Machines and state

- Mac (lead + agents): repo `~/work/lcsh-browser-extension`.
  31 GB free disk, so no large data here.
- Build server `<build-server>` (ssh as the owner): database builds and HF
  uploads. The HF token lives in `~/projects/lcsh-benchmark/.env` (kltng,
  write role). It is read into the environment for one command only.
- **Dev-harness state:** live tests use a throwaway Chrome user-data-dir at
  `<repo>/.dev-profile/` (git-ignored). Nothing is written to the owner's
  daily Chrome profile at `~/Library/Application Support/Google/Chrome`.
  At the project end, delete `.dev-profile/` and check that the daily
  profile has no dev leftovers.
- Dispatch artifacts live in `<repo>/.dispatch/` (git-ignored; the repo is
  public).

## Dispatch protocol (skill §2)

- Long prompts go in files under `.dispatch/<phase>/`. The argv only points
  at the file.
- Pair a watchdog and a completion waiter with every dispatch:
  `~/work/lcsh-browser-extension/scripts/agent_watchdog.sh <pid> 600 <label> <paths>`.
- Completion = deliverable files on disk, never the exit code.
- Capture full output to files. Never `tail` a review.
- Every build dispatch lists `HOUSE_RULES.md` under READ FIRST.
- Standing clause, in every dispatch: escalate, never reconcile; classify
  as BLOCKING or NON-BLOCKING first.

## Review loop

spec → spec review until CONFIRMED → build → lead ops pass (`npm run build`
plus tests) → strict review (hunt list plus precedent sweep) → lead triage
with documented overrules → fix loop → re-verify (full build plus full
tests) → live pass in Chrome → commit + push at the phase gate.

## Liveness signal paths

| Agent | Session artifacts | Notes |
|---|---|---|
| Coder (account A) | `~/.claude-work/projects/-Users-<user>-work-lcsh-browser-extension/*.jsonl` | Different from the lead's dir, so there is no self-observation |
| Backup coder (account B) | `~/.claude/projects/-Users-<user>-work-lcsh-browser-extension/*.jsonl` | SHARED with the lead's session. Map the coder to the jsonl that greps its prompt filename (field report #94) |
| Reviewer | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Check the `"model":` field for gpt-6-astra |

## Gate requirements

- `npm run build`: exit 0, and no new warnings beyond the 3 baseline
  bundle-size warnings.
- The unit test suite (vitest, added in Phase 3): assert the PASSED COUNT,
  not the exit code.
- Every phase gate: `git ls-files` contains every new source file.

## Journal

`docs/multi_agent/JOURNAL.md`: same-day entries, committed with the work.
At the project end: sweep for unfiled skill field reports.
