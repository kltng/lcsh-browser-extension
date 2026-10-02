# Phase 5 acceptance (SPEC-P5 §11 and §13) — lead, 2026-10-01/02

Release under test: `kltng/lcsh-db-lite` **2026.10.01.1** (artifact commit
43a1c3f5), fetched live from Hugging Face. Builds: P5 fixes 3–10 (last code
commit 88f6bc5; 1211 tests pass). Chrome, throwaway profiles under the repo
(`.dev-profile-p5`, `.dev-profile-p5full`, `.dev-profile-faults`, all
gitignored), the extension loaded by CDP (puppeteer). Harness:
`.dispatch/live/` (not committed). Provider key read from the lead's `.env` at
run time, never printed.

**Test manifest.** As in Phase 4, the live copy adds the provider's host to
`host_permissions` and tags the name `[LIVE-TEST BUILD]`, because CDP cannot
answer the permission prompt. Same folder, so the same extension ID and OPFS.
The shipped manifest is unchanged. Row 5's faults used the separate §21 fault
build (`dist-faults/`, never shipped; tagged `[FAULT BUILD]`).

## §13 live rows

| Row | Result | Evidence |
|---|---|---|
| 1 Fresh profile, pointer + core download (CORS) | PASS | HF redirects to `us.aws.cdn.hf.co`; no host permission needed. |
| 2 Core install; records with `local-db` | PASS | Core installs in 11–20 s. Subject lookups from the DB; with core, names go online (6–13 LOC requests) and the source reads "Local database … and Library of Congress online". |
| 3 Full install; names offline; name MARC key online; offline text; §11; memory | PASS after fix 4 | Full installs in 250–279 s (import ~150 s, stored-byte check ~95 s). Names resolve offline (Lu Xun n50047988, Kurosawa n79091264, Mifune) with 0 LOC requests; name MARC keys fetched at build (2 requests) after fix 4; offline → "MARC not available offline" (once, after fix 5). Peak Chrome memory 1.56–1.61 GB summed, 529–674 MB largest process. |
| 4 Repair; core ↔ full; uninstall | PASS | Repair 279 s, new file replaces old; full→core 11–18 s; core→full 250 s; uninstall 5 s, setting back to online. Always exactly one DB file afterwards. |
| 5 Injected faults; cancel; repeated clicks; uninstall during install | PASS | UI part: cancel at 210 MB and at 1.04 GB of the check → stopped in ≤ 3 s, staging removed, old kept; one dialog, one operation; Uninstall/Repair disabled while busy. §21 fault build: all 11 faults end in the §21 state (table in JOURNAL 2026-10-01). Texts after fixes 7–9: disk full → "The database could not be stored. Free some disk space and try again." |
| 6 Close the tab at each phase and reopen | PASS | Tab closed during import and during the check, and Chrome killed during import → old install active and unchanged, no leftovers. Commit-moment cases covered by the §21 crash faults. |
| 7 Two tabs, takeover, popup, `#settings` | PASS | "open in another tab" → owner closes → "Try again" takes over; popup opens during an install; leaving and returning to `#settings` keeps the install running. |
| 8 Corrupted download | PASS after fixes 7 and 9 | One flipped byte in the 62 MB gzip → rejected, old kept, no staging, "The download was damaged; nothing was changed." |
| 9 Unsupported pointer; update banner | PASS | schema 3 → "A newer database format is available; update the extension to use it."; newer release → "New LCSH data available (release 2026.10.08.1)". An inconsistent pointer (release changed, paths not) is rejected. |

## §11 timings (Chrome, full DB, 3 runs per query)

| Query | ms |
|---|---|
| Worker start → ready | 82 |
| Q1 / Q2 | 0–4 |
| Q3a / Q3b "john" (warm) | ~460 / ~370 |
| Q3a / Q3b "united states" (warm) | ~200 / ~305 |
| Q3a / Q3b "history" (warm) | ~110 / ~120 |
| "smith john" | 10–23 |
| **First query of a session, "john" (cold)** | **6,257 / 4,387** |

Warm queries meet the < 1 s target. **Miss:** the first common-word query in a
session is cold (up to ~6 s; one lookup ~10 s once per session). Reported, no
design change made. Owner decision (see OWNER_TODO).

## Defects found live and fixed

| Fix | Defect | Found by |
|---|---|---|
| 3 | Worker starvation during import; replacement could delete the pool (pinned library's destructive init cleanup) | live row 3 + reviewer |
| 4 | Name MARC keys never fetched automatically (step change aborted them) | live row 3 |
| 5 | Choice change could leave name keys pending; deadline after backoff; offline text twice | reviewer + live |
| 6 | Fault build (§21); uninstall busy text | spec gap + live |
| 7 | Every install failure shown as "stopped responding" | live row 8 |
| 8 | Fault loading guards; stale "Cleanup pending" | reviewer + live row 5 |
| 9 | Corrupt gzip shown as a network error | live row 8 |
| 10 | Response body not released on every exit | reviewer |

## Open, non-blocking

- Cold first query (above).
- "Cancelled." is shown as a red error with "Try again" (cosmetic).
- The offer shows "download —, disk —" until the pointer is loaded in a session.
- Phase 5 follow-ups from earlier reviews: pending-entry assertion; driving the production adapter's `close()` in a test.
