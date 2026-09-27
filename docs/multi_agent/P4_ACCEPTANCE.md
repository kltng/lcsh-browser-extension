# Phase 4 acceptance (SPEC-P4 §11 and §13) — lead, 2026-09-27

Build: commit a666f8c (784 tests pass). Chrome 153, throwaway profile, the
extension loaded by CDP (puppeteer). Keys typed from the lead's `.env` at run
time and never printed. Harness: `.dispatch/live/` and `.dispatch/eval/` (not
committed).

**Test manifest.** Under CDP, `chrome.permissions.request` now waits for a
native prompt that automation cannot answer. The live pass therefore used a
copy of the build whose manifest lists the provider hosts as required
permissions (name tagged `[LIVE-TEST BUILD]`). The shipped manifest is
unchanged. The real permission flows were checked in Phase 3 (lead + owner).

## §11 Prompt-evaluation gate

120 records from the frozen manifest `docs/evidence/p4_eval_manifest.json`
(LCSHBench dev, seed 20260927). The real extension modules ran in Node
(suggest → LOC lookup → AI selection → recommendations). Model:
`google/gemini-2.5-flash` through OpenRouter. LOC answers came from a frozen
cache, so both variants saw the same LOC data. Scorer: `lcsh-benchmark-score`
(LCSHBench commit ce81a9c).

| Variant | Errors | Unresolved LOC | Exact P / R / F1 | 95% CI (F1) | Root F1 |
|---|---|---|---|---|---|
| A: "3 to 6" (default) | 0 | 0 | 0.201 / 0.157 / **0.177** | 0.146–0.209 | 0.309 |
| B: "up to 8" | 0 | 0 | 0.163 / 0.164 / 0.163 | — | 0.277 |

- Paired bootstrap, B − A: −0.0132, CI [−0.0355, +0.0078]. No evidence that B
  is better → **keep "3 to 6"**.
- Acceptance bar (exact F1 ≥ 0.152, the Gemini→DB→Jev baseline): 0.177 → **PASS**.
- Subdivision loss (a chosen heading is shorter than the suggestion): A 29/138
  = 0.210, B 0.181. Coverage: 119/120 records got at least one heading.
- Small-model check, `qwen/qwen3.8-flash`: 80 errors (77 timeouts, 3 rate
  limits); exact F1 0.078. Cause: it is a "thinking" model and exceeds the
  120 s deadline. **Phase 6 item:** send OpenRouter reasoning settings (or warn)
  for thinking models.

## §13 Live acceptance

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Full runs, 4 providers × 2 records (English "Analytical sociology…", Chinese 日本電影人物志) | PASS | OpenRouter 9 s / 10 s; DeepSeek 10 s / 9 s; Gemini direct 20 s / 26 s; LM Studio (qwen3-1.7b, prompt mode) 39 s / 24 s. Every recommendation had a real LC ID and link; MARC came from authority keys (e.g. `650 _0 $a Motion pictures $z Japan`); no "verified" wording anywhere. LM Studio's weak selection showed the exact-only fallback live |
| 2 | Nano evidence case ("Japanese cinema") | PARTIAL | Nano cannot run in a CDP-loaded extension. Covered by the unit fixture (honesty tests: an unmatched suggestion is listed with its outcome and never becomes a recommendation). The same record with 4 other providers never showed an invented heading as a recommendation. The owner's Nano run is item 7 |
| 3 | id.loc.gov blocked during lookup → "Lookup failed" + per-suggestion Retry | PASS | 12 requests aborted; every suggestion showed "Lookup failed: Could not reach id.loc.gov. Check your connection."; blocking lifted, one "Retry lookup" → that suggestion showed "3 candidates", the others stayed failed (Retry is per suggestion) |
| 4 | Provider failure during selection → §5.2 stop UI; "Continue without AI" | PASS | api.deepseek.com aborted during "Choose headings" → "Could not reach api.deepseek.com. Check your connection." with "Continue without AI (exact matches only)"; clicked → banner "only exact matches were kept", 4 exact matches and one "None — no unique exact match (the AI did not choose)". Note: a network failure was used instead of a revoked permission (same error path; revocation was tested in P3) |
| 5 | v1.1.0 and P3 history entries open read-only with correct labels | PASS | Injected one v1.1.0-shaped and one P3-shaped entry (with provenance), saved one new run, opened History: both listed; header "Saved by an older version. Its MARC was written by an AI model and was not checked."; "Unverified AI-written MARC (older version)"; P3 provenance shown; Copy wrote `UNVERIFIED (older version): 650 _0 $a Cats` |
| 6 | §11 numbers recorded | PASS | See above |
| 7 | Owner's Nano run | OPEN | Deferred release gate (owner, daily Chrome) |

Gemini direct: the first film attempts hit "overloaded" and "rate limit
reached" (Google's side); the error screens were correct. A later attempt
passed; one more hit "overloaded" again.

## Notes for later phases

- History opens only after "Save to history" at the end of a run (the stepper
  labels are not buttons). Same in v1.1.0, so not a regression. Consider a
  direct "History" button (Phase 6, UX).
- The P3 provenance line shows the provider id ("gemini") rather than its
  label ("Google Gemini"). Cosmetic.
- Owner question still open from P3: is a typed key/model kept in the form
  after Deny? (P4 claims the draft is kept.)
