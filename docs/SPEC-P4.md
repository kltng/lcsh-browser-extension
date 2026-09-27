# SPEC-P4 — JSON pipeline, lookup interface (LOC API), deterministic MARC

Status: v3 = v2 + the 14 edits of review round 2 (APPROVE-WITH-CHANGES), 2026-09-27. v1 was REJECTED with 24
findings (`.dispatch/spec-review-p4-1/last_message.md`; v1 archived at
`.dispatch/SPEC-P4.v1.md`). §14 maps each finding to its fix.

Binding inputs: `AGENTS.md`, `docs/multi_agent/HOUSE_RULES.md`,
`docs/SPEC-P3.md` (the provider contract), and the evidence files
`docs/evidence/nano_legacy_output_2026-09-27.md` and
`docs/evidence/loc_suggest2_marckeys_2026-09-27.md` (including its addendum;
all its tables are LIVE observations by the lead).

## 0. Goals, non-goals, honesty rule

Goals:
1. JSON suggestions through `generate()`.
2. A lookup interface with one backend in P4, the LOC API (`suggest2`). P5 adds
   the local DB behind the same interface.
3. AI selection limited to looked-up records, plus a manual choice by the
   cataloger.
4. MARC 6XX fields built by code from LOC authority keys.

**Honesty rule (binding everywhere, including copy, CSV and history):**
- Only data that came from a lookup backend may be shown as an LC heading, an
  LC ID or an LC link.
- Model text is always labeled as a suggestion.
- No wording claims more than what happened. "No match returned by this
  search" is allowed; "not in LC" is not.

Non-goals: the local DB (P5), Jev, batch input.

## 1. Files and ownership

```
src/services/pipeline/
  prompts.js     SUGGEST_FIXED, SELECT_FIXED, DEFAULT_RULES, buildSuggestPrompt(), buildSelectPrompt(); SUGGESTION_COUNT_HINT
  schemas.js     SUGGEST_SCHEMA, SELECT_SCHEMA (SPEC-P3 §4.2 subset)
  suggest.js     step 1 (+ disclosed text fallback)
  lookupStep.js  step 2 orchestration over a backend
  select.js      step 3 (AI selection, manual choice, exact-only automatic fallback)
  marc.js        step 4 (deterministic)
  budget.js      input trimming
  run.js         run state machine, snapshots, stale-result rejection (§9)
  types.js       JSDoc typedefs + validators/factories (§2)
  images.js      bibliographic images → generate() images (moved from legacyBridge)
  label.js       "Using <provider> · <model>" helper (moved from legacyBridge)
  logging.js     logWorkflowError (moved from legacyBridge, unchanged behavior)
src/services/lookup/
  index.js       getLookupBackend(settings)
  locApi.js      suggest2 backend (§4)
  hit.js         suggest2 hit → Candidate validation (§4.3)
  scheduler.js   request scheduling (§4.5)
  searchText.js  search-input normalization (§4.1)
  normalize.js   normalizeLabel() (identity normalization, §2.1)
src/services/history.js   history v2, legacy adapter, locked storage (§8)
src/utils/csv.js          CSV building (keeps the existing formula guard)
```
Deleted after P4: `legacyBridge.js`; the markdown parts of `geminiService.js`
(`FIXED_OUTPUT_FORMAT`, the MARC prompt, `parseLcshSuggestions`,
`parseMarcRecords`; the file is removed if nothing else remains);
`locService.js` (its retry and User-Agent logic move into `locApi.js` and
`scheduler.js`). The P3 regression tests that cover moved helpers
(`images`, `label`, `logging`) move with them and must keep passing.

## 2. Data model (`types.js`)

```js
/** Suggestion (model output, never shown as verified) */
{ id: 's1', heading: string, kind: 'topical'|'geographic'|'name'|'genre'|'unknown', reason: string }

/** Candidate (ONLY from a backend; built by hit.js) */
{ cid: 'lcsh:sh2008108026',               // `${authority}:${localId}`
  authority: 'lcsh'|'lcnaf'|'lcgft', localId, uri, label,
  marcKey: string|null,
  rdfTypes: string[],                       // from the backend, may be []
  matchClass: 'exact-full'|'exact-main'|'prefix-full'|'prefix-main'|'keyword',
  source: 'loc-api' }

/** LookupResult (per suggestion) */
{ suggestionId, outcome: 'found'|'no-results'|'failed'|'partial',
  candidates: Candidate[], errorKind: string|null, searchedAt: ISO string }

/** Selection (per suggestion) */
{ suggestionId, cid: string|null,
  method: 'ai'|'exact'|'manual'|'none',
  noneReason: null|'lookup-failed'|'no-results'|'ai-chose-none'|'ai-unavailable'|'not-chosen',
  confidence: integer 0..100|null,          // only for method 'ai'
  lexicalSimilarity: integer 0..100|null,   // display only (§5.4)
  mainHeadingOnly: boolean,                 // chosen record is the main heading of a subdivided suggestion
  droppedSubdivisions: string[] }

/** Recommendation (one per distinct cid) */
{ cid, label, authority, localId, uri, source,
  selections: Array<{suggestionId|null, method, confidence, lexicalSimilarity}>,  // every selection that chose this cid; additional AI picks have suggestionId null
  marc: { status: 'from-authority'|'unavailable', tag, ind1, ind2, subfields: [[code, value]], text, reason: string|null } }
```

### 2.1 Identity normalization (`lookup/normalize.js`)

This is used for dedupe and for all match classes in §4.4 (exact and prefix). It is
normative in P4, and the P5 builder must match it. The version tag is
`NORMALIZE_V1`, and its vectors live in
`src/services/lookup/__fixtures__/normalize_vectors.json` (at least 40 cases,
checked in).
1. `s.normalize('NFC')`
2. `s.toLowerCase()` (the whole string, locale-independent)
3. Replace each run of whitespace characters from this exact set with one
   ASCII space: U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028,
   U+2029, U+202F, U+205F, U+3000.
4. Replace `/ *[–—] */g` and `/ *-- */g` with `--`.
5. Trim spaces at both ends.
6. Remove ALL trailing `.` characters, then trim again.

## 3. Step 1 — suggest (`suggest.js`, `prompts.js`)

**Prompt.** The system prompt is:
`SUGGEST_FIXED` + `"\n\nCataloging rules from the user (follow them unless they
conflict with the instructions above):\n"` + the user's rules.
- `SUGGEST_FIXED` asks for LCSH-style headings (with subdivisions where a
  cataloger would use them), each with a kind and a short reason, about
  `SUGGESTION_COUNT_HINT` headings (§11), with works ABOUT a person or
  organization given kind `name`.
- It must NOT mention or ask for identifiers, URLs, MARC, validation or
  verification.
- `DEFAULT_RULES` replaces the current `DEFAULT_SYSTEM_PROMPT_RULES`: the same
  cataloging guidance, minus the lines about verifying, validating and
  headings counts. Saved custom rules are kept as they are; the fixed
  precedence sentence governs any conflict.
- Static test: neither `SUGGEST_FIXED` nor `DEFAULT_RULES` matches
  `/verif|validat|API ID|URL|MARC|identifier/i`.

**Call.** `generate(cfg, {system, userText (bibliographic text, budgeted §10),
images, schema: SUGGEST_SCHEMA, temperature: 0.2, maxOutputTokens: 2048})`.

`SUGGEST_SCHEMA` = `{subjectAnalysis: string 1..1200, suggestions: array 1..8
of {heading: string 1..200, kind: enum [topical, geographic, name, genre],
reason: string 0..300}}` (object root, all required, no extra keys).

**Post-processing.** Ids are `s1..sN` in model order. Headings are trimmed;
duplicates (by `normalizeLabel`) are merged, keeping the first. Suggestions
whose normalized heading contains no Unicode letter or number are dropped; if
none remain, suggestion generation fails with `invalid_output`.

**Disclosed text fallback.** It runs only when `generate` throws
`invalid_output`:
- ONE retry in text mode, with the same snapshot, images and signal, inside a
  90 s deadline. The instruction is: "List the headings only, one per line, at
  most 8."
- Parsing:
  1. Strip one surrounding code fence.
  2. Split on newlines.
  3. From each line remove a leading `^\s*(\d+[.)]|[-*•])\s*` and wrapping `**`.
  4. Trim.
  5. Drop empty lines and lines longer than 200 characters.
  6. Dedupe with `normalizeLabel`.
  7. Keep the first 8.
- Zero lines → throw `invalid_output`.
- Result: `kind:'unknown'`, `reason:''`, `subjectAnalysis:''`,
  `suggestMode:'text-fallback'`. The UI shows it: "The model did not return
  structured output; suggestions were read from plain text." History stores
  it.

Every other ProviderError propagates (shown with Retry and Settings buttons).
**Exception to SPEC-P3 §4.1:** P4 authorizes ONE disclosed pipeline-level
text retry after `invalid_output`; P3's prohibition on adapter-level mode
changes stays binding, and this sentence supersedes P3's "there is no
downgrade anywhere" for this one case only. The 90 s budget covers the
initial attempt and the fallback together.

## 4. Step 2 — lookup (`lookup/*`, `pipeline/lookupStep.js`)

### 4.1 Search input (`searchText.js`)

`toSearch(heading)`:
- NFC; collapse whitespace (the §2.1 set) to one space; replace (GLOBAL flag)
  `/\s*[\u2013\u2014]\s*/g` and `/\s*--\s*/g` with `--`; trim; remove ALL
  trailing `.`; trim.
- Empty or punctuation-only, OR splitting on `--` gives any empty (trimmed)
  component (e.g. `--History`, `Cats--`) → the suggestion is `no-results`
  with no requests.
- `full` = that string. `main` = the text before the first `--` (the same
  string if there are no subdivisions). `keywordText(x)` = `x` with `--`
  replaced by a space.
- `URLSearchParams` does the encoding.

### 4.2 Routing and staged search (`locApi.js`)

Routing by kind:

| kind | authorities, in order |
|---|---|
| topical | lcsh |
| geographic | lcsh, lcnaf |
| name | lcnaf, lcsh |
| genre | lcgft, lcsh |
| unknown | lcsh, lcnaf, lcgft |

Stage rules:
- ALL routed requests of a stage complete before its stop condition is
  checked.
- If any accepted `exact-full` candidate exists after a stage, the later
  stages do not run.
- S3 runs only when S1 and S2 produced no `exact-*` candidate.
- S4 runs only when S3 RAN successfully and returned zero accepted candidates,
  and the kind is `name` or `unknown`. S4 never follows a skipped S3.
- Not keyword-searching after an `exact-main` is a bounded-recall policy:
  ranking (§4.4) orders only what was actually searched.

The stages:

| Stage | Search | On |
|---|---|---|
| S1 | `leftanchored`, `q = full`, `count = 10` | each routed authority |
| S2 | only if `main ≠ full`: `leftanchored`, `q = main`, `count = 10` | each routed authority |
| S3 | only if S1+S2 found no `exact-*` candidate: `keyword`, `q = keywordText(full)`, `count = 10` | the first routed authority |
| S4 | only for kind `name`/`unknown` and if S3 found nothing: `keyword`, `q = keywordText(main)`, `count = 10` | lcnaf |

Endpoints: `https://id.loc.gov/authorities/{subjects|names|genreForms}/suggest2`
(lcsh | lcnaf | lcgft).

**Per-run cache** (keyed by URL):
- It stores SUCCESSFUL validated responses (the raw accepted hits, before
  suggestion-specific match classes or truncation).
- Identical in-flight requests are coalesced. Cancelling one consumer does
  not cancel the shared request while another consumer is waiting.
- Failed and cancelled entries are evicted.
- An explicit user **Retry lookup** starts a fresh attempt that bypasses
  completed cache entries for that suggestion's URLs.

### 4.3 Hit → Candidate (`hit.js`)

A hit is **accepted** only if all of these hold:
- `aLabel` is a non-empty string of at most 500 characters;
- `token` is a non-empty string matching `^[a-z]{1,3}[0-9]+(-[0-9]+)?$`;
- `uri` equals `http://id.loc.gov/authorities/<subjects|names|genreForms>/<token>`,
  with the path segment matching the authority that was searched;
- the hit is an object, and `aLabel` is not whitespace-only;
- `more` is absent (treated as empty metadata) or an object; a present but
  malformed `more` rejects the hit;
- `more.marcKeys`, if present, is an array of strings; missing or empty →
  `marcKey: null`; otherwise `marcKey = marcKeys[0]` (no rescue from later
  keys);
- when `marcKey` is not null, its tag (the first 3 characters) does NOT
  start with `18`;
- `more.collections`, if present, is an array of strings with no entry
  ending in `collection_Subdivisions`;
- `more.rdftypes`, if present, is an array of strings.

Anything else is **rejected** and counted in `rejectedHits`, which is shown
only in the debug counts, never with text. A response that is not JSON, or
whose `hits` is not an array, marks that request failed (`invalid_output`).
`rdfTypes` = `more.rdftypes` if it is an array of strings, else `[]`.
Deprecated records: suggest2 was observed to return current headings only
(evidence addendum); P4 does not claim to exclude deprecated records beyond
that observation.

### 4.4 Match classes, ranking, limit

`n = normalizeLabel`. The first matching rule gives the class:

| Condition | matchClass |
|---|---|
| `n(label) === n(full)` | `exact-full` |
| `main ≠ full` and `n(label) === n(main)` | `exact-main` |
| `n(label).startsWith(n(full))` | `prefix-full` |
| `n(label).startsWith(n(main))` | `prefix-main` |
| anything else | `keyword` |

- Pool all accepted candidates from all stages. Dedupe by `cid`, keeping the
  best class seen for that cid.
- Sort by: class order (as in the table), then the authority's position in
  the routing, then the stage, then the backend's hit order.
- Cut to `limit` (cloud 10, Nano 4; §10).

Outcome:
- `found`: at least one candidate and no failed request;
- `partial`: at least one candidate and at least one failed request;
- `no-results`: no candidates and every request succeeded;
- `failed`: no candidates and at least one request failed. `errorKind` is that
  failure's kind (`network`, `timeout`, `rate_limit`, `server`,
  `invalid_output`, `cancelled`).

### 4.5 Scheduler (`scheduler.js`)

- One queue per page, used by all lookups of the page.
- At most **2** requests in flight, and at least **500 ms** between request
  starts.
- Each request: a 15 s timeout covering headers and body; `credentials:'omit'`.
- 429 or 503:
  - read `Retry-After` (seconds or an HTTP date); if it is missing, use 4 s;
  - if the wait is ≤ 20 s, pause the WHOLE queue (a shared cooldown) for that
    long, then retry the request, at most 2 times per request;
  - if the wait is > 20 s, fail the request with `rate_limit`.
- The lookup step has a 120 s WORK BUDGET that covers queue waits,
  cooldowns, bodies and retries. Some stages may therefore not run. On
  expiry: abort active work, drop queued work, and finalize every suggestion.
  A suggestion that did not complete becomes `partial` (if it has
  candidates) or `failed` (if not), with `errorKind: 'timeout'`. Completed
  suggestions keep their outcome. Expiry is never reported as `cancelled`.
- Overlapping cooldowns: `cooldownUntil = max(current, new)`. A past HTTP
  date gives 0; an invalid `Retry-After` value gives the 4 s default.
- The caller's signal cancels active AND queued work.
- Tabs do not share the budget. This limitation is documented; P4 accepts it.

## 5. Step 3 — select (`select.js`)

### 5.1 AI selection

- Input: the same bibliographic text as step 1 (budgeted; images NOT sent),
  plus the suggestions whose outcome is `found` or `partial`, each with its
  ranked candidates.
- Presentation: `s{n}c{m}` ids, unique within the call. The presentation
  snapshot (id → cid) is kept for validation. Each candidate line gives the id,
  label, authority and match class. URIs and IDs are not sent.
- `SELECT_SCHEMA` = `{selections: array 0..8 of {suggestionId: string 1..8,
  choice: string 1..12, confidence: integer 0..100}, additional: array 0..3 of
  {choice: string 1..12, confidence: integer 0..100}}`.
- Validation (by code):
  - A selection counts only if `suggestionId` was presented and is its FIRST
    occurrence, and `choice` is `"none"` or an id presented FOR THAT
    suggestion.
  - `additional[].choice` must be a presented id whose cid was not chosen by
    any valid selection. Duplicates are removed by cid; at most 3 are kept.
  - Everything else is discarded; its count is logged as `invalid_selection`.
- When no suggestion has any presented candidate, selection makes NO provider
  call and moves straight to `selected`.

### 5.2 When the AI step fails

| ProviderError kind | Behavior |
|---|---|
| `invalid_output`, `truncated`, `too_long` (Nano: after §10's retry; cloud `too_long` goes straight here) | AUTOMATIC exact-only fallback (§5.3) for every presented suggestion. Banner: "The AI could not choose; only exact matches were kept." |
| any other kind (illustrative: `auth`, `permission`, `billing`, `not_configured`, `forbidden`, `bad_request`, `images_unsupported`, `network`, `timeout`, `rate_limit`, `server`, `overloaded`, `refused`, `unavailable`; implemented as the fallback branch after `cancelled` and the three automatic kinds) | The step STOPS with the error message and three buttons: Retry, Settings, and "Continue without AI (exact matches only)". The last one applies §5.3, with the banner. |
| `cancelled` | Nothing changes. |

### 5.3 Exact-only fallback

- A suggestion gets its `exact-full` candidate (`method:'exact'`) when that
  candidate is unique. If two or more `exact-full` candidates exist (for
  example LCSH and LCNAF), it gets none.
- Otherwise `method:'none'` with `noneReason:'ai-unavailable'`.
- There is no fuzzy automatic acceptance.

### 5.4 Manual choice

- In the Matches screen, every suggestion with candidates offers "Use this
  heading" on each candidate, and "Use none". That gives `method:'manual'`,
  `confidence:null`; "Use none" gives `cid:null`, `noneReason:'manual-none'`
  (shown as "You chose none").
- Manual choices override the AI or exact choice for that suggestion, and are
  kept until the run is invalidated (§9).
- `lexicalSimilarity` = `round(100 * (1 - lev(n(label), n(heading)) /
  max(len)))`, computed on the normalized strings, for display only ("92%
  similar spelling").

### 5.5 Outcome bookkeeping

- Subdivisions are compared as ORDERED normalized components (split on `--`,
  `normalizeLabel` per component), independent of the match class.
  `droppedSubdivisions` = the suggestion's subdivision components (after the
  main heading) that do not appear, in order, in the chosen label's
  components. `mainHeadingOnly` = the chosen label has NO subdivisions and its
  normalized label equals the suggestion's normalized main heading.
- `noneReason`:

  | Situation | noneReason |
  |---|---|
  | lookup outcome was `failed` | `lookup-failed` |
  | lookup outcome was `no-results` | `no-results` |
  | the AI chose `"none"` | `ai-chose-none` |
  | the fallback found no unique exact candidate | `ai-unavailable` |
  | no valid selection for a presented suggestion | `not-chosen` |
  | the cataloger chose "Use none" | `manual-none` |

### 5.6 Recommendations

- One Recommendation per distinct cid, in suggestion order, then additional
  order. `selections` lists every selection that chose that cid.
- Additional AI picks appear with `suggestionId: null`, `method:'ai'`, their
  confidence and `lexicalSimilarity: null` (no source suggestion is
  invented). Additional picks are deduplicated by cid against the FINAL
  merged regular and manual choices; a duplicate is dropped.

## 6. Step 4 — MARC (`marc.js`)

`buildMarc(candidate)` returns `unavailable` (with a `reason`) at the first
failed step:
1. `marcKey` is missing → `'no key'`.
2. Parse. The key must match `^(\d{3})(.)(.)\$` → tag, `a1`, `a2`, and the
   remainder starts at the first `$`. Split the remainder with
   `/\$([a-z0-9])/`. Each subfield value must be non-empty and must NOT contain
   a `$` (a residual `$` → `'unparseable key'`). The first subfield must be
   `a` (for tags 100/110/111/130/150/151/155). Any failure →
   `'unparseable key'`.
3. **Consistency check.** An ordered fold over the subfields as parsed (never
   reordered): start with the first subfield's value; append each next value
   with `--` if its code is `x`, `y`, `z` or `v`, else with a single space. The result must
   equal the candidate `label` exactly. Otherwise → `'key does not match
   label'`. This check also catches a literal `$` inside a value. Verified
   15/15 on live samples (evidence addendum).
4. Tag map: `100→600`, `110→610`, `111→611`, `130→630`, `150→650`, `151→651`,
   `155→655`. Anything else → `'unsupported tag'`.
5. Indicators (a blank indicator is shown as `_`):

   | Bib tag | ind1 | ind2 | Also |
   |---|---|---|---|
   | 600 | `a1`, must be `0`, `1` or `3` (else `'bad indicator'`) | `0` | |
   | 610, 611 | `a1`, must be `0`, `1` or `2` (else `'bad indicator'`) | `0` | |
   | 630 | `a2`, must be a digit `0`–`9` (else `'bad indicator'`) | `0` | |
   | 650, 651 | blank | `0` | |
   | 655 | blank | `7` | append `['2','lcgft']` |

6. Keep the subfields in order, with their punctuation unchanged.
   `text` = `${tag} ${ind1}${ind2} ` + the subfields as `$c value` joined by
   spaces. Example: `600 10 $a Kurosawa, Akira, $d 1910-1998`.
7. `status:'from-authority'`.

The UI and exports call this a "MARC field (text form)", not a MARC record.

Golden fixtures: `src/services/pipeline/__fixtures__/marc_golden.json`,
written by the LEAD from the evidence tables (every row, including 111, 130
and NameTitle), plus adversarial keys (literal `$` in a value — both the
`$100` and the residual `Total $ value` forms, empty `$a`, missing `$`, 18X,
unknown tag, a non-digit indicator, an out-of-set 600 indicator `1009`, a
label mismatch) and a synthetic `130 4$aThe example` → `630 40 $a The example`. The
coder must not edit this file.

## 7. UI

**Step 1** "Describe the work": the fields are unchanged; the button says
"Suggest headings".

**Step 2** "AI suggestions":
- the subject analysis, then each suggestion with its kind and reason;
- the note: "These are AI suggestions. The next step looks them up at the
  Library of Congress.";
- the text-fallback banner when it applies;
- the button: "Look up at the Library of Congress".

**Step 3** "Matches", per suggestion:
- the outcome line:

  | Outcome | Line |
  |---|---|
  | found | "N candidates" |
  | partial | "N candidates (some searches failed)" |
  | no-results | "No match returned by this search" |
  | failed | "Lookup failed: <message>" + **Retry lookup** for that suggestion |

- the candidates (label, authority badge, LC link, match class);
- the current choice with its method: "AI choice (confidence 85)", "Exact
  match", "Your choice", or "None — <reason in words>";
- the "Use this heading" / "Use none" controls;
- when `droppedSubdivisions` is not empty: "The selected heading does not
  include these suggested subdivisions: …". The same note is carried to the
  recommendation card, Copy all (as a comment line) and the CSV
  `subdivision_note` column.

The AI step runs on "Choose headings". Its failure UI follows §5.2. Then
"Build recommendations".

**Step 4** "Recommendations", one card per Recommendation:
- the label, the "LC ID" and LC link (from the candidate), and an authority
  badge;
- the method(s);
- the MARC field text with Copy, or "MARC not available (<reason>)".

Suggestions without a choice are listed under "Suggestions without an LC
heading", with their noneReason in words. They are never shown as
recommendations.

**Exports.**
- Copy all: recommendations only. Each line is `label | LC ID | MARC text`,
  and a header line says "Headings from id.loc.gov; MARC fields generated
  from LC authority keys".
- CSV: the columns `label, lc_id, uri, authority, marc_field, marc_status,
  methods, confidence, subdivision_note, source` (`methods` and `confidence`
  are JSON arrays aligned with the recommendation's `selections` order,
  nulls kept, e.g. `["ai","manual"]` and `[85,null]`), built with `utils/csv.js`. That module KEEPS
  the existing formula guard (a leading `= + - @`, tab or CR is prefixed with
  `'`), applies RFC 4180 quoting, adds a UTF-8 BOM, and uses CRLF.

**Queued P3 fixes (this phase):**
- remove `https://generativelanguage.googleapis.com/*` from
  `optional_host_permissions`;
- the manifest `description` becomes "Suggests Library of Congress Subject
  Headings with your choice of AI provider";
- a denied Save keeps the typed draft in the form.

## 8. History (`history.js`)

**Storage.** Every history operation is a locked read-modify-write in
`chrome.storage.local`, under `navigator.locks.request('lcsh-history', …)`,
reading the current array inside the lock. The operations are save, delete
and clear.
- Ids come from `crypto.randomUUID()`.
- Operations resolve only after the storage write is confirmed. The UI shows
  "Saved" only then, and an error otherwise.
- `onChanged` refreshes the list in other tabs.
- Images are stripped from a COPY; the live form data is not mutated.
- Size policy (product policy, not a browser quota claim): one serialized v2
  entry (UTF-8) may be at most 256 KiB, otherwise the save is refused with a
  local message; the history keeps at most 25 entries AND 6 MiB serialized,
  evicting the oldest inside the lock. Eviction and insertion are ONE write;
  on failure the previous stored history stays as it was and the UI reports
  the failure. Saved evidence is never silently truncated.
- On load, nested objects are rebuilt field by field (allowlist); a
  candidate's omitted `source` is taken from `lookup.backend`.

**v2 entry** (built by an allowlisting builder; nothing is spread from config
or responses):
```js
{ v: 2, id, timestamp,
  bibliographicInfo: {title, author, abstract, tableOfContents, notes, images: [{name, type, size}]},
  subjectAnalysis, suggestMode: 'json'|'text-fallback',
  suggestions: Suggestion[],
  lookup: { backend: 'loc-api', results: Array<{suggestionId, outcome, errorKind, searchedAt,
            candidates: Array<{cid, authority, localId, uri, label, marcKey, matchClass}>}> },
  selectMode: 'ai'|'exact-fallback',
  selections: Selection[],
  recommendations: Recommendation[],
  provenance: { suggest: {providerId, model}|null, select: {providerId, model}|null } }
```
This is enough to re-render steps 2–4 read-only. Provenance is captured when
each AI step STARTS.

**Legacy entries** (no `v`) render read-only through an adapter.
- The header says "Saved by an older version. Its MARC was written by an AI
  model and was not checked."
- Legacy MARC is shown under the label "Unverified AI-written MARC (older
  version)". Copying it prefixes each line with `UNVERIFIED (older version): `.
- Legacy "verified" wording, justifications and links are shown as text from
  that version, labeled the same way. The stored originals are not rewritten.
- P3 provenance fields are shown when present.

## 9. Run state and stale results (`run.js`)

- `run = {runId: crypto.randomUUID(), stage, snapshots: {suggest, select}}`.
- The stages are: `idle → suggesting → suggested → looking-up → looked-up →
  selecting → selected → built`.
- Each async step records its `runId` and ONE config snapshot, taken when it
  starts. A result whose `runId` is not the current run is dropped.
- Going back to step 1 and running Suggest again starts a NEW run, which
  clears lookup, selection and recommendations.
- Retrying the lookup for one suggestion re-runs only that suggestion's lookup
  and clears ONLY that suggestion's selection.
- Retrying the AI step clears the AI selections but keeps manual choices.
- Each step owns an AbortController, aborted on a new run, on
  unmount, and on leaving the step. Its cleanup is in `finally`.
- **Operation revisions.** Each lookup (per suggestion) and the selection
  step have a monotonically increasing revision. A result is committed ONLY if
  its `runId` AND its revision are still current. Leaving a step invalidates
  its pending operation even when the run stays current.
- A per-suggestion lookup retry invalidates that suggestion's choice,
  INCLUDING a manual choice.
- When AI results are merged, existing manual choices (including a manual
  "none") win and are kept.
- Any change of an effective choice or of a candidate list invalidates the
  built recommendations; they are regenerated from the current selections.

## 10. Budgets (`budget.js`)

| | Nano (`gemini-nano`) | Cloud |
|---|---|---|
| Suggest: abstract / TOC / notes | ≤ 2,000 / 1,500 / 800 characters (cut at a word boundary, then `…`) | ≤ 8,000 / 4,000 / 2,000 |
| Select: candidates per suggestion | 4 | 10 |
| Select on `too_long` | ONE retry with 2 per suggestion and NEW presentation ids, validated against the NEW snapshot; if it fails again, §5.2 applies | — |

## 11. Prompt-evaluation gate (lead, before P4 is accepted)

- **Frozen sample.** 120 LCSHBench dev records: 90 English with abstracts and
  30 non-English, drawn with seed 20260927 from `data/dev/dataset_dev.json` at
  lcsh-benchmark commit `ce81a9c`. The record ids are checked in at
  `docs/evidence/p4_eval_manifest.json`.
- **Frozen artifacts.** The prompts come from `prompts.js` at the evaluated
  commit, with `DEFAULT_RULES`. Model `google/gemini-2.5-flash` through
  OpenRouter, temperature 0.2, one run.
- **Frozen LOC answers.** The first pass records every suggest2 request and
  response into a cache file. Both variants replay from that cache; requests
  missing from the cache are fetched once (globally throttled, ≥ 1 s apart)
  and added.
- **What is scored.** The FINAL recommendations (labels), with
  `lcsh-benchmark-score`, in exact and root mode (P, R, F1). Also reported:
  coverage (records with at least one recommendation), the subdivision-loss
  rate (gold subdivided headings where only their main heading was
  recommended), and per-language results.
- **Variants.** `SUGGESTION_COUNT_HINT` = "3 to 6" vs "up to 8".
- **Decision rule, fixed before running.** Let `Δ = exact micro-F1("up to
  8") − exact micro-F1("3 to 6")`. Choose "up to 8" only if the lower bound
  of the paired 95% interval of Δ is above 0; otherwise choose "3 to 6".
- **Acceptance:** the kept variant's exact micro-F1 must be ≥ 0.152. This is
  an absolute quality floor, not a same-sample nonregression claim (the 0.182
  of experiment 1 came from a different 40-record sample).
- **Statistics:** 10,000 paired record-level bootstrap resamples, seed
  20260927, percentile intervals, with the aggregate micro-F1 recomputed in
  each resample.
- **Pins:** the scorer is `lcsh-benchmark-score` at lcsh-benchmark commit
  `ce81a9c` (`uv run lcsh-benchmark-score --dataset <subset> --submission
  <file>`); gold = `ground_truth_lcsh_merged`; a record with no
  recommendation counts as an empty prediction. The LOC cache is FROZEN
  before the scored replay; if any request is still unresolved, the gate is
  INCOMPLETE (not a quality result). The suggestion AND selection model
  settings are recorded.
- **Subdivision loss:** numerator = gold subdivided headings whose exact
  heading was not recommended but whose main heading was; denominator = gold
  subdivided headings. When both the full and the root heading are
  recommended, it is not a loss.
- **Small model.** One run of the kept variant with `qwen/qwen3.8-flash`
  (small, cheap) on the same sample, reported only. The Nano check stays the
  owner's deferred release gate.
- The lead records all numbers in the journal. The coder only provides the
  constant and the importable modules.

## 12. Tests (vitest)

| # | Behavior | Test |
|---|---|---|
| 1 | normalize | all vectors in `normalize_vectors.json` |
| 2 | searchText | dash and space forms of the same heading give the same `full`/`main`; empty/punctuation-only → no requests |
| 3 | suggest | JSON path; ids/dedupe; prompt static check (§3); text fallback: parser bounds (fence, numbering, bold, > 200 chars, > 8 lines, zero lines → error), `suggestMode` recorded; non-invalid_output errors propagate |
| 4 | hit.js | every accept/reject rule, incl. 180/181, the Subdivisions collection, a bad token, a URI mismatch, non-array marcKeys, a non-JSON body |
| 5 | locApi stages (incl. §4.2 stage rules: S4 never after a skipped S3) | the exact request list for: a simple topical; a subdivided geographic with no record whose main heading exists only in LCNAF (`Kyoto (Japan)--Intellectual life--21st century` → S1 nothing, S2 finds `n80024170` `Kyoto (Japan)` as `exact-main`; LCSH `181` hits for `Kyoto (Japan)` are rejected); a subdivided heading that exists in LCSH (`Japan--History` → S1 `exact-full` `sh85069426`, early stop); a name (S4); unknown; early stop on `exact-full`; the per-run cache |
| 6 | ranking | rank-before-limit (an exact hit from the 2nd authority survives 10 weak hits from the 1st); the best class kept on dedupe |
| 7 | outcomes | found / partial / no-results / failed with errorKind |
| 8 | scheduler | ≤ 2 in flight; ≥ 500 ms spacing; shared cooldown on 429 with `max()` overlap; Retry-After seconds, past date, invalid, > 20 s; timeout; budget expiry finalizes partial/failed with `timeout` (not cancelled); cancel active + queued; cache: success stored, failures evicted, coalescing, Retry bypasses |
| 9 | select | validation rules (cross-suggestion id, unknown id, duplicate suggestionId, additional dedupe by cid and cap); the §5.2 table per error kind; exact-only fallback with a unique vs an ambiguous exact; manual override; `noneReason` per case; mainHeadingOnly + droppedSubdivisions; aggregation by cid |
| 10 | budget | Nano trims; the `too_long` retry with new ids validated against the new snapshot |
| 11 | marc | every golden row → exact output (incl. the synthetic `130 4`); every adversarial key → `unavailable` with the right reason (incl. `Total $ value` and `1009`) |
| 12 | run.js | a stale runId is dropped; same-run late lookup and late AI results (older revision) are dropped; a manual choice made during AI selection survives the AI result; per-suggestion retry clears that suggestion's manual choice; a choice change regenerates recommendations; a new suggest clears downstream; abort on unmount |
| 13 | history | locked RMW across two fake pages (no lost update, delete not resurrected); awaited save failure; allowlist (no key/config fields, recursive); re-render steps 2–4 from a v2 entry; legacy adapter labels + the UNVERIFIED copy prefix; the P3 entry shape |
| 14 | csv | formula guard kept (`=`, `+`, `-`, `@`, tab, CR), quotes, commas, newlines, CJK, BOM, CRLF |
| 15 | honesty | render the step components and the history view with `react-dom/server` using fixture states for every outcome/noneReason; assert: no "verified" wording; LC ID/link only appear for Candidate-sourced data; the "No match returned by this search" wording; the legacy UNVERIFIED label |
| 16 | P3 queued fixes | the manifest optional list lacks the Gemini origin (the registry/manifest test updated); a denied Save keeps the draft |
| 17 | moved helpers | the P3 image/label/logging tests pass from their new modules |

Gates: `npm run build` shows only the 3 baseline warnings; `npm test` passes
completely.

## 13. Live acceptance (lead)

1. With Gemini, OpenRouter, DeepSeek and LM Studio: full runs on the record
   日本電影人物志 and on one English record.
   - Every recommendation has a real LC ID and link.
   - MARC is `from-authority` or `unavailable` with a reason.
   - No "verified" wording appears.
2. The Nano evidence case: "Japanese cinema" is shown as a suggestion with an
   outcome, and never as a recommendation unless a real candidate was chosen.
3. Block id.loc.gov during lookup → "Lookup failed" + a working per-suggestion
   Retry.
4. A provider failure during selection (a revoked permission) → the §5.2 stop
   UI; "Continue without AI" works.
5. The v1.1.0 and P3 history entries open read-only with the correct labels.
6. The prompt-evaluation gate (§11) numbers are recorded.
7. The owner's Nano run stays the deferred release gate.

## 14. Round-1 findings → v2

| # | Fix |
|---|---|
| 1 | §6.5 (630 ind1 = auth ind2; evidence corrected) |
| 2 | §6.2–6.3 (anchored parse + consistency check) |
| 3 | §4.3 (hit validation; 18X + Subdivisions collection; deprecated stated as an observation) |
| 4 | §4.2 (staged search across routed authorities; S4 name keyword) |
| 5 | §4.4 (rank before limit; best class kept) |
| 6 | §4.1 (search normalizer) and §2.1 (identity normalizer) |
| 7 | §2, §5.5, §7 (outcome + noneReason; honest wording) |
| 8 | §4.5 (2 in flight, 500 ms, shared cooldown, Retry-After rules, per-run cache, early stop; tabs not shared, documented) |
| 9 | §4.3 (validated hit DTO; malformed body → failed) |
| 10 | §5.3 (no fuzzy automatic acceptance; manual choice) |
| 11 | §2, §5.1, §5.6 (dedupe by cid; `selections` list; additional confidence; retry ids) |
| 12 | §3 (disclosed, recorded text fallback) and §5.2 (errors surface; explicit "Continue without AI") |
| 13 | §3 (bounded text parser) |
| 14 | §3 (fixed precedence; new DEFAULT_RULES; static check covers both) |
| 15 | §2.1 (normative NORMALIZE_V1 + checked-in vectors) |
| 16 | §9 (run state machine, snapshots, stale rejection, invalidation) and §1 (moved helpers) |
| 17 | §8 (a complete v2 DTO) |
| 18 | §8 (legacy MARC labeled unverified, including in copies) |
| 19 | §8 (locked history RMW, UUIDs, awaited saves) |
| 20 | §7 (csv.js keeps the formula guard) |
| 21 | §11 (final-stage scoring, a pre-registered rule, a baseline, subdivision loss) |
| 22 | §11 (frozen manifest, seed, commit, cached LOC replay, a small-model run) |
| 23 | §12 (golden + adversarial fixtures by the lead; honesty and trust tests) |
| 24 | this table replaces the v1 closure claims |
