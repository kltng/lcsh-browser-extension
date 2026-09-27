# SPEC-P4 — JSON pipeline, lookup interface (LOC API), deterministic MARC

Status: DRAFT v1 (for review round 1), 2026-09-27.

Builds on Phase 3 (committed, accepted). Binding inputs:
- `AGENTS.md`, `docs/multi_agent/HOUSE_RULES.md`, `docs/SPEC-P3.md` (the provider
  contract: `generate()`, the schema subset, ProviderError, settings);
- evidence: `docs/evidence/nano_legacy_output_2026-09-27.md`,
  `docs/evidence/loc_suggest2_marckeys_2026-09-27.md`;
- the round-1 review of the old draft (`.dispatch/spec-review-ext-1/last_message.md`),
  findings #15–#19, #23, #27, #28 and #31, which this spec answers (§12);
- LCSHBench experiments (JOURNAL 2026-09-26/27): prompt wording mattered more
  than a separate picker.

## 0. Goals and non-goals

Goals:
1. Replace the markdown suggestion format with JSON through `generate()`.
2. A lookup interface with ONE backend in P4: the LOC API (`suggest2`). P5 adds
   the local DB behind the same interface.
3. AI selection that can only choose looked-up records.
4. MARC 6XX fields built by code from the chosen record's authority key, never
   by the model.
5. The UI never claims verification that did not happen.

Non-goals: the local DB (P5), Jev, batch input, a stepper redesign.

## 1. Files

```
src/services/pipeline/
  prompts.js       SUGGEST_SYSTEM, SELECT_SYSTEM, builders; exported as plain strings (the lead's eval harness imports them)
  schemas.js       SUGGEST_SCHEMA, SELECT_SCHEMA (canonical subset, SPEC-P3 §4.2)
  suggest.js       step 1
  select.js        step 3 (AI + fallback)
  marc.js          step 4 (deterministic)
  budget.js        input trimming for small context windows
  run.js           orchestration helpers used by the components; the provenance snapshot
  types.js         JSDoc typedefs (§2) + factory/validator functions
src/services/lookup/
  index.js         getLookupBackend(settings) → backend
  locApi.js        suggest2 backend (§4)
  scheduler.js     request-level concurrency + spacing + deadline
  normalize.js     normalizeLabel() (the builder contract, used for matching)
src/services/history.js   history record v2 + legacy adapter (§8)
```
Removed after P4: `legacyBridge.js`, the markdown parts of `geminiService.js`
(`FIXED_OUTPUT_FORMAT`, `parseLcshSuggestions`, `parseMarcRecords`, the MARC
prompt), `utils/similarityUtils.js` `findBestMatch` usage in components
(Levenshtein stays for the fallback, moved to `select.js`). `locService.js` is
replaced by `lookup/locApi.js` (dev's retry and User-Agent logic move there).

## 2. Data model (`types.js`)

```js
/** Suggestion — from the model */
{ id: 's1', heading: string, kind: 'topical'|'geographic'|'name'|'genre'|'unknown', reason: string }

/** Candidate — ONLY from a lookup backend */
{ cid: 'lcsh:sh2008108026',            // `${authority}:${localId}`, stable
  authority: 'lcsh'|'lcnaf'|'lcgft',
  localId: 'sh2008108026',
  uri: 'http://id.loc.gov/authorities/subjects/sh2008108026',
  label: 'Motion pictures--Japan--History',
  marcKey: '150  $aMotion pictures$zJapan$xHistory',   // null if the backend has none
  matchKind: 'exact'|'variant'|'main-heading'|'keyword',
  source: 'loc-api' }                                    // P5 adds 'local-core'|'local-full'

/** LookupResult — per suggestion */
{ suggestionId, status: 'ok'|'no-match'|'failed', candidates: Candidate[], errorKind?: string }

/** Selection — per suggestion */
{ suggestionId, cid: string|null, method: 'ai'|'lexical'|'none',
  confidence: integer 0..100 | null,      // model confidence, only when method 'ai'
  lexicalSimilarity: integer 0..100|null, // normalized Levenshtein label vs heading
  reason: string }

/** Recommendation — what the Final screen, copy, CSV and history use */
{ cid, label, authority, uri, localId, matchKind, method, confidence, lexicalSimilarity,
  fromSuggestionIds: string[], additional: boolean,
  marc: { tag, ind1, ind2, subfields: [[code, value]], text, status: 'from-authority'|'provisional'|'unavailable' } }
```
Every field shown to the user as "LC heading", "LC ID" or "link" comes from a
Candidate. No model output is ever shown as a verified heading.

## 3. Step 1 — suggest (`suggest.js`)

- `SUGGEST_SCHEMA`: `{subjectAnalysis: string (1..1200), suggestions: array (1..8)
  of {heading: string (1..200), kind: enum topical|geographic|name|genre,
  reason: string (1..300)}}`. It follows SPEC-P3 §4.2 (object root, all required,
  `additionalProperties:false`).
- Prompt (`prompts.js`): the user's editable rules + fixed instructions. The fixed
  instructions MUST NOT ask for or mention identifiers, URLs, MARC, or
  verification (evidence file). They ask for LCSH-style headings with
  subdivisions where the cataloger would use them, and for the kind of each.
  Headings for works ABOUT a person or organization are kind `name`. The number
  of headings asked for is set by the prompt-evaluation gate (§10).
- Call: `generate(cfg, {system, userText, images, schema: SUGGEST_SCHEMA,
  temperature: 0.2, maxOutputTokens: 2048})` (P3 raises it for thinking models).
- IDs: `s1..sN` in model order. Duplicate headings (after `normalizeLabel`) are
  merged (the first one kept).
- **Fallback** when `generate` throws `invalid_output`: ONE retry in text mode
  asking for "one heading per line, at most 8" with the same bibliographic text
  and images; lines are trimmed, numbering/bullets removed, deduplicated, and
  get `kind: 'unknown'`, `reason: ''`, `subjectAnalysis: ''`. Any other error
  propagates.
- Budget (`budget.js`, Nano only): before calling, trim per §9.

## 4. Step 2 — lookup (`lookup/`)

Interface:
```js
backend.info()                       // {id:'loc-api', label:'Library of Congress (id.loc.gov)', ready:true}
backend.lookup(suggestion, {limit, signal}) → Promise<LookupResult>
backend.supports(authority) → boolean   // loc-api: all three
```
**Authority routing** by kind: topical → [lcsh]; geographic → [lcsh, lcnaf];
name → [lcnaf, lcsh]; genre → [lcgft, lcsh]; unknown → [lcsh, lcnaf, lcgft].

**LOC API algorithm** for one suggestion (every request through `scheduler.js`):
1. Full heading, `searchtype=leftanchored`, `count=10`, for each routed authority
   (the heading passed exactly as given, `--` kept).
2. If the heading has subdivisions: its main heading (text before the first
   `--`), `searchtype=leftanchored`, `count=10` on the first routed authority.
3. `searchtype=keyword` on the heading with `--` replaced by spaces, `count=10`,
   first routed authority.
- Endpoints: `https://id.loc.gov/authorities/{subjects|names|genreForms}/suggest2`.
- Hit → Candidate: `localId = hit.token`, `uri = hit.uri`, `label = hit.aLabel`,
  `marcKey = hit.more?.marcKeys?.[0] ?? null`.
- **Drop** hits whose `marcKey` tag starts with `18` (subdivision records, e.g.
  `n78089021-781`), and hits without `aLabel`.
- `matchKind`: `normalizeLabel(label) === normalizeLabel(heading)` → `exact`;
  from step 2 and equal to the main heading → `main-heading`; otherwise
  `keyword`. (`variant` is reserved for P5.)
- Merge in step order, dedupe by `cid` (the first occurrence wins), then cut to
  `limit` (cloud 10, Nano 4).
- Status: at least one candidate → `ok`; all requests succeeded with none →
  `no-match`; any request failed and none found → `failed` with the
  ProviderError-style `errorKind` (`network`, `timeout`, `rate_limit`, `server`).
  A partial failure with candidates → `ok` plus `partial: true`.

**Scheduler** (`scheduler.js`): one queue per page; at most 3 requests in
flight in total; at least 300 ms between request starts; each request has a
15 s timeout and dev's retry rule (429/503: 2 retries with 2 s and 4 s backoff,
honoring Retry-After ≤ 10 s); the whole lookup step has a 90 s deadline and the
caller's signal. `User-Agent` stays as dev sets it (browsers may ignore it).

Host permission: `https://id.loc.gov/*` stays required (unchanged).

## 5. Step 3 — select (`select.js`)

Input: suggestions + LookupResults (only `ok`). Suggestions with `no-match` or
`failed` skip selection and get `method:'none'`.
- Candidates are presented to the model with short ids that are unique across
  the request: `s{n}c{m}` (for example `s2c3`). Per candidate the prompt shows:
  id, label, authority, matchKind. (No URIs: the model never needs them.)
- `SELECT_SCHEMA`: `{selections: array of {suggestionId: string, choice: string,
  confidence: integer 0..100, reason: string (0..300)}, additional: array (0..3)
  of {choice: string, reason: string}}`. `choice` is a presented id or `"none"`.
- **Validation (code, not the model):** a selection counts only if
  `suggestionId` is a real one, it appears once (the first occurrence wins), and
  `choice` is `"none"` or one of the ids presented FOR THAT suggestion.
  `additional` choices must be presented ids not already chosen; duplicates are
  dropped; at most 3. Anything else is discarded and logged as
  `{kind:'invalid_selection', count}` (no model text in logs).
- **Fallback per suggestion** (the model failed, returned no valid selection for
  it, or the whole call threw a ProviderError other than `cancelled`):
  lexical choice = the candidate with the highest `lexicalSimilarity`
  (`normalizeLabel`, Levenshtein ratio 0–100); accept it only if
  `matchKind === 'exact'`, or `lexicalSimilarity ≥ 90` → `method:'lexical'`;
  otherwise `method:'none'`.
- `lexicalSimilarity` is computed for every chosen candidate (display only).
  `confidence` is the model's integer, or `null` for lexical/none. There is no
  "exact" label derived from confidence (the PWA did that; dropped).
- Recommendations: one per distinct chosen `cid` (merging `fromSuggestionIds`)
  + `additional` (`additional:true`), in suggestion order then additional order.

## 6. Step 4 — MARC (`marc.js`, deterministic)

`buildMarc(candidate)`:
1. No `marcKey` → `status:'unavailable'`, `text:''` (UI: "MARC not available for
   this record").
2. Parse `marcKey`: `tag = key.slice(0,3)`, `authInd1 = key[3]`, `authInd2 =
   key[4]`, then subfields split on `$` (code = first char, value = the rest,
   trimmed).
3. Map: `100→600`, `110→610`, `111→611`, `130→630`, `150→650`, `151→651`,
   `155→655`. Any other tag → `unavailable`.
4. Indicators: 600/610/611 → `ind1 = authInd1`; 630 → `ind1 = '0'`;
   650/651/655 → `ind1 = ' '`. `ind2 = '0'` for lcsh and lcnaf; `'7'` for lcgft,
   and `['2','lcgft']` is appended to the subfields.
5. `text` = `${tag} ${ind1}${ind2} ` + subfields joined as `$a value $x value`
   (a blank indicator is displayed as `_`, e.g. `650 _0 $a Cats`). The copy/CSV
   text uses the same display form.
6. `status:'from-authority'`.
Unit fixtures: every row of `docs/evidence/loc_suggest2_marckeys_2026-09-27.md`
(the expected bib fields are listed there), plus an unknown tag and a missing key.

## 7. UI changes

- **Step 1 form:** unchanged fields; the button says "Suggest headings".
- **Step 2 "Suggested headings"** (was "Initial Suggestions"): the subject
  analysis, then the suggestions with their kind and reason. A small note: "These
  are the AI's suggestions. They are checked against the Library of Congress in
  the next step." Button "Look up at the Library of Congress".
- **Step 3 "Matches"** (was "Review Scraped Results"): per suggestion, the
  candidates (label, authority badge, link, matchKind), the chosen one
  highlighted with its method ("AI choice (confidence 85)", "Closest label (92%
  similar)", or "No match found"). `failed` shows "Lookup failed (…)" with a Retry
  for that suggestion. Button "Build recommendations".
- **Step 4 "Recommendations"** (was "Final Recommendations"): one card per
  Recommendation: label, "LC ID" (`localId`) + link (from the candidate only), a
  "Found in LCSH/LCNAF/LCGFT" badge, the method line, the MARC text with Copy
  (and "MARC not available" when so). Suggestions without a match are listed
  under "Not found in LC authorities" in plain text, never as recommendations.
  No text anywhere says "verified by API".
- The "Using <provider> · <model>" line shows for steps 1 and 3 (the AI steps).
- Copy all / CSV: only Recommendations; CSV columns `label, lc_id, uri,
  authority, marc, method, confidence, lexical_similarity, source`; RFC 4180
  quoting (`"` doubled; every field quoted); UTF-8 with BOM.
- Queued P3 fixes (in this phase): remove `https://generativelanguage.googleapis.com/*`
  from `optional_host_permissions` (Chrome warning: redundant); update the
  manifest `description` to "Suggests Library of Congress Subject Headings with
  your choice of AI provider"; when a Save is denied, the typed draft
  (key/model/region/URL) stays in the form.

## 8. History (`history.js`)

- New entries: `{v: 2, id, timestamp, bibliographicInfo (images stripped as
  today), suggestions, lookup: {backend:'loc-api'}, selections,
  recommendations, provenance: {suggest: {providerId, model}|null, select:
  {providerId, model}|null}}`, built from an allowlist (no spreading of config
  or provider responses).
- Provenance is snapshotted when each AI step STARTS (not at save time).
- Legacy entries (no `v`) keep rendering through an adapter that maps
  `finalRecommendations`/`marcRecords` to a read-only view marked "Saved by an
  older version"; P3 provenance fields are shown when present.
- `MAX_CONVERSATION_HISTORY` stays 25.

## 9. Small-model budget (`budget.js`)

For Nano only (`cfg.providerId === 'gemini-nano'`), before each AI step:
- Suggest: abstract ≤ 2,000 chars, TOC ≤ 1,500, notes ≤ 800 (cut at a word
  boundary + "…").
- Select: ≤ 4 candidates per suggestion; if the Nano budget check (SPEC-P3 §4.3)
  throws `too_long`, retry ONCE with 2 candidates per suggestion, then fall back
  to lexical selection for all.
Cloud providers: abstract ≤ 8,000, TOC ≤ 4,000, notes ≤ 2,000; no retry.

## 10. Prompt-evaluation gate (lead, before the build is accepted)

The lead's harness imports `prompts.js`/`schemas.js` and runs the pipeline logic
on ≥ 100 LCSHBench dev records (English with abstracts + ≥ 20 non-English),
using the LOC backend, with Gemini 2.5 Flash and Nano-sized fallbacks where
possible. Two suggestion variants are compared: "3–6 headings" and "up to 8
headings". The variant with the higher root-match F1 (official
`lcsh-benchmark-score`) is kept; ties go to fewer headings. The result and the
numbers go into the journal. The coder implements both variants behind one
constant `SUGGESTION_COUNT_HINT` so the gate can switch without code changes.

## 11. Tests (vitest; the P3 fakes are reused)

| # | Behavior | Test |
|---|---|---|
| 1 | suggest | valid JSON → suggestions with ids, dedupe; kind enum; `invalid_output` → text fallback with kind unknown; other errors propagate; no prompt text contains "verified", "API ID", "URL", or "MARC" (static check of `prompts.js`) |
| 2 | routing | each kind → the right authority order |
| 3 | locApi | request order and params for simple/subdivided headings; hit mapping; 18X dropped; matchKind rules; dedupe + limit; status ok/no-match/failed/partial |
| 4 | scheduler | ≤ 3 in flight; ≥ 300 ms spacing; per-request timeout; 429 retry + Retry-After; step deadline; cancel |
| 5 | select | valid choices; cross-suggestion choice rejected; unknown id rejected; duplicate suggestionId (first wins); additional from union only, ≤ 3, dedupe; "none"; whole-call failure → lexical fallback per suggestion; lexical acceptance thresholds |
| 6 | marc | every evidence-table row → exact bib text; unknown tag; missing key; lcgft `$2`; name indicators |
| 7 | budget | Nano trims; select retry with 2 candidates on too_long, then lexical |
| 8 | history | v2 allowlist (no config/key fields); provenance snapshot at step start (settings changed mid-run); legacy adapter renders an old v1.1.0 entry and a P3 entry |
| 9 | CSV | quotes, commas, newlines, non-Latin text, BOM |
| 10 | UI copy | no rendered string contains "Verified by API" (render the four step components with fixture data using React's server renderer `react-dom/server`, already a dependency) |
| 11 | P3 queued fixes | manifest optional list lacks the Gemini origin (and the registry test still passes); a denied Save keeps the draft |

Gates: `npm run build` (only the 3 baseline warnings) and `npm test` all passing.

## 12. Answers to the round-1 findings

- #15 (LOC retrieval): §4 states the full algorithm (left-anchored full heading,
  main heading, keyword), request-level scheduling, deadlines, and distinguishes
  no-match from failure.
- #16 (fallback without kind): §3 — `kind:'unknown'` routes to all authorities.
- #17 (allowlist): §5 — stable ids, per-suggestion validation, labels and URIs
  only from Candidates, per-suggestion fallback, additional terms from the
  presented union only, ≤ 3, deduped.
- #18 (confidence vs similarity): §2/§5 — separate fields; no derived "exact".
- #19 (MARC): §6 — deterministic from the LOC authority key; no model output.
- #23 (candidate mapping): §2/§4 — one mapper; `cid` = authority + local id;
  full URI from the backend.
- #27/#28 (FTS/query plans): not applicable to the LOC backend; deferred to P5.
- #31 (history): §8.

## 13. Live acceptance (lead)

1. Gemini, OpenRouter, DeepSeek, LM Studio: one full run each with the
   evidence record 日本電影人物志 and one English record; every recommendation
   has a real LC ID and link, and MARC `from-authority` (or `unavailable`).
2. A suggestion that is not an LC heading (e.g. "Japanese cinema") appears
   under "Not found" or is mapped to a real candidate — never as verified.
3. Kill the network during lookup → "Lookup failed" + per-suggestion Retry.
4. Owner: one Nano run (deferred gate before release, as in P3).
5. Old history entries (v1.1.0 and P3) still open.
