# SPEC-P5 — Local LCSH database in the extension

Status: v2.7, 2026-10-02 (round 2 §17; round 3 §18; live findings §19; reviewer edits to them §20; fault-injection test build §21; gzip decode failure = damaged §4.4 step 4). v1 was REJECTED (14 findings, 4 HIGH;
`.dispatch/spec-review-p5-1/last_message.md`; v1 archived at
`.dispatch/SPEC-P5.v1.md`). §16 maps each finding to its fix. Builds on
SPEC-P4 (lookup step, Candidate, honesty rule) and the builder contract
(`lcsh-db-builder` docs/SPEC.md v3.5, docs/SCHEMA_QUERIES.md v2).

## 0. Goals, owner decisions, non-goals

Goals:
1. A second lookup backend, `local-db`, behind the P4 backend interface, so
   selection, MARC, history and exports keep their P4 guarantees.
2. Download, verify, install, update and remove the database from the
   builder's Hugging Face dataset `kltng/lcsh-db-lite`.

Owner decisions (binding):
- `core` (LCSH + LCGFT) is the default. `full` (+ LCNAF) is an opt-in
  "advanced" choice with a clear size warning. Lead-measured on the real
  builder output (2026-09-27): core 62 MB download / 205 MB on disk; full
  1.87 GB download / 5.4 GB on disk.
- With `core`, names (LCNAF) are looked up online at LOC.
- With `full`, LCNAF rows have no MARC key; it is fetched online from LOC for
  chosen names (§7).

Honesty rule (SPEC-P4 §0) carries over: an LC ID, link, label or MARC key
shown to the user comes from a real record (a validated LOC response or the
verified database), never from the model. A variant match never becomes an
automatic exact acceptance (§6.3).

Non-goals: the extension never writes the database's contents; no download
resume; no download that survives closing the owner tab; no offscreen
document; no CJK substring search (the published tokenizer cannot do it;
SCHEMA_QUERIES "CJK limitation").

## 1. Files

New:
- `src/services/localdb/worker.js` — the database worker.
- `src/services/localdb/client.js` — the ONE page-side owner client (§3).
- `src/services/localdb/install.js` — the install/update/uninstall protocol
  (§4), run in the worker; settings commits go through the §3.3 bridge.
- `src/services/localdb/pointer.js` — `latest.json` fetch + validation.
- `src/services/localdb/sql.js` — SCHEMA_QUERIES Q1–Q5 text copied
  byte-for-byte + the Q3 MATCH builder. Pure module (Node-testable).
- `src/services/localdb/sha256.js` — a narrow wrapper over the pinned
  `@noble/hashes` incremental SHA-256.
- `src/services/lookup/localDb.js` — local query layer + row mapper (§5–§6).
- `src/services/lookup/coordinator.js` — the ONE stage coordinator for
  `loc-api`, `local-db` and mixed routing (§6.1).
- `src/services/pipeline/nameKeys.js` — the name-key operation (§7).
- `src/components/LocalDbSettings.jsx` — the settings section (§8).
- `src/services/localdb/__fixtures__/` — lead-supplied fixture databases.

Changed: `lookup/locApi.js` (extract an authority-scoped request helper; the
`loc-api` behavior stays byte-for-byte the same, §6.1), `lookup/index.js`,
`pipeline/types.js` (`source` `'loc-api' | 'local-db'`; new error kind
`local_db`; new MARC reasons §7), `settings.js` (§2), `history.js` (§9),
`pipeline/exports.js` (§9 `marc_reason`), `pipeline/workflow.js` / `run.js`
(§6.5, §7), `components/pipelineText.js`, `SettingsPage.jsx`,
`manifest.json` (§10), `webpack.common.js` (copy the wasm file),
`package.json` (+ `@sqlite.org/sqlite-wasm` 3.53.4-build1 and
`@noble/hashes`, both exact versions; the lead runs `npm install`).

## 2. Settings

Under the `'lcsh-settings'` Web Lock (SPEC-P3), `settings.js` gains:
- `lookupBackend`: `'loc-api'` (default) | `'local-db'`.
- `localDb`: `null` or the installed record `{profile, release,
  releaseCommit, file, dbSize, sha256Db, compatFingerprint, installedAt}`.
  It changes ONLY at the §4.5 commit point or the §4.7 uninstall commit.
- `localDbPendingDeletes`: array of pool file names to delete later (§4.6).
- `localDbUpdateCheck`: `{lastCheckedAt, latestSeen}` (outside the installed
  record).
- `lookupBackend: 'local-db'` with `localDb: null` → runs use `loc-api` and
  show "Local database not installed; using the Library of Congress online."

"Already installed" = the same `profile`, `release`, `sha256Db` and
`compatFingerprint`.

## 3. Ownership, worker, page lifetime

### 3.1 One owner per browser profile

The SAH-pool VFS needs exclusive access, even for read-only use.
- The popup NEVER acquires ownership. Only `app.html` does.
- ONE client object per app document, created at module level above the
  hash-route components (the workflow and `#settings` share it). Hash
  navigation never terminates it.
- On start the client requests the Web Lock `'lcsh-localdb-owner'`
  (exclusive, `ifAvailable: true`) BEFORE creating the worker, and keeps it
  until the document ends. Correctness never depends on an unload handler:
  the browser releases the lock when the document is gone.
- Lock not available → no worker in this tab. The tab shows "The local
  database is open in another tab of this extension" with "Use the Library of
  Congress online in this tab" (this tab's runs use `loc-api`; settings
  unchanged) and "Try again" (a new `ifAvailable` request; takeover after the
  owner tab closed).
- Lock order is always owner → settings. Settings operations never wait for
  ownership.

### 3.2 Worker and RPC

- `new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})`,
  loading the packaged `@sqlite.org/sqlite-wasm` 3.53.4-build1 (the builder's
  wasm check uses the same version). No remote code.
- `installOpfsSAHPoolVfs({name: 'lcsh-pool'})`. A pool-busy error is reported
  as contention (`kind: 'db_busy'`), never as corruption.
- RPC page → worker `{id, op, args, workerGeneration}`; worker → page `{id, ok,
  result}` / `{id, ok: false, error: {kind, message}}`; progress events.
  Ops: `status`, `query` (a named query from `sql.js` + bound parameters;
  never raw SQL), `install`, `cancel`, `uninstall`.
- Worker crash (`error`/`messageerror`, or a HANG): pending RPCs reject with
  `db_worker_failed`; the client terminates the worker and creates one new
  worker while still holding the lock. A second crash in one document life →
  this tab uses `loc-api`, with a notice.
- **Hang = no answer to a `status` probe AND no progress event for 30 s.** A
  worker that is still emitting progress events is alive even if a probe
  answer is late; without a running mutation the 30 s apply to probes alone.
- **Pool acquisition is NON-DESTRUCTIVE (data-loss guard).** In the pinned
  `@sqlite.org/sqlite-wasm` 3.53.4, ANY failure of `installOpfsSAHPoolVfs`
  after the pool directory is opened runs `removeVfs()`, which recursively
  deletes the pool directory — the installed database (dist/index.mjs
  ~16951 → ~16449; the library documents `removeVfs` as "intended primarily
  for testing"). Contention (another worker still holding the access
  handles) is such a failure. Rules:
  1. Before the worker installs the pool, it installs a guard for its whole
     life: `FileSystemDirectoryHandle.prototype.removeEntry` REFUSES any call
     with `{recursive: true}` (throws; the library's cleanup swallows the
     error, so the init failure still propagates, and nothing is deleted).
     Justification: in the pinned package the only recursive removals are
     `removeVfs()` and the `opfs`-VFS `rmfr` helpers, which this extension
     does not use; this extension's own code never removes a directory.
     Non-recursive `removeEntry` (slot files) is untouched. Install and
     verify the guard BEFORE acquisition; abort initialization if installing
     it fails. Forward permitted calls with the original receiver and
     arguments. Acquire with `clearOnInit: false`. The guard prevents
     recursive directory deletion; it does not disable the pinned library's
     own metadata sanitation of invalid or unassociated slots.
  2. Retry ONLY `NoModificationAllowedError` (contention), with backoff, for
     up to 30 s. An initializer rejection is NOT a barrier for its handle
     requests (the library acquires with a fail-fast `Promise.all`, so a
     late request can still succeed after the failure cleanup and keep a
     handle in the abandoned pool). Therefore **each retry happens in a
     FRESH guarded worker**: the failed worker is terminated (which releases
     everything it holds once it is gone) and a new worker repeats the
     guarded acquisition. Never retry inside the same worker. Exhaustion
     reports `db_busy`, preserving files and settings.
  3. The acquisition retry budget starts with acquisition, AFTER the §3.3
     drain, and never bounds or bypasses that drain. Startup monitoring
     allows the full acquisition window without racing an equal-duration
     watchdog; initialization stays monitored. Recovery and local queries
     begin only after a successful acquisition. Retry expiry never triggers
     staging cleanup for an unresolved commit. Only progress from the
     CURRENT worker generation and running operation refreshes liveness.
  (Live finding 2026-10-01: an immediate replacement during the `full`
  install failed with "Access Handles cannot be created if there is another
  open one", then `removeVfs() failed with no recovery strategy` — the
  deletion failed only because the old worker still held the handles. This
  hazard exists in the code committed at fbb626c, independent of retries;
  rule 1 closes it.)

### 3.3 Settings bridge

The worker cannot call `chrome.storage`. Every settings access the installer
needs is a worker → page request `{bridgeId, workerGeneration, operationId,
action, expectedLocalDb, patch}` handled by the client with `settings.js`:
- `action: 'read'` → the current `{lookupBackend, localDb,
  localDbPendingDeletes}`.
- `action: 'commit'`: under `'lcsh-settings'`, the client (1) checks that
  `workerGeneration` is the client's current worker generation and
  `operationId` is the running operation, (2) rereads settings, (3) compares
  `expectedLocalDb` STRUCTURALLY (deep equality of the record, `null`
  included) with the fresh `localDb`, (4) RECHECKS `workerGeneration` and
  `operationId` immediately before issuing the storage write, with no await
  in between, (5) applies `patch` and writes, and answers after the write is
  confirmed: `{ok: true, current}` or `{ok: false,
  reason: 'stale-generation' | 'changed' | 'write-failed', current}`.
- `patch` is allowlisted: `localDb`, `lookupBackend`,
  `pendingDeletesAdd: [names]`, `pendingDeletesRemove: [names]`. The
  add/remove lists are applied to the FRESH `localDbPendingDeletes` read in
  step 2; every other setting is preserved.
- Worker replacement: the client first increments `workerGeneration`, then
  WAITS for every ADMITTED commit handler to settle (including handlers still
  awaiting their settings read), and only then starts the new worker's §3.4
  recovery. Already-issued writes are drained; a handler that has not yet
  issued its write fails the step-4 fence.
- `action: 'read'` also runs under `'lcsh-settings'`.
- Startup recovery (§3.4) is a serialized internal operation with its own
  `operationId`, recognized by the bridge before the client is ready; its
  cleanup commits use the recorded active `localDb` as `expectedLocalDb`.
- The update check (§4.6) is owned by the PAGE, which reads/writes
  `localDbUpdateCheck` through a locked `settings.js` helper (not the
  bridge).
- Naming: `workerGeneration` (this section) and `installationIdentity`
  (§6.5) are different things.

### 3.4 Startup recovery (before the client is ready)

1. Hold the owner lock; create the worker; install the VFS.
2. Read settings through the bridge. A read or validation failure → keep ALL
   pool files, state `recovery-unavailable` ("Local database settings could
   not be read"), serve no local queries, `loc-api` for runs.
3. Recorded active file (`localDb.file`): open read-only and validate it
   cheaply against the INSTALLED RECORD (not the pointer or a newly selected
   profile): §4.5 steps 5–6 with `db_meta.profile = localDb.profile` and
   `compat_fingerprint = localDb.compatFingerprint`, and
   `page_count × page_size` = `localDb.dbSize` (the full hash was checked at
   install; it is not repeated at every start). Missing or failing → state
   `repair-needed` ("The local database is damaged or missing" + Repair /
   Uninstall): NO local queries are served; runs use `loc-api` with a
   visible notice until a repair succeeds. Never promote another file
   because it exists.
4. Delete every pool file that is not the active file (leftover staging
   files and `localDbPendingDeletes` entries). Deletion is idempotent (an
   absent file counts as deleted). Successful or absent entries are removed
   from `localDbPendingDeletes`; failures stay. The active file is never
   deleted here.
5. Then the client is ready. Local queries are served only in the normal
   state (not in `repair-needed` or `recovery-unavailable`).

## 4. Install, update, uninstall

### 4.1 One mutation at a time

The worker runs at most ONE mutation (install, repair, uninstall), with an
`operationId`. Another mutation request while one runs is refused ("Another
database operation is running"). `cancel` names the `operationId`.

### 4.2 Pointer

`GET https://huggingface.co/datasets/kltng/lcsh-db-lite/resolve/main/latest.json`
with `cache: 'no-store'`, `credentials: 'omit'`, `referrerPolicy:
'no-referrer'`, a 20 s timeout, and HTTP 200 required. Validate (all
required, exact types):
- `pointer_version === 1`, `schema_version === 2`,
  `normalize_version === 'NORMALIZE_V1'`, `compat_fingerprint` in the
  extension's `SUPPORTED_FINGERPRINTS` constant;
- `release` matches `^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d*)$`, is a real
  date, and its sequence number is a safe integer; releases compare as four
  numbers;
- `release_commit` is 40 lowercase hex;
- for each profile: `gz_size`, `db_size` are positive safe integers;
  `sha256_gz`, `sha256_db` are 64 lowercase hex; `url_pinned` parses with
  `new URL()` to protocol `https:`, host `huggingface.co`, no username,
  password, query or fragment, and a pathname EXACTLY equal to
  `/datasets/kltng/lcsh-db-lite/resolve/<release_commit>/releases/<release>/lcsh-<profile>.db.gz`
  (string equality after parsing: alternate spellings that normalize to
  exactly this path are allowed; encoded separators or anything that yields
  a different pathname are rejected).
- The installer uses only the pointer's profile entries. It does not read the
  manifest or the index files.
- Unsupported version or fingerprint → "A newer database format is available;
  update the extension to use it." The installed database stays usable.

### 4.3 Confirmation

Before any download the page shows: profile, release, download size,
database size, the additional space the install needs (`db_size`, while the
old database still exists), and the peak database storage during install
(old `dbSize` + new `db_size`), plus "Keep this tab open until it finishes."
For `full`: "Large download (about 1.9 GB) and about 5.4 GB of disk space."
Sizes come from the pointer. `navigator.storage.estimate()` is shown only as
"estimated storage used by this extension / quota", never as free disk
space. The confirming click also calls `navigator.storage.persist()` (the
result is shown, not required).

### 4.4 Stream and import (worker)

1. Staging name `/stage-<profile>-<release>-<8 random hex>.db`; regenerate
   while it equals any existing pool file name. Never the active name.
2. `fetch(url_pinned, {credentials: 'omit', referrerPolicy: 'no-referrer'})`;
   HTTP 200 required. HF redirects to its CDN; both send CORS headers for
   extension origins (lead probe 2026-09-27). The production package is
   checked in a fresh profile without optional grants (§13).
3. Pass-through 1: compressed byte count + `sha256_gz`. Abort as soon as the
   count exceeds `gz_size`.
4. `DecompressionStream('gzip')`. A decoding failure (invalid or truncated
   gzip data in a body that the network delivered without error) is
   `damaged`, not `network`: the bytes received do not match the release.
   Only an error of the HTTP response body itself (connection lost, reset)
   is `network` (or `network_stalled` per step 8). (v2.7, live §13 row 8:
   one flipped byte showed "Check your connection".)
5. Pass-through 2: decompressed byte count + `sha256_db`. Abort as soon as it
   exceeds `db_size`.
6. `poolUtil.importDb(stagingName, pull)`; `pull` returns the next chunk or
   `undefined` at the end. The first chunk given to the importer is at least
   512 bytes (smaller leading chunks are coalesced).
7. Progress events at most every 500 ms (compressed bytes / `gz_size`).
7b. **Across the whole install (download/decompress/import pull, hashing,
   and the §4.5 step 3 read-back), check a shared monotonic work budget
   between bounded work units and await a MACROTASK when 100 ms has elapsed
   since the last yield.** Bound hash, write and read units; one synchronous
   browser operation or a scheduling delay may exceed this budget. A resolved
   Promise is not a yield. Preserve stream backpressure and bounded
   buffering; do not prefetch the database or launch unawaited work. Recheck
   cancellation after every yield and before returning another import chunk
   or entering `committing`. Cancellation latency includes the current
   synchronous work unit and event-loop scheduling; cleanup completion has no
   100 ms guarantee. Reading buffered stream data resolves as microtasks and each
   SAH write is synchronous, so without an explicit macrotask yield the worker
   cannot answer `status` or `cancel` while data arrives faster than it is
   written. (Live finding 2026-10-01: during the real `full` install the
   worker stopped answering for > 2 s five times; the core install failed
   once on the same cause.)
8. No bytes for 60 s → abort (`network_stalled`).
9. `cancel` before the `committing` state (§4.5 step 7): abort the fetch,
   stop at the next pull, then the common terminal rule (§4.8).

### 4.5 Verify, commit, switch

1. Stream counts and both stream hashes must equal the pointer's values.
2. Open the staging file read-only (the new handle is kept open).
3. **Stored-byte check** (the importer ignores short writes). Get the
   staging database's `sqlite3_file` with
   `sqlite3_file_control(db, 'main', SQLITE_FCNTL_FILE_POINTER, pOut)` and
   call its VFS methods: `xFileSize` must equal `db_size`; then sequential
   `xRead` calls over logical offsets `[0, db_size)` with one reusable buffer
   of at most 8 MiB, rejecting every result other than `SQLITE_OK`
   (including `SQLITE_IOERR_SHORT_READ`), feed SHA-256; the digest must equal
   `sha256_db`. Separately, `page_count × page_size` must equal `db_size`.
   - This reads through the VFS, so the SAH pool's own file header stays
     hidden, and it reads the real bytes of every page (unlike
     `sqlite_dbpage`, which returns synthesized zeros for the lock-byte page
     at offset 1 GiB, and whose `BETWEEN` ranges are not index-bounded).
   - Lead probe 2026-09-27 (pinned 3.53.4, Node, `memdb` VFS): the file
     pointer, `xFileSize` and `xRead` work from JS (`sqlite3_io_methods`
     offsets `xRead` 8, `xFileSize` 24 on wasm32); the hash equals the
     page-by-page hash; a read past the end returns 522
     (`SQLITE_IOERR_SHORT_READ`). The SAH-pool VFS is checked in Chrome
     (§13).
   - The builder publishes DELETE mode; header bytes 18–19 are already 1, 1
     (lead-checked on the real files), so the importer's header rewrite
     changes nothing.
   - Between read batches the worker yields to its event loop and handles
     `cancel` and `status` there; it reports a separate "Verifying" phase
     with progress. Verification follows §3.2 liveness monitoring and §4.4
     step 7b yielding.
     Cost: one extra read + hash of `db_size` bytes (5.4 GB for `full`);
     its browser time is measured in §13, not estimated.
4. Any failure in steps 1–3 → the common terminal rule (§4.8) with "The
   download was damaged; nothing was changed."
5. `db_meta`: `profile` equals the SELECTED profile; `schema_version` =
   `'2'`; `normalize_version` = `'NORMALIZE_V1'`; `lh_format` = `'LH1'`;
   `compat_fingerprint` = the pointer's.
6. `sqlite_master` has exactly these application objects by name:
   `db_meta`, `auth`, `alt_label`, `hierarchy`, `auth_fts`, `alt_label_fts`
   (FTS shadow tables and indexes are allowed).
7. **Commit point.** First enter the state `committing`: `cancel` is
   refused from now on ("Finishing install"); a `cancel` accepted earlier
   must have finished its cleanup before this step can start. Gate queries
   (new queries wait; running ones finish). Send the bridge `commit` with
   `expectedLocalDb` = the record read at the start of the operation and
   `patch` = `{localDb: newRecord, pendingDeletesAdd: [oldFile]}` (only if
   there is an old file). The commit point is the SUCCESSFUL SETTINGS WRITE;
   the bridge answer only reports its result, so a lost answer does not mean
   that no commit happened. While the answer is outstanding, BOTH files
   are kept.
   - `{ok: false, reason: 'changed' | 'stale-generation' | 'write-failed'}`
     → the common terminal rule (§4.8); the old installation is untouched.
   - Bridge error or no answer (result uncertain) → wait for the outstanding
     commit handler to settle, then `read` again (under the settings lock).
     If `localDb` equals the new record → continue at step 8; if it equals
     the old record → terminal rule; if the read fails or shows anything
     else → keep BOTH files, serve no local queries, state
     `recovery-unavailable`.
8. Switch: the worker's active handle becomes the new handle; the old handle
   is closed; ungate.
9. Delete the old file (never while open). Success → a bridge commit with
   `patch: {pendingDeletesRemove: [oldFile]}` (and `expectedLocalDb` = the
   new record); failure → it stays pending for §3.4.

A crash at any point leaves settings naming either the old file (commit not
done) or the new file (commit done); §3.4 then cleans up. There is never a
window where settings name a file that does not exist, except by external
deletion (→ `repair-needed`).

### 4.6 Install the same release, update check

- Same profile/release/digest/fingerprint as the active record → "Already
  installed" (no download). "Repair" downloads into a new staging file and
  commits like an update.
- Update check: when the owner page opens, at most once per 24 h
  (`localDbUpdateCheck`), fetch the pointer. A newer supported release →
  banner "New LCSH data available (release X)" with a link to its
  `CHANGES.md` (built from `release_commit` and the release path). Never
  auto-download.
- Profile switch (core ↔ full) = install of the other profile; the old
  profile's file is retired at the commit.

### 4.7 Uninstall

1. Refuse if another mutation runs. Enter `committing` (no cancel). Gate
   queries; close the active handle.
2. Bridge commit: `expectedLocalDb` = current record, `patch` =
   `{localDb: null, lookupBackend: 'loc-api', pendingDeletesAdd: [file]}`.
3. Refused/failed → reopen the file read-only, ungate, report; the
   installation stays. Uncertain → the same reconciliation as §4.5 step 7
   (reread; `null` → continue; old record → reopen and ungate; otherwise
   `recovery-unavailable`, files kept).
4. Delete the file; on success `pendingDeletesRemove`. Ungate on every
   resolved exit. The UI distinguishes "Uninstalled" from "Uninstalled;
   cleanup pending".

### 4.8 Common terminal rule

It applies to failures and accepted cancellations BEFORE `committing`, and to
commit attempts DEFINITIVELY resolved as not committed (`ok: false`, or a
reconciliation read showing the old record). It never applies while a
commit's result is unresolved: then both files are kept and §4.5 step 7
reconciliation runs.

Stop the import or verification; finalize statements; close every staging
handle; then delete the staging file. A failed deletion is recorded with
`pendingDeletesAdd` (best effort) and otherwise left to §3.4, which deletes
every non-active file anyway. Ungate queries. Report the error in plain
words with "Try again".

## 5. Row → Candidate mapping (`localDb.js`, one mapper)

**Query contract.** Authority retrieval uses exactly SCHEMA_QUERIES Q1–Q5.
Installation and recovery (§3.4, §4.5) may additionally run read-only
`db_meta` / `sqlite_master` reads, `PRAGMA page_size` / `page_count`, and
the §4.5 step 3 file read. These are internal to the worker and never
exposed through the `query` RPC. (The builder spec v3.4 §6.1 states the
same exception.)

An `auth` row `{uri: localId, authority, label, deprecated, marc_key}` maps to
`{cid: authority + ':' + localId, authority, localId,
uri: 'http://id.loc.gov/authorities/' + SEGMENT[authority] + '/' + localId,
label, marcKey: marc_key, rdfTypes: [], matchClass, source: 'local-db',
via, replacementFrom}` with `SEGMENT = {lcsh: 'subjects', lcgft: 'genreForms',
lcnaf: 'names'}`.
- `via` ∈ `'label' | 'variant' | 'replacement'` (display only).
- `replacementFrom`: for `via: 'replacement'`, `[{authority, localId,
  label}]` of the deprecated row(s) it replaces; otherwise absent.
- A deprecated row, or a row whose `marc_key` starts with `18`, is REJECTED
  by the mapper (counted in `rejectedHits`). Only mapped rows count as
  accepted candidates anywhere in §6.
- Unresolved replacement note (not a candidate): `{fromAuthority,
  fromLocalId, fromLabel, targetAuthority, targetLocalId, reason:
  'not-in-database' | 'deprecated-target'}`.

## 6. Lookup

### 6.1 One stage coordinator (`lookup/coordinator.js`)

P4's staged search (SPEC-P4 §4.2) becomes a coordinator that sends each
(authority, query) to the backend that holds that authority:
- `loc-api` setting: every authority → LOC (behavior identical to P4; the
  P4 request-sequence tests must pass unchanged).
- `local-db` with `full`: every authority → local.
- `local-db` with `core`: `lcsh`, `lcgft` → local; `lcnaf` → LOC.

Rules (the ORIGINAL P4 `ROUTING` order is kept):
- **Stage 1** (full heading), **Stage 2** (main heading, if different): for
  every routed authority run the stage's search on its backend — local: Q1
  then Q2 with `NORMALIZE_V1(text)`; LOC: suggest2 leftanchored. ALL parts of
  the stage finish before the pooled stop condition is checked (any accepted
  `exact-full` → stop; after stage 2, any accepted `exact-*` → stop).
  Deprecated hits in these stages add their Q4 replacements (§6.2).
- **Stage 3**: the FIRST routed authority only, on its backend — local: Q3a
  then Q3b rows not already listed (MATCH string of the full heading); LOC:
  suggest2 keyword.
- **Stage 4**: only if stage 3 ran successfully with ZERO accepted
  candidates and the kind is `name` or `unknown`: LCNAF only, on its backend
  (local Q3a + Q3b with the main heading, or LOC keyword).
- All candidates are ranked together by P4 `rankCandidates` with the
  original authority index, stage and row/hit index, then cut to `limit`.

The LOC side uses an authority-scoped helper extracted from `locApi.js` that
keeps the page scheduler and the per-run validated-response cache. All
branches share the lookup step's ONE signal (P4 budget: 120 s per step) and
the Retry `bypassCache`. There is no second budget.

**Retrieval difference (documented, not a bug):** local stages 1–2 use
exact preferred/variant lookups where LOC uses left-anchored suggest2, and
local stage 3 uses bounded FTS. Candidate sets can therefore differ from the
online ones; prefix-class candidates (e.g. `Japan--History--20th century`)
come from FTS in stage 3.

### 6.2 Deprecated rows (one hop)

For a deprecated row hit in stages 1–2: Q4 gives its replacements. Each
target that exists in this database, is not deprecated and passes the mapper
becomes a candidate with `via: 'replacement'` and `replacementFrom`; its
match class is computed on ITS OWN preferred label. A target not in this
database → note `not-in-database`; a deprecated target → note
`deprecated-target` (no further hops). Notes are shown in the Matches step.

### 6.3 Classes and the exact-only fallback

Match classes stay P4's (`matchClassOf` on the candidate's preferred label).
A variant match (Q2) is usually `keyword` unless its preferred label also
matches; `via: 'variant'` only explains it. P4's exact-only fallback (a
unique `exact-full`) and subdivision bookkeeping are unchanged. Model
subdivisions are never appended to authority MARC.

### 6.4 Backend return shape

`lookup(suggestion, {limit, signal, bypassCache})` returns P4's raw shape
plus two additive fields: `{suggestionId, candidates, failures, incomplete,
rejectedHits, requests, provenance, replacementNotes}`.
- `provenance` = `{backend, profile, release, releaseCommit, file}` captured
  when the lookup starts. `backend` is the EFFECTIVE backend: `'loc-api'`,
  `'local-db'`, or `'mixed'` (core + LOC), including the fallbacks of §2 and
  §3 (then `'loc-api'`; `profile`, `release`, `releaseCommit` and `file`
  null).
- `replacementNotes` = the §5 notes.
- `runLookupStep()` and `makeLookupResult()` carry both fields into the
  LookupResult (today the factory drops unknown fields; it is extended).
- Dedupe by cid in ranking keeps P4's choice of the surviving candidate and
  MERGES the unique `replacementFrom` entries of all duplicates into it.
- `runLookupStep()` keeps building the outcome. Candidates from completed
  parts survive a later failure: results of Q1/Q2/Q4 and of Q3a/Q3b are
  accumulated separately, so a failing later sub-query never discards
  accepted candidates.
- A failed part adds its error kind to `failures` (local parts: `local_db`,
  a new kind in `types.js` and `pipelineText.js`: "The local database could
  not answer this search").
- `requests` lists LOC URLs and local entries `local:<query>:<authority>`.
- Budget expiry → `incomplete: true` (→ `partial`/`failed` with `timeout`);
  caller cancellation commits nothing (P4 rule).
- Local RPC cancellation settles the promise at once, drops queued local
  work, and ignores late replies. A running SQL statement may finish.
- Offline with an LOC part required → that part fails → `partial` if other
  candidates exist, else `failed`. A stage legitimately skipped by the stop
  rule is not a failure.

### 6.5 Installation identity per lookup

Each lookup attempt captures the `installationIdentity` `{profile, release,
releaseCommit, file}`. Every local query carries it; the worker answers a
query for an identity that is no longer active with
`db_generation_changed` (→ a `local_db` failure for that part), never with
rows from the new file. Completed results keep their provenance.

## 7. Name MARC keys (`pipeline/nameKeys.js`)

**Scope:** effective choices (AI, exact, manual and additional picks) whose
candidate has `source: 'local-db'`, `authority: 'lcnaf'`, `marcKey: null`.

**Operation:** one name-key operation per recommendations build, with its own
revision and AbortController. It resolves the DISTINCT cids needing a key:
- Request: `buildSearchUrl('lcnaf', label, 'leftanchored')` (P4's bounded
  count) through the P4 page scheduler and the run's validated-response
  cache.
- Result per cid:
  - offline (`navigator.onLine === false`) → reason `'MARC not available
    offline'` (no request);
  - request failed → reason `'Name MARC-key lookup failed'` + the error kind;
  - validated response without a hit whose `uri` equals the candidate's
    `uri` → `'No matching name returned by this search'`;
  - several matching hits with different keys → `'Name MARC-key lookup
    failed'` (conflict; nothing chosen);
  - matching hit with no key → the existing `'no key'`;
  - otherwise the key is attached to a COPY of the candidate (`marcKey`,
    `marcKeySource: 'loc-api'`); label and identity are unchanged, and
    `buildMarc()` still checks the key's folded label against the
    candidate's label (existing P4 reasons apply).
- One 120 s deadline for the whole operation (queue waits and retries
  included).
- Commit only if the run id, the operation revision, the lookup revisions it
  depends on, and the effective choices are all still current.
- A new run, a relevant lookup retry, a changed choice or disposal aborts
  and invalidates it.
- Already resolved keys are kept (per run, by cid) and reused when
  recommendations are regenerated; every reuse goes through `buildMarc()`
  again against the CURRENT candidate copy (a changed label never inherits an
  unchecked earlier MARC result). A newly chosen unresolved name starts a new
  operation. Ordinary regeneration never loops on failed resolutions.
- "Retry name MARC keys" bypasses the run cache (fresh requests) for the
  UNRESOLVED selected cids only; resolved keys stay reused.
- A failure leaves the recommendation in place with MARC unavailable and its
  reason; the Recommendations step has "Retry name MARC keys".

## 8. UI

Settings → "Lookup source":
- "Library of Congress (online)" (default) / "Local database".
- Installed: profile, release, database size, install date; Repair,
  Uninstall; states `repair-needed`, `recovery-unavailable`, "cleanup
  pending", "open in another tab".
- Install panel: "Core — subjects and genres (download X, disk Y). Names are
  looked up online." [Download]; "Advanced" disclosure: "Full — also 12
  million names (download X, disk Y)". Values from the pointer.
- During install: progress, bytes, Cancel (disabled from the moment the
  install enters `committing`, before the commit request: "Finishing
  install…"), "Keep this tab open".
- Errors from §4 in plain words, each with "Try again".
- Update banner (§4.6).
- Matches step: the source per candidate list ("Local database (release
  X)", "Library of Congress online", or both for mixed routing);
  `via: 'variant'` → "matched a variant name"; `via: 'replacement'` →
  "replaces the old heading <label>"; unresolved replacement notes.

## 9. History and exports

- History building AND rebuilding (the allowlist) preserve each lookup
  result's complete §6.4 `provenance: {backend, profile, release,
  releaseCommit, file}` and `replacementNotes`; per candidate `source`,
  `via`, `replacementFrom`; per recommendation `marcKeySource`.
- Pre-P5 v2 entries without this metadata default to online provenance
  (`backend: 'loc-api'`, the four installation fields null) and notes `[]`.
  Legacy (v1.1.0/P3) unverified-history handling is unchanged.
- The entry-level `lookup.backend` (today hard-coded `'loc-api'` in
  `history.js`) is DERIVED from the saved results' provenance: one backend
  if all agree, else `'mixed'`. It stays separate from the model
  provenance. History never reads the current installation.
- CSV gains a `marc_reason` column (empty when MARC is available). Copy all
  already prints the reason.

## 10. Manifest, CSP, privacy

- `permissions` += `"unlimitedStorage"` (eviction protection for the
  database; it does not create disk space). No new host permissions.
- `content_security_policy.extension_pages`:
  `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"`. All JS and
  wasm are packaged; no remote script sources.
- HF requests: `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`.
- Privacy policy / Store text: "Database downloads do not include entered
  bibliographic text or headings. Hugging Face and its CDN receive ordinary
  connection metadata. With the core database, name searches use the Library
  of Congress online; with the full database, resolving chosen names' MARC
  keys also uses the Library of Congress online."

## 11. Performance targets (checked live, §13)

Native SQLite on the builder's real `full` database (lead, 2026-09-27):
Q1/Q2 0.1 ms; Q3a "john" (162,048 FTS matches) 280 ms, Q3b "john" 226 ms,
"united states" 201 ms, "history" 70 ms, "smith john" 12 ms. The wasm factor
is an ESTIMATE (2–3×); only browser measurement counts. Targets in Chrome
with `full`: Q1/Q2 < 20 ms; Q3a or Q3b < 1 s for the most common single
words; one suggestion's whole local lookup < 2 s; worker start (wasm + VFS +
open + §3.4 recovery) < 3 s; stored-byte check (§4.5 step 3) reported with
its time. A miss is reported with numbers before any design change.

## 12. Tests (vitest, Node)

Pinned: Node 24 (the repo's current), `@sqlite.org/sqlite-wasm`
3.53.4-build1 in memory (no OPFS). The lead supplies
`localdb/__fixtures__/fixture_core.db` and `fixture_full.db` (built by the
builder from its real fixtures) and a list of the builder goldens that apply
to them.
1. `sql.js` query text: pinned sha256 per query block (lead-supplied).
2. MATCH builder incl. no-token input.
3. The selected builder goldens through `localDb.js`'s query layer.
4. Mapper: deprecated/18X rejection, `via`, `replacementFrom`, notes.
5. Coordinator: the exact request/query sequence for each P4 test case in
   `loc-api` (unchanged), `local-db` full and `local-db` core; pooled stop
   decisions; stage 3 on the first routed authority; stage 4 rules; ranking
   with original indices; `partial`/`failed`; offline; `local_db` failure
   keeps earlier candidates; cancellation; generation change.
6. Pointer: every field, URL canonicalization attacks (dot segments,
   `%2F`, query, fragment, credentials, other host), sizes (safe integers),
   numeric release order.
7. Install protocol with a fake pool/importer and a fake bridge:
   first-chunk coalescing (1, 7, 15, 511-byte leading chunks), empty chunks,
   truncated gzip, over-size abort, hash/size mismatch, **short write (stream
   hashes pass, stored check fails)**, staging-name collision, one mutation
   at a time, cancel before/at/after the commit point, commit refused /
   failed / uncertain, switch and delete order (never delete an open or the
   active file), `pendingDeletes`, same-release no-op, profile switch,
   uninstall success/failure, §3.4 recovery incl. unreadable settings and a
   missing active file; `cancel` racing the commit request (refused once
   `committing`); commit answer lost → reread decides; the stored-byte reader
   against a fake VFS returning a short read, an error code, and a wrong
   `xFileSize`; batch yielding (a `status` ping answered mid-verify); worker
   replacement while a bridge commit's settings read is pending (the old
   handler fails the final fence; recovery waits for it).
8. SHA-256 wrapper: NIST vectors, random chunk boundaries, a stream longer
   than 2^32 bytes (generated, bounded memory) for length accounting.
9. Ownership client: lock unavailable → fallback state; crash → reject
   pending, one re-create, second crash → `loc-api`; bridge: stale
   `workerGeneration` refused, structural `expectedLocalDb` compare, patch
   allowlist, pending-delete add/remove on a changed snapshot, drain of an
   in-flight write before the new worker's recovery.
10. Name keys: every §7 result case, cache reuse, deadline, staleness
   (changed choice during the operation), Retry bypasses the cache for
   unresolved cids only, reused keys re-checked by `buildMarc()`.
10b. Result metadata: `provenance` and `replacementNotes` survive
   `runLookupStep` → `makeLookupResult` → history build/rebuild; merged
   `replacementFrom` on dedupe; a failing Q3b keeps Q1/Q2 candidates.
11. History/CSV: provenance round-trip, `marc_reason`, old entries.
12. Honesty (`react-dom/server`): Matches/Recommendations with `local-db`
   and mixed candidates; IDs/links only from rows; variant/replacement
   wording.
13. Live-findings tests (v2.4): immediately resolved buffered pulls with
   synchronous fake writes and hashing, an injected monotonic clock and a
   controllable macrotask scheduler — assert budget-triggered yields across
   import AND verification, and that status/cancel are served before
   completion; progress-aware watchdog expiry and stale-progress rejection
   (an old generation's progress does not count); contention retries through
   the 30 s deadline, each in a FRESH worker; the fail-fast case (request A
   rejects, request B succeeds after the failure cleanup) leaves B's handle
   released by the worker's termination and the next acquisition succeeds; drain-before-
   recovery ordering; **the removeEntry guard: a recursive removal is
   refused, a non-recursive one passes, and an init failure under contention
   leaves every pool file in place** (fake FileSystem handles). Chrome
   acceptance (§13) measures the real responsiveness.

Query-plan assertions stay in the builder's representative-data gate; the
tiny fixtures test correctness only.

## 13. Live acceptance (lead, Chrome, production package)

1. Fresh profile, no optional grants: pointer + core download work (CORS).
2. First install core; both P4 records with `local-db`; compared with
   `loc-api`.
3. Install full (the real 1.9 GB file); names offline; a chosen name's MARC
   key online; offline → "MARC not available offline"; §11 timings; memory
   stays bounded during install.
4. Full → full repair; core ↔ full switch; uninstall.
5. Injected faults (the §21 fault build): failure just before / just after the
   commit write, after the switch, at each deletion; settings-write failure;
   quota error; cancel during import and during the stored-byte check;
   repeated Install clicks; uninstall during install.
6. Close the tab at each install phase and reopen: the recorded
   installation is active and valid, no leftovers after §3.4.
7. Two app tabs; owner closes → the other tab's "Try again" takes over;
   popup launches during an install; `#settings` navigation during an
   install.
8. Corrupted download (a proxy flips one byte) → rejected, old kept.
9. Unsupported pointer → message, old kept. Update banner with a newer
   release.

## 14. Answers to the v1 open questions (from review)

1. Streaming SHA-256: pinned `@noble/hashes` behind `sha256.js`.
2. No `PRAGMA quick_check`: acceptable because the stored bytes are
   verified (§4.5 step 3) and the builder runs structural gates.
3. Offline mixed routing: `partial` with candidates, else `failed`.
4. Variant matches keep P4's classes; `via` explains them.

## 15. Round-1 extension review findings → P5

| # | Fix |
|---|---|
| 1 | §3.1 owner lock + one client per document; §4.1 one mutation at a time |
| 2 | §4.4 worker-owned fetch, pull importer, 512-byte first chunk, cancel; §4.5 commit boundary |
| 20 | §4.2 pinned, canonical URLs; §4.5 stream AND stored hashes |
| 21 | §3.4 startup recovery; §4.5 commit point; §4.7 uninstall order |
| 22 | §4.4 unique, collision-checked staging names; §4.6 identity-based no-op |
| 23 | §4.2 versions/fingerprint before download; §4.5 selected-profile + `db_meta` checks; §5 one mapper |
| 24 | §4.3 space wording; quota/IO errors keep the old DB; §10 `unlimitedStorage` |
| 27 | SCHEMA_QUERIES Q3 as is; §6.1 stage 3 |
| 28 | builder §8.6; §12 tail |
| 29 | shared NORMALIZE_V1 vectors (51) |
| 30 | §12 Node gates vs §13 Chrome gates |

## 16. P5 review round 1 → v2

| # | Fix |
|---|---|
| 1 | §4.1 one mutation + operationId; §4.4 collision-checked staging; §4.5 steps 4–9 (prepared handle, gated queries, compare-and-write commit point, no cancel after commit, switch/close/delete order); §3.1 lock order |
| 2 | §4.5 step 3 stored-byte check through `sqlite_dbpage` (probed); §12 row 7 short-write test |
| 3 | §3.4 recovery order, unreadable settings keep files, no promotion, idempotent deletes; §4.7 commit-then-delete uninstall |
| 4 | §3.1 popup never owns; one module-level client; no unload dependency; takeover; §3.3 bridge |
| 5 | §6.4 raw P4 shape; failures/partial; `local_db`; cancellation |
| 6 | §6.1 one coordinator, original routing order, pooled stage decisions, extracted LOC helper, one budget; retrieval difference documented |
| 7 | §5 mapper before counting; §6.1 stage 4 on accepted candidates; §6.2 replacement class on own label, `replacementFrom`, notes; §0/§6.1 limitations |
| 8 | §7 request via `buildSearchUrl`, distinct result reasons, exact uri match, conflicts |
| 9 | §7 operation with revision, deadline, commit conditions, invalidation, cache, Retry |
| 10 | §4.2 canonical URL, safe integers, release date; §4.5 selected profile, `lh_format`, named objects; §2 pending deletes and update-check fields; identity-based no-op |
| 11 | §6.5 per-lookup generation; §9 history build + rebuild, `marc_reason` |
| 12 | §4.2/§4.4 fetch options; §10 CSP and privacy text; §13 row 1 fresh profile |
| 13 | §12 pinned Node + package, added rows; §13 fault matrix |
| 14 | §4.3 additional vs peak space, estimate wording; §1 `webpack.common.js`; §11 factor marked as estimate |

## 17. P5 review round 2 → v2.1

| # | Fix |
|---|---|
| 1 | §4.5 step 7 `committing` state before the commit request; both files kept until resolved; uncertain → settle, reread, else `recovery-unavailable` |
| 2 | §3.3 bridge: structural `expectedLocalDb`, allowlisted patch, pending-delete add/remove on the fresh snapshot, generation/operation check under the lock, drain before recovery; `workerGeneration` vs `installationIdentity` |
| 3 | §4.5 step 3 VFS `xFileSize` + `xRead` via `SQLITE_FCNTL_FILE_POINTER` (lead-probed), plus the page-count check |
| 4 | §4.5 step 3 yields between batches, "Verifying" phase, watchdog-safe; §11/§14 step references |
| 5 | §4.8 common terminal rule; §4.7 uncertain-commit reconciliation + ungating; §3.4 `repair-needed` serves no local queries; startup compares with the installed record |
| 6 | §6.4 `provenance` + `replacementNotes` through `runLookupStep`/`makeLookupResult`/history; effective backend; `replacementFrom` merge; separate accumulation |
| 7 | §7 Retry bypasses the cache for unresolved cids; reused keys re-run `buildMarc()` |
| 8 | §5 query-contract exception; builder SPEC v3.4 §6.1 carries it |
| 9 | §4.2 URL wording (normalizing spellings allowed); release sequence safe integer |

## 18. P5 review round 3 → v2.2

| # | Fix |
|---|---|
| 1 | §3.3 step-4 fence right before the write; replacement waits for ADMITTED handlers; §12 row 7 test |
| 2 | §8 Cancel disabled on entering `committing`; §4.8 scope excludes unresolved commits; §4.5 step 7 commit point = successful write |
| 3 | §3.3 recovery `operationId`, locked `read`, page-owned update check |
| 4 | §9 full provenance + notes in history, defaults for old entries, derived entry-level backend; §6.4 null `releaseCommit` online; builder ref v3.5 |

## 19. Live findings (§13, 2026-10-01) → v2.3

Against the real release `2026.10.01.1`, fresh profile, production package:
core installed once in 11 s (download 7 s, stored-byte check 213 MB in 4 s)
and failed once ("stopped responding" after 59 s); `full` failed at 157 s
after writing 4.7 GB. Recovery after the failure removed the 4.98 GB
leftover completely on the next page open. Fixes: §4.4 step 7b (yield during
the whole install), §3.2 hang definition (progress counts as liveness, 30 s),
§3.2 replacement retry on pool contention.

## 20. Review of the live-findings amendment → v2.4

APPROVE-WITH-CHANGES, one HIGH: retrying the pinned initializer is
destructive (its failure cleanup recursively deletes the pool). §3.2 now
specifies non-destructive acquisition (the recursive-removeEntry guard, fresh
acquisitions, contention-only retries, `db_busy` on exhaustion), deadline
ordering against the §3.3 drain and recovery, current-generation-only
liveness; §4.4 step 7b a cooperative monotonic budget with backpressure and
cancellation rechecks; §4.5 the stale 10 s sentence; §12 row 13 the tests.

Confirmation of the guard (review 5): APPROVE-WITH-CHANGES, no HIGH. Folded
into v2.5: guard installed and verified before acquisition, `clearOnInit:
false`, retries in a fresh worker (the fail-fast `Promise.all` can leave a
late handle), and the matching §12 test.

## 21. Fault-injection test build (v2.6)

§13 row 5 needs faults that the UI cannot cause. v2.5 named "a test build
flag" but never defined it; this section does. It adds NO behaviour to the
shipped extension: every hook is compiled out of the production package.
(Review of the first draft: `.dispatch/spec-review-p5-6/last_message.md`;
its replacement texts are folded in below verbatim.)

**Build.** Define `__LCSH_FAULTS__` with webpack `DefinePlugin` as the boolean literal `false` in `webpack.prod.js` and `webpack.dev.js`, and as the boolean literal `true` only in `webpack.faults.js`. Each effective configuration must contain exactly one definition, with no conflicting definitions introduced by configuration merging. The fault configuration uses production mode, the production minimizer and the existing manifest/CSP, and writes only to `dist-faults/` (gitignored). The lead runs it directly; no npm script is required.

All fault-only parsing, state, messages, handlers, logging, dependency loading and hook execution must be inside compile-time `if (__LCSH_FAULTS__)` branches. Fault helper imports must not introduce unguarded initialization or side effects. The false build must preserve the existing production control flow.

Acceptance: inspect the effective production configuration for the literal false definition and enabled production minimization. Inspect all emitted production JavaScript, including worker and asynchronous chunks, for absence of fault parsing, dispatch, messages and hook execution. Search the complete package for distinctive fault markers and point names, and inspect any matches; searching only for `faults=` or a generic word such as `delete` is insufficient. Fault helper assets and source maps containing fault code must not ship. The lead also verifies that opening the production app with a fault query causes no fault behavior.

Vitest defines the constant as true for hook tests. Separate configuration checks verify the false production/development definitions and isolated fault output path. Tests with an empty plan do not substitute for production artifact inspection.

**Plan.** Only in the fault build, the app reads its own URL query once at document load: `app.html?faults=<point>[@<occurrence>]:<mode>[,...]`. The optional positive occurrence number is supported only for `delete` and defaults to 1. It selects the numbered eligible unlink attempt across this document’s worker generations. Duplicate entries for a point, unknown points, unsupported modes and invalid occurrence numbers are ignored with a warning.

Preserve the existing static `new Worker(new URL('./services/localdb/worker.js', import.meta.url), { type: 'module' })` expression. Pass fault configuration in a fault-only field of the existing first `acquire` RPC, before recovery. Do not change the worker URL, manifest, permissions or CSP.

The page owns the in-memory occurrence counters and consumed-point set. Worker hooks claim their selected occurrence through fault-only messages; the page validates the source worker and generation, records consumption, and acknowledges before the worker injects the fault. Replacement workers cannot rearm consumed points. Page-side hooks use the same document-owned state. No fault state is persisted or accepted through storage, settings, external messages or web-page messaging.

Each selected point fires at most once per document. Log `[fault] <point>:<mode>` when it fires, with the operation, worker generation and, for deletion, file name and occurrence number. Reloading creates a new plan; remove the query when reopening for a fault-free cleanup check.

**Modes.**
- `throw`: inject an ordinary `Error('[fault] <point>')` at the specified boundary, except that `import-write` uses a `DOMException` named `QuotaExceededError`. Preserve the existing catches and error mapping.
- `crash`: after the page has acknowledged consumption, call `self.close()` and suspend the invoking async operation forever with a never-settling promise. Do not throw, return normally, or execute subsequent installer cleanup, catch/finally completion, state reporting or RPC replies. This simulates silent worker loss at a JavaScript boundary, not an abrupt browser/process kill or interruption inside a synchronous write. The existing §3.2 watchdog must detect the loss and perform replacement; the hook must not invoke replacement directly.

Supported modes: `import-write`, `commit-before`, `commit-lost` and `delete` support `throw` and `crash`; `after-switch` supports only `crash`; `settings-write` supports only `throw`.

**Points.**

| Point | Exact injection boundary | Purpose |
|---|---|---|
| `import-write` | Wrap the existing coalesced pull callback passed to the real `pool.importDb`. Fire on a subsequent callback invocation after at least 64 MiB of preceding chunks have been handed to and processed by the importer, before returning another chunk. Count those preceding chunks, not compressed progress or transform/hash read-ahead. `throw` raises `DOMException('[fault] import-write', 'QuotaExceededError')` inside the existing import error boundary. | Mid-import storage failure and partial-import cleanup; this does not prove actual disk exhaustion or short-write detection. |
| `commit-before` | Inside `commitPoint`’s existing try block, immediately before invoking `bridge.commit`, after entering `committing` and gating queries. | Failure before the install or uninstall commit request. |
| `commit-lost` | Inside the same try block, immediately after `await bridge.commit(...)` returns a real successful answer, but before `commitPoint` interprets it. Fire only when `answer.ok === true`. `throw` hides that successful answer from the decision logic by throwing into the existing catch, which must perform its normal locked reread. Do not inject this error in the page bridge or convert it into an `ok:false` answer. | Successful settings write followed by loss of usable confirmation. This exercises reconciliation, not the bridge timeout itself. |
| `after-switch` | In `install`, after assigning the new active handle/record, clearing the staging locals, completing the old-handle close attempt and ungating, but before `retire(oldFile, ...)`. Crash only. | Loss after §4.5 step 8, before deletion. |
| `delete` | In the central installer `unlink`, after name/retained-handle checks, inside its existing try block immediately before `pool.unlink(name)`. Select an eligible attempt with `@<occurrence>` and log its file and operation. | Deletion failure during retirement, terminal staging cleanup, uninstall or startup recovery. |
| `settings-write` | In `commitLocalDb`, synchronously inside the existing storage-write try block after the final fence and before `storage().set(writes)`. Throw instead of issuing that write. Scope this point to patches containing `localDb`, including uninstall’s null record, so cleanup-only commits cannot consume it. Do not insert an await between the fence and a real write. | Definitively failed install/uninstall settings write through the existing `write-failed` result. |

**Expected outcomes.** Run each fault independently unless a combined-fault scenario explicitly states its expected result. Begin with readable, valid settings and either no installation or a valid recorded installation. Automatic replacement expectations assume the document’s one replacement allowance has not already been consumed. Do not require success after unrelated acquisition, storage or settings failures.

- `import-write:throw`: the real importer failure reaches the existing `InstallError('storage')` mapping. No installation commit occurs. The old installation, if any, remains unchanged; otherwise none becomes installed. Apply §4.8 cleanup. Verify the worker-side error kind separately from the existing page error presentation; this amendment does not change error messages or client error mapping.
- `commit-before:throw` and `settings-write:throw`: with a successful reconciliation read where needed, the mutation resolves as not committed. An install preserves the previous record and applies §4.8 staging cleanup. A failed uninstall preserves the record and follows §4.7’s reopen/ungate path.
- `commit-lost:throw`: a successful reread showing the intended record resolves the mutation as committed. Install continues through switch and retirement; uninstall continues with `localDb: null`, online lookup and retirement. An unreadable or unexpected reread instead follows the existing unresolved-commit path: retain files, serve no local queries and report `recovery-unavailable`.
- Worker crash: the pending operation fails through the existing client path. Replacement, when available, drains admitted settings handlers before acquisition and §3.4 recovery. Recovery uses the settings record, never promotes an orphan, and attempts deletion of non-active files. No record means no installed database. Missing/invalid recorded data, unreadable settings and acquisition failure retain their existing specified outcomes.
- `delete:throw`: deletion failure does not roll back a committed install or uninstall. Retirement leaves the file pending under the already-written record. Terminal staging cleanup records a failed deletion only on a best-effort basis; an unlisted leftover is still eligible for §3.4 cleanup. Recovery does not guarantee creation of a new pending-list entry for every discovered orphan. Preserve existing cleanup reporting.
- `delete:crash`: after replacement, the consumed fault does not fire again. Recovery may delete the file immediately, so a persistent pending entry or “Cleanup pending” message is not required.
- Cleanup succeeds when the relevant close, deletion and settings operations succeed. Otherwise preserve the files and pending information required by §3–§4 and retry on a later fault-free startup; unconditional deletion on the next start is not guaranteed.
- Throughout these scenarios, settings remain authoritative. They identify the installed file or explicitly record no installation. Uncommitted staging files may exist without pending-list entries. Hooks must never commit an unverified file, delete the recorded active file during recovery, or apply pre-commit staging cleanup to a successfully committed file.

**Tests and live coverage.** Test every supported point/mode pair at its actual call site, including one-shot consumption across worker replacement and inert behavior for an empty plan. Unsupported combinations must not execute. Assert ordering and protocol outcomes, not merely that a helper was called.

For both `commit-lost` modes, prove that the real bridge write succeeds before injection and that the committed file is not sent through terminal staging cleanup. For `commit-lost:throw`, prove that `commitPoint` performs its normal locked reread and follows the reconciliation result. For `commit-lost:crash`, prove that the crashed operation performs no reconciliation read or further completion; replacement recovery reads the authoritative settings and follows §3.4.

For `after-switch:crash`, prove the active handle has changed before the crash and retirement has not begun. For `settings-write:throw`, prove that the targeted install/uninstall storage write is not issued and the existing bridge returns `write-failed`; subsequent cleanup-only settings writes remain governed by the existing protocol.

For both `import-write` modes, prove that the real importer has processed at least 64 MiB of preceding chunks before injection. For `import-write:throw`, prove that the importer’s existing failure cleanup runs, the error reaches `InstallError('storage')`, and the installer applies §4.8. For `import-write:crash`, prove that the suspended importer and invoking install perform no subsequent catch/finally cleanup or completion; replacement handles recovery through the existing acquisition and §3.4 paths.

For every crash hook, prove that the invoking operation sends no completion reply and performs no subsequent cleanup before replacement. The existing watchdog must trigger replacement; the hook must not invoke it directly.

The lead exercises deletion separately during old-file retirement, failed/cancelled staging cleanup, uninstall and startup recovery, including later recovery-loop occurrences selected with `delete@N`. Each run records the targeted file and operation.

Complete the remaining §13 row 5 interactions through existing controls and APIs: cancel during import; cancel during stored-byte verification; repeated Install attempts; and uninstall attempts during an install. Verify UI prevention and the existing client/worker mutation refusal separately. Do not add artificial delays, enable disabled controls, alter cancellation boundaries or change mutation arbitration to make these checks possible.

Row 5 uses the isolated fault package. Other §13 rows retain their production-package requirement. Fault-build results do not substitute for production acceptance.
