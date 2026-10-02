# SPEC-UI2 — UI review, round 2 (workflow and presentation)

Status: v2, 2026-10-02. v1 was reviewed (APPROVE-WITH-CHANGES, 4 HIGH,
8 MEDIUM: `.dispatch/spec-review-ui2/last_message.md`); every replacement
text below is the reviewer's, folded in verbatim. Owner-approved scope: UI
review items 6–15, 17, 18 (round 1 = items 1–5, 16). Builds on SPEC-P4
(pipeline, honesty rule §0) and SPEC-P5 (local DB, §7 name keys, §8 UI, §9
history/exports), and the Phase 6 key guard (`keyGuard.js`).

Binding for every item: P4 §0’s honesty rule, the key guard at every exit, and run/revision fences including the extensions below. History v2 remains readable without rewriting stored entries. Old v2 entries retain their saved order, authority data, numeric confidence, and provenance defaults. The explicitly authorized delimiter and confidence presentation changes may affect their read-only display.

Legacy entries without `v: 2` retain the existing unverified-history adapter, warnings, copy prefixes, and behavior; do not sort or reformat their AI-written MARC through the authority formatter.

History panels remain read-only. This round does not restore saved entries into an editable run or add history export controls.

## 0. Integration baseline

Integration baseline: UI2 is specified against HEAD `6784e55`, then integrated after round 1’s four-step workflow with separate History navigation, Settings sections, plain match labels, and Matches summary.

Sections 1, 2, and 5 use round 1’s navigation and operation-leaving behavior; section 4 adds Output alongside its Settings sections; section 7 extends its provider list; sections 6, 11, and 12 update the resulting shared presentation. Preserve the plain match labels and derive the Matches summary from the current run after every edit or retry.

Step numbers are human-facing positions, not route or array-index contracts. Saving to history and navigating to History must use round 1’s navigation API. UI2 does not approve round 1’s implementation.

## 1. One main action on Matches (item 6)

Today: "Choose headings" (AI selection) and "Build recommendations" are
two buttons; "Continue without AI (exact matches only)" is a third path.

New:
- One primary button, **“Next: recommendations”**. It is enabled only when every current suggestion has a completed lookup result, no lookup or selection is pending, and at least one suggestion exists. Completed `partial`, `failed`, and `no-results` outcomes do not block it; missing results after cancellation do.
- A current selection is a completed AI selection or exact-only fallback for the current suggestion revision and the complete current lookup-revision snapshot. A selection mode, stage, or non-empty choices object alone does not establish freshness.
- If a current selection exists, Next builds recommendations and opens Recommendations. Otherwise it starts selection and builds/opens Recommendations only after that same operation has committed a current result.
- Preserve P4 §5.2: `invalid_output`, `truncated`, and `too_long` produce the existing automatic exact-only fallback, including its disclosure. This is a completed selection and may advance. Other non-cancellation errors stay on Matches with Retry, Settings, and **“Continue without AI (exact matches only)”**. That action applies the existing fallback, preserves manual overrides, builds, and advances. Cancellation never builds or advances.
- Manual choices, including “Use none”, retain `mergeSelections` precedence. Manual choices alone do not count as a completed selection: Next still runs selection when none is current. Partial lookup results contribute only their returned candidates; failed and no-results lookups retain their existing none reasons.
- **“Ask the AI again”** reruns selection without advancing and preserves manual overrides. It is available after a completed selection, including an exact-only fallback. Next reuses a current fallback rather than silently invoking AI again.
- Reserve the Next operation synchronously before any await. Build and navigation require the same run, suggestion revision, lookup revisions, operation identity, and continued ownership of the Matches view. Double clicks, cancellation, navigation to Back/Settings/History, edits, and lookup retries must prevent an obsolete continuation from building or navigating. A completed promise is not proof of success.
- While selection runs, show “Choosing headings…” and a Cancel action. Name-key resolution starts at build; navigation to Recommendations must not abort it. Preserve P5 §7 regeneration, caching, and retry behavior.

## 2. Edit the suggestions before lookup (item 7)

On the AI suggestions step, the user can:
- **remove** a suggestion;
- **edit** a heading's text;
- **add** a heading of their own, with a kind.

Authorship:

Suggestion authorship is `Suggestion.source: 'ai' | 'user'`. Newly generated suggestions are `ai`; an added heading or an applied change to heading text or kind is `user`. A no-op Apply preserves authorship. Clear the edited suggestion’s old AI reason; added headings have an empty reason.

Preserve this field through the suggestion factory, workflow state, history building, history rebuilding, and read-only history views. Existing v2 suggestions lacking the field default to `ai`; unsupported explicit values must not be presented as known AI or user authorship.

Use **“Your heading”** for user-authored suggestion text and **“AI suggestion”** for AI-authored text wherever that text appears. Use **“Suggestions”** as the mixed-list heading and the note: “These are proposed search headings, not LC authority records. The next step looks them up.” Original subject analysis remains identified as AI analysis of the work; editing headings does not regenerate it.

Authorship is independent of selection method. An AI-selected match for Your heading is still an “AI choice”; a manual match for an AI suggestion is still “Your choice”. Candidate and recommendation `source`, lookup provenance, and `marcKeySource` retain their existing authority-backend meanings.

Only backend candidates may supply recommendation labels, LC IDs, links, or MARC input. User text never becomes a candidate or recommendation merely because it was entered, edited, selected as a search term, or sorted.

Edits and invalidation:

Editing uses a local draft with Apply and Cancel. Opening or cancelling an editor does not change the run. Apply, Add, and Remove are available only in the live Suggestions view, after suggestion generation has completed.

Every accepted mutation is one atomic workflow transition: abort pending lookup, selection, name-key, and Next operations; increment a monotonic suggestion revision; clear all lookup results and pending flags, AI and manual selections, additional picks, selection errors/completion metadata, and recommendations; invalidate the name-key operation; and return the run to `suggested`. Preserve the bibliographic input and original generation provenance.

Every asynchronous commit, failure handler, and automatic navigation continuation must reject work from an older suggestion revision. Existing run/revision checks must be extended where necessary; clearing arrays or calling `leave()` alone is insufficient. A stale name-key failure must not invalidate a newer operation.

Resolved name keys and recorded reasons may remain cached by cid within the run under P5 §7, but cannot recreate recommendations before a new build; reused keys must pass `buildMarc()` against the current candidate.

Navigation back to Suggestions without a committed edit does not invalidate completed results. Before applying an edit to a run with downstream results, show: “Applying changes clears all matches and choices. Look up the headings again.”

Validation:

Trim heading text; require 1–200 Unicode code points and at least one Unicode letter or number. Reject duplicates under `normalizeLabel` with an inline error rather than silently dropping an entry. Allow at most eight suggestions. Removing all suggestions is allowed, but Lookup and Next remain disabled until one exists.

New headings require one of `topical`, `name`, `geographic`, or `genre` (displayed as “Genre/form”). Existing text-fallback headings may retain `unknown`; editing their text does not require guessing a kind.

Suggestion IDs must remain unique and fit the existing selection-schema ID limits. If IDs are reassigned after a mutation, all earlier operation tokens must first become invalid through the suggestion revision; no old lookup or selection may attach to a reassigned ID.

Exports:

Copy all and CSV remain recommendations-only; unmatched user or AI headings are not added as authority rows. Preserve all existing CSV columns and meanings, including `source`, `methods`, and numeric `confidence`. Append `suggestion_sources`, a JSON array aligned with `rec.selections`: `ai` or `user` for a linked suggestion, and null for additional picks without a source suggestion. Do not invent suggestion authorship for additional picks. Copy all gains no suggestion-text rows.

- The key guard checks user headings at the same exits (LOC query,
  selection prompt, history, exports, display).

## 3. Recommendations order (item 8)

For live runs and newly saved history entries, stably sort distinct recommendations after authority MARC building and name-key application: 600, 610, 611, 630, 647, 648, 650, 651, 655, then other available three-digit tags ascending. Recommendations whose MARC status is not `from-authority` go last.

Obtain the sort tag only from the successfully built MARC field. Never infer it from suggestion kind, wording, authority, or an unsupported authority key. This ordering does not add MARC mappings or support for 647/648.

Recompute from the canonical suggestion-order-then-additional-order sequence on every recommendation regeneration, including name-key completion and retry. Equal-tag and unavailable-field ties preserve that canonical order. Do not reorder selections within a recommendation.

Display, Copy all, CSV, and a new history snapshot use the same ordered list. Existing saved entries retain their stored order and are not regenerated or rewritten.

## 4. Subfield delimiter (item 9)

Add Settings → **Output** → **Subfield delimiter: `$` (default) or `‡`**. Persist it as an independent output preference; missing or invalid values resolve to `$`. Saving it must not overwrite provider or database settings. Apply saved preference changes to open views without rerunning lookup or selection.

Format only MARC fields with status `from-authority`, using their existing tag, indicators, and ordered `[code, value]` subfields. Substitute the delimiter only at structural subfield boundaries. Preserve codes, values, punctuation, spacing conventions, and literal characters within values. Do not transform headings, notes, unavailable reasons, or legacy AI-written MARC.

Apply this formatter to display, individual Copy, Copy all, and CSV `marc_field`. Run state and history retain canonical `$` MARC text and unchanged structured fields. Malformed historical structure must not be repaired by inventing authority data.

Check finished formatted display text through the display guard. Check the exact clipboard string or fully serialized CSV through the export guard after delimiter formatting, CSV formula protection, quoting, BOM, and line endings. Preserve existing key-length rules, field checks, key registries, and history-save checks.

## 5. Suggestions without an LC heading (item 10)

In the live Recommendations view, each suggestion without a chosen LC heading offers:
- **“Back to Matches”**: navigate to Matches and focus/scroll to the card identified by `suggestionId`.
- **“Edit search heading”**: navigate to Suggestions and open that suggestion’s draft editor. Opening does not issue a request or invalidate results. Apply follows §2; the user then explicitly starts Lookup.

These actions are absent from read-only history panels. Missing targets produce a local message and no mutation. Preserve the actual none reason, including failed lookup, AI choice of none, and manual none; do not describe every unchosen heading as an unsuccessful authority search.

## 6. AI confidence (item 11)

For each selection with `method: 'ai'` and integer confidence 0–100, display **“AI confidence: High”** (80–100), **Medium** (50–79), or **Low** (0–49), with a keyboard-accessible tooltip: “The AI’s own estimate (0–100): N”.

Apply this in Matches and Recommendations, including additional AI picks and read-only v2 history. Do not coerce null or invalid values to Low, aggregate multiple selections into one confidence, or assign confidence to manual/exact choices. Preserve numeric history and CSV values and their alignment with selection methods. Lexical similarity remains a separate measure.

## 7. Provider list (item 12)

In Settings → AI provider, show a small ✓ with accessible label **“Configured”** when the saved configuration has a non-empty key for a key-required provider, or an explicitly saved valid endpoint for LM Studio/Custom. Unsaved drafts do not count. The tooltip says: “Saved configuration; connection and access have not been verified.” “In use” continues to mean the active provider.

For Nano, show **“Available”** only after an availability result of `available`; downloadable, downloading, unavailable, unknown, or failed checks do not qualify. Checking this indicator must not create a session or start a download.

## 8. Describe-the-work form (item 13)

"Table of Contents" and "Additional Notes" sit in a collapsed section
**"More details (optional)"**.

Initialize the section open when either current form field contains text; otherwise initialize it closed. Users may toggle it. Expand when external form replacement supplies either field. “Start new search” clears both fields and resets the section closed. This does not introduce history-to-form restoration or change read-only history content.

## 9. Image checkbox (item 14)

Label: **"This model can read images"**, with a help icon whose tooltip
says "The provider does not report whether this model accepts images.
Tick this only if you know it does."

## 10. Popup database status (item 15)

The popup shows one line from saved settings: **“Offline database recorded: core (release X)”**, **“… full …”**, or **“Offline database: not installed”** when the record is absent. Invalid metadata displays **“Offline database: saved record needs attention”**; a settings-read failure displays **“Offline database: status unavailable”**.

Profile and release come from the saved record; the release in this spec is illustrative. This line does not assert database health, offline completeness, or the effective lookup backend. Read settings only; do not start a database worker or issue network requests. Refresh when installation settings change while the popup remains open.

## 11. Contrast (item 17)

All text meets WCAG 2.1 AA contrast (4.5:1 normal, 3:1 large) on its
background, including captions, "Current choice", helper texts and enabled
controls.

Verify actual foreground/background pairs for the app and popup, including opacity compositing, selected rows, alerts, chips, helper text, and enabled control states. Use focused ratio tests for the supported palette and inspect rendered states; testing theme text tokens alone does not establish the stated contrast requirement.

## 12. Button text (item 18)

Buttons use sentence-case source labels and theme `textTransform: 'none'`, preserving acronyms and proper names, for example “Export CSV” and “Open LCSH tool”. Apply this to both app and popup. Update affected accessibility-name assertions and live-harness selectors without weakening them.

## 13. Tests

Add focused acceptance coverage for the changed behavior, rather than requiring one test per section:
- Next: current AI selection, current automatic/user fallback, manual overrides and manual none, partial/failed/no-results lookups, missing results after cancellation, stop errors, no presented candidates, double clicks, and leaving the view during configuration loading or generation.
- Editing: add/edit/remove limits and validation; draft cancellation; same-text no-op; stale lookup, selection, name-key success/failure, and Next completion after edits; ID reassignment; no obsolete build or navigation.
- Provenance: mixed AI/user headings through both history allowlists and read-only panels; old v2 defaults; preserved authority sources and selection methods; aligned CSV authorship; no unmatched suggestion exported as authority data.
- Ordering/formatting: name-key completion changes sort position; stable ties; stored old-entry order; structured delimiters; canonical history; unchanged legacy warnings; finished display and export guards, including formatting-created key matches.
- Presentation: confidence null/boundary cases, saved-versus-draft provider configuration, popup absent/invalid/unreadable database metadata, form disclosure reset, contrast pairs, and sentence-case accessible names.

Verify integration with round 1’s History navigation, Settings sections, match labels, and Matches summary.

## 14. Out of scope

No change to lookup routing, candidate rules, MARC building (no new MARC
mappings), the local database, providers, the fault build, or history
restoration into an editable run.
