# SPEC-P5 — Local LCSH database in the extension

Status: DRAFT v1 (for review), 2026-09-27. Builds on SPEC-P4 (lookup
interface, Candidate, honesty rule) and on the builder contract
(`lcsh-db-builder` docs/SPEC.md v3.3 and docs/SCHEMA_QUERIES.md v2). The
round-1 extension review findings about the database (#1, #2, #20, #22, #23,
#24, #27, #28, #29, #30) are answered here; §15 maps them.

## 0. Goals, owner decisions, non-goals

Goals:
1. A second lookup backend, `local-db`, that answers the same `lookup()`
   contract as the LOC API backend (SPEC-P4 §4), so selection, MARC, history
   and exports work unchanged.
2. Download, verify, install, update and remove the database from the
   builder's Hugging Face dataset `kltng/lcsh-db-lite`.

Owner decisions (binding):
- Profiles: `core` (LCSH + LCGFT) is the default. `full` (+ LCNAF) is an
  opt-in "advanced" choice with a clear size warning. Measured on the lead's
  reference build (2026-09-27): core 62 MB download / 205 MB on disk; full
  1.87 GB download / 5.4 GB on disk.
- With `core`, names (LCNAF) are looked up online at LOC.
- With `full`, LCNAF rows have no MARC key; the key is fetched online from
  LOC when a name is chosen ("online fallback"). Offline → "MARC not
  available offline".

Honesty rule (SPEC-P4 §0) carries over: an LC ID, link, label or MARC key
shown to the user comes from a real record (LOC response or the verified
database), never from the model.

Non-goals: the database is never written by the extension (read-only); no
download resume; no background download when the tab is closed; no
offscreen document.

## 1. Files

New:
- `src/services/localdb/worker.js` — the database worker (module Worker).
- `src/services/localdb/client.js` — page-side RPC client + ownership lock.
- `src/services/localdb/install.js` — download/verify/install state machine
  (runs inside the worker; the page only sends commands).
- `src/services/localdb/pointer.js` — `latest.json` fetch + validation.
- `src/services/localdb/sql.js` — the SCHEMA_QUERIES Q1–Q5 text, copied
  byte-for-byte, plus the MATCH builder. Pure module (Node-testable).
- `src/services/localdb/sha256.js` — streaming SHA-256 (§4.4).
- `src/services/lookup/localDb.js` — the `local-db` lookup backend (§6).
- `src/services/lookup/hybrid.js` — per-authority delegation to the LOC API
  backend (§6.4).
- `src/services/pipeline/nameKeys.js` — online MARC-key fallback for LCNAF
  (§7).
- `src/components/LocalDbSettings.jsx` — the settings section (§8).
- `src/services/localdb/__fixtures__/` — lead-supplied fixture databases
  (§12).

Changed: `lookup/index.js` (backend choice), `pipeline/types.js`
(`source` may be `'local-db'`), `settings.js` (§2), `history.js` (backend
provenance), `manifest.json` (§10), `webpack.config.js` (copy the wasm file),
`SettingsPage.jsx`, `pipeline/run.js`/`workflow.js` (the §7 step).

## 2. Settings and installed-database record

Under the existing `'lcsh-settings'` Web Lock (SPEC-P3), `settings.js` gains:
- `lookupBackend`: `'loc-api'` (default) | `'local-db'`.
- `localDb`: `null` or `{profile, release, releaseCommit, file, dbSize,
  sha256Db, schemaVersion, normalizeVersion, compatFingerprint, installedAt,
  lastUpdateCheckAt}`. It is written ONLY by the installer after a verified
  install (§4.6) and cleared by uninstall.
- `lookupBackend: 'local-db'` without a valid `localDb` → treated as
  `'loc-api'`, with a visible notice "Local database not installed; using
  the Library of Congress online."

## 3. Worker and ownership

**One owner per browser profile.** The SQLite OPFS SAH-pool VFS needs
exclusive access (review #1). The page acquires the Web Lock
`'lcsh-localdb-owner'` (mode exclusive, `ifAvailable: true`) BEFORE it
creates the worker, and holds it until the worker is terminated.
- Lock not available → no worker in this tab. The tab shows "The local
  database is open in another tab of this extension" with two buttons: "Use
  the Library of Congress online in this tab" (this tab's runs use
  `loc-api`; the setting is not changed) and "Try again".
- The lock is released only after `worker.terminate()` (on page unload, or
  when the user uninstalls).
- Only the owner tab may install, update or uninstall.

**Worker.** Created once per owner page:
`new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})`.
- It loads `@sqlite.org/sqlite-wasm` (pinned exact version, the same as the
  builder's wasm check: 3.53.4-build1) from the extension package. The
  `.wasm` file is copied into `dist/` by webpack. No remote code.
- VFS: `installOpfsSAHPoolVfs({name: 'lcsh-pool'})`.
- The active database is opened read-only (`flags: 'r'`).

**RPC.** Page → worker `{id, op, args}`; worker → page `{id, ok, result}` or
`{id, ok: false, error: {kind, message}}`; plus progress events `{event:
'progress', ...}`. Ops: `status`, `query` (a named query from `sql.js` with
bound parameters — never raw SQL), `installStart`, `installCancel`,
`uninstall`, `meta`.
- Worker error or crash (`error`/`messageerror` event, or no answer to a
  `status` ping within 10 s): all pending RPCs are rejected with
  `kind: 'db_worker_failed'`; the client terminates the worker, releases the
  lock, and a later call re-creates both once. A second crash in one page
  life → the tab falls back to `loc-api` with a notice.

## 4. Install, update, uninstall

### 4.1 Pointer

`GET https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/main/latest.json`
(`cache: 'no-store'`). Validate (all required, exact types):
`pointer_version === 1`, `schema_version === 2`,
`normalize_version === 'NORMALIZE_V1'`, `compat_fingerprint` in the
extension's allowlist `SUPPORTED_FINGERPRINTS` (a constant), `release`
matches `^\d{4}\.\d{2}\.\d{2}\.\d+$`, `release_commit` is 40 hex,
`profiles.{core,full}` each with `url_pinned` (must start with
`https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/<release_commit>/releases/<release>/`),
`gz_size`, `db_size` (positive integers), `sha256_gz`, `sha256_db` (64 hex).
- An unsupported version or fingerprint → "A newer database format is
  available; update the extension to use it." The installed database (if
  any) stays usable.
- Release order compares the four numbers numerically (never as strings).

### 4.2 Confirmation

Before any download the page shows: profile, release date, download size,
disk size, the space needed during install (§4.5), and for `full` the
warning "Large download (about 1.9 GB) and about 5.4 GB of disk space. Keep
this tab open until it finishes." The user confirms with a click (the
click also calls `navigator.storage.persist()`; its result is only shown,
not required).

### 4.3 Stream and import (inside the worker)

1. `fetch(url_pinned)` (the worker fetches; nothing is posted between
   threads). HF answers with CORS for extension origins and redirects to its
   CDN, which also sends CORS headers (lead probe 2026-09-27), so no new
   host permission is needed.
2. A counting pass-through computes `sha256_gz` and the compressed byte
   count while bytes flow.
3. `DecompressionStream('gzip')`.
4. A second pass-through computes `sha256_db` and the decompressed byte
   count.
5. `poolUtil.importDb(stagingName, pullCallback)` with a PULL callback that
   reads the next chunk; `undefined` = end. The FIRST chunk given to
   `importDb` is at least 512 bytes (smaller leading chunks are coalesced;
   review #2 on the SQLite header check).
6. Backpressure is natural (the callback pulls). Memory stays bounded to one
   chunk plus the stream buffers.
7. Progress events every ≥ 500 ms: compressed bytes / `gz_size`.
8. Network idle timeout: no bytes for 60 s → abort with `kind:
   'network_stalled'`.
9. `installCancel` aborts the fetch; the importer stops at the next pull;
   the staging file is deleted.

`stagingName` = `/stage-<profile>-<release>-<8 random hex>.db`: never the
active file name, even for the same release (review #22).

### 4.4 Streaming SHA-256

`crypto.subtle.digest` cannot stream. `sha256.js` is a small incremental
SHA-256 (update/final). Choice to settle in review: a vetted dependency
(`@noble/hashes`, pinned) or ~100 lines of own code tested against NIST
vectors plus a 3 MB random buffer checked with `crypto.subtle`.

### 4.5 Verify, activate, clean up

After the stream ends:
1. Sizes and both hashes must equal the pointer's values. Any mismatch →
   delete the staging file, error "The download was damaged; nothing was
   changed."
2. Open the staging file read-only. `db_meta` must have `profile`,
   `schema_version = 2`, `normalize_version = NORMALIZE_V1`,
   `compat_fingerprint` = the pointer's; the six tables and FTS tables must
   exist. (No `PRAGMA quick_check`: the verified sha256 already proves the
   bytes are the published ones, and a quick check of 5.4 GB takes minutes.)
3. Activate: write the new `localDb` record (settings lock), then switch the
   worker's open handle to the new file, then delete the old active file.
4. If deletion of the old file fails → keep going; record it in
   `pendingDeletes` (settings) and retry on the next start.
5. Space: the install needs `db_size` for the staging file while the old
   database still exists. The page shows "About X GB free space needed during
   install" (old + new) and `navigator.storage.estimate()` as an estimate
   only (review #24). Any write/quota error during import → delete staging,
   keep the active database, error "Not enough storage space."

**Restart recovery.** On worker start: every file in the pool that is not
the active file and not listed in `pendingDeletes` is a leftover staging
file → deleted. A crash at any point therefore leaves either the old
installation or the new one active, never a half file.

### 4.6 Same release, update check, uninstall

- Installing the release that is already active and verified → no-op
  ("Already installed"). "Repair" re-downloads into a new staging file.
- Update check: when the owner page opens, at most once per 24 h, fetch the
  pointer. Newer supported release → banner "New LCSH data available
  (release X)" with a link to its `CHANGES.md` (pinned URL). Never
  auto-download.
- Uninstall: close the handle, delete the file, clear `localDb`, set
  `lookupBackend` to `loc-api`.

## 5. Row → Candidate mapping (one mapper)

For an `auth` row `{uri: localId, authority, label, deprecated, marc_key}`:
`{cid: authority + ':' + localId, authority, localId, uri:
'http://id.loc.gov/authorities/' + SEGMENT[authority] + '/' + localId,
label, marcKey: marc_key, rdfTypes: [], matchClass, source: 'local-db',
via}` with `SEGMENT = {lcsh: 'subjects', lcgft: 'genreForms', lcnaf:
'names'}`. `via` ∈ `'label' | 'variant' | 'replacement'` (display only).
`types.js` `isCandidate` accepts `source` `'loc-api' | 'local-db'`. A row
whose `marc_key` starts with `18` is never a candidate (defensive; the
builder excludes them).

## 6. The `local-db` backend (`lookup/localDb.js`)

`lookup(suggestion, {limit, signal})` returns the SPEC-P4 LookupResult shape.
`toSearch()` and `keywordText()` are reused from P4.

### 6.1 Stages (mirror P4 §4.2)

Routing (P4 table) is filtered to the authorities in the installed profile;
the rest go to §6.4.
- **L1** full heading: Q1 then Q2 with `NORMALIZE_V1(full)` over the routed
  local authorities. If any accepted candidate is `exact-full` → stop.
- **L2** main heading (only if it differs): Q1 + Q2 with the main heading.
  Stop on `exact-full`.
- If any `exact-*` candidate exists → stop.
- **L3** full-text: Q3a then Q3b with the MATCH string of `full`
  (SCHEMA_QUERIES). Q3a rows first, then Q3b rows not already listed.
- **L4** (kind `name` or `unknown`, and L3 gave zero rows): Q3a + Q3b with
  the main heading.

### 6.2 Deprecated rows

A deprecated row is never a candidate. For each deprecated row hit in L1–L2,
Q4 gives its replacements; each replacement row that exists in this database
and is not deprecated becomes a candidate with `via: 'replacement'` (one hop
here; the UI shows "replaces the old heading <label>"). A replacement not in
this database (e.g. an LCNAF target in `core`) is listed as a note, not a
candidate.

### 6.3 Ranking and outcome

All candidates go through P4 `rankCandidates` (class by `matchClassOf` on the
candidate's preferred label; dedupe by `cid`; best class kept; the
authority order, then stage order, then row order as tie-breakers), then the
limit. A variant match therefore usually ranks as `keyword` unless its
preferred label also matches. Outcomes: `found`, `no-results`; a worker/SQL
error → `failed` with `errorKind: 'local_db'`.

### 6.4 Hybrid routing (`lookup/hybrid.js`)

With `core`, a suggestion routed to `lcnaf` (kinds `name`, `geographic`,
`unknown`) also needs names. The hybrid backend runs the local stages for
local authorities and, in parallel, the P4 LOC API stages restricted to the
non-local authorities (same scheduler, cache and budget). Candidates are
pooled and ranked together; `requests` lists both. If the LOC part fails,
the outcome is `partial` (local candidates exist) or `failed`, with the LOC
error kind. Offline and only local authorities routed → no network at all.

## 7. Name MARC keys online (`pipeline/nameKeys.js`)

Before recommendations are built, every chosen candidate with
`source: 'local-db'`, `authority: 'lcnaf'` and `marcKey: null` gets one LOC
request: suggest2 on the names endpoint with `q` = the label,
`searchtype=leftanchored`, through the P4 scheduler. The hit whose `uri`
equals the candidate's `uri` and passes `hit.js` validation supplies
`marcKey` (the candidate object is copied; `marcKeySource: 'loc-api'`).
No matching hit or a network error → the MARC step gives `unavailable` with
reason `'MARC not available offline'` (a new P4 reason string). This step is
skipped when the user is offline (`navigator.onLine === false`).

## 8. UI

Settings → "Lookup source":
- "Library of Congress (online)" (default).
- "Local database" with the installed profile, release, size and date, or
  "Not installed".
- Install panel: "Core — subjects and genres (about 62 MB download, 205 MB on
  disk). Names are looked up online." [Download]; an "Advanced" disclosure
  with "Full — also 12 million names (about 1.9 GB download, 5.4 GB on
  disk)". Sizes come from the pointer, not constants.
- During install: progress bar, bytes, Cancel, "Keep this tab open".
- Errors from §4 in plain words, each with "Try again".
- Update banner (§4.6), Repair, Uninstall.
- The Matches step shows the source of each candidate list ("Local database
  (release X)" / "Library of Congress online"). A `via: 'variant'` candidate
  shows "matched a variant name"; `via: 'replacement'` shows the replaced
  heading.

## 9. History and exports

`lookup.backend` records `'local-db'` plus `{profile, release}`, or
`'hybrid'` with both parts. Candidate `source` is stored per candidate (P4
allowlist already has it). CSV/Copy all unchanged; the MARC reason string of
§7 appears where it applies.

## 10. Manifest and permissions

- Add `"unlimitedStorage"` to `permissions` (the database; review #24). No
  new host permissions (§4.3 probe). `content_security_policy.extension_pages`
  must allow `'wasm-unsafe-eval'` for the packaged wasm (valid in MV3).
- The privacy policy and Store listing gain: "Optional: downloads a database
  from Hugging Face (huggingface.co and its CDN); no personal data is sent."

## 11. Performance targets (checked live, §13)

Native SQLite on the builder's real `full` database (lead, 2026-09-27):
Q1/Q2 0.1 ms; Q3a "john" (162,048 FTS matches) 280 ms, Q3b "john" 226 ms,
"united states" 201 ms, "history" 70 ms, "smith john" 12 ms. wasm is
expected to be 2–3× slower. Targets, measured in Chrome with `full`: every
Q1/Q2 < 20 ms; Q3a or Q3b < 1 s even for the most common single words;
one suggestion's whole local lookup < 2 s; worker start (wasm load + VFS +
open) < 3 s. A miss is reported with numbers before any design change.

## 12. Tests (vitest, Node)

The lead supplies `src/services/localdb/__fixtures__/fixture_core.db` and
`fixture_full.db`, built by the builder from its real fixtures (lead-owned).
Node runs `@sqlite.org/sqlite-wasm` in memory (no OPFS).
1. `sql.js` text equals SCHEMA_QUERIES.md (the lead supplies a sha256 of each
   query block; the test pins it).
2. MATCH builder: the SCHEMA_QUERIES rules incl. no-token input.
3. Every builder golden whose records are in the fixtures, through
   `localDb.js`'s query layer (the lead supplies the selected list).
4. Stages L1–L4, deprecated → replacement, variant, `core` vs `full`
   routing, ranking reuse, outcomes.
5. Hybrid: local + mocked LOC parts, partial/failed, offline.
6. Pointer validation: every field and each rejection message; numeric
   release order.
7. Install state machine with a fake importer: first-chunk coalescing (1-,
   7-, 15-, 511-byte leading chunks), empty chunks, truncated gzip, hash and
   size mismatch, cancel during stream, quota error, same-release no-op,
   staging names, restart cleanup, `pendingDeletes`.
8. SHA-256: NIST vectors + random buffers vs `crypto.subtle`.
9. Ownership: lock not available → fallback UI state; worker crash → reject
   pending, one re-create, second crash → `loc-api`.
10. Name keys: match by uri, validation, offline skip, the new reason.
11. Honesty: render the Matches/Recommendations steps with `local-db`
   candidates; IDs/links only from rows.

## 13. Live acceptance (lead, Chrome)

1. Install core; lookup of the two P4 records with `local-db`; results
   compared with `loc-api` runs (same headings found where both have them).
2. Install full (the real 1.9 GB file); names found offline; a chosen name
   gets its MARC key online; offline → "MARC not available offline".
3. Two app tabs: the second shows the "open in another tab" state and works
   with online lookup.
4. Kill the worker (DevTools) during a lookup and during install.
5. Close the tab at each install boundary (streaming, verifying, activating)
   and reopen: old or new installation active, no leftovers.
6. Same-release install = no-op; Repair works.
7. Corrupted download (proxy flips a byte) → rejected, old kept.
8. Unsupported pointer (fingerprint not allowed) → message, old kept.
9. Update banner with a newer release.
10. §11 timings.

## 14. Open questions for review

1. Streaming SHA-256: dependency or own code (§4.4)?
2. Is skipping `PRAGMA quick_check` acceptable given both hashes are
   verified?
3. The hybrid backend runs LOC requests for names even when `full` is not
   installed and the user chose `local-db`: is "partial" the right outcome
   when offline?
4. `via: 'variant'` candidates rank as `keyword`; should an exact variant
   match get its own class (it would change P4's MATCH_CLASSES and the
   exact-only fallback)?

## 15. Round-1 extension review findings → P5

| # | Fix |
|---|---|
| 1 | §3 Web Lock owner, fallback UI, crash handling |
| 2 | §4.3 worker-owned fetch + pull callback, 512-byte first chunk, cancel; §12 row 7 |
| 20 | §4.1 pinned URLs from the pointer, both hashes verified (§4.5) |
| 22 | §4.3 unique staging names; §4.5 activation order; §4.6 same-release no-op |
| 23 | §4.1 version/fingerprint checks before download and §4.5 in the DB; §5 one mapper |
| 24 | §4.5 space wording, estimate is only an estimate, quota errors keep the old DB; §10 `unlimitedStorage` |
| 27 | SCHEMA_QUERIES Q3 (tokenizer, MATCH, ranking, dedupe) used as is |
| 28 | builder §8.6 plan checks per query class; §12 uses fixtures |
| 29 | NORMALIZE_V1 shared vectors (51, incl. Unicode-boundary cases) |
| 30 | §12 unit gates vs §13 Chrome gates, listed separately |
