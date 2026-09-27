/**
 * Validation of the stored local-database settings (SPEC-P5 §2, §3.4 step 2).
 *
 * Review finding 1 (HIGH): recovery used to treat an unreadable *record* the
 * same as a damaged *database*, and then ran the §3.4 step 4 cleanup. With a
 * record like `{}` no filename was protected, so every pool file — including
 * the installed database — was deleted. §3.4 is explicit: a read OR validation
 * failure keeps ALL pool files.
 *
 * So the complete snapshot is validated BEFORE anything is opened or deleted,
 * and every name that reaches `unlink()` is a canonical pool filename. No
 * heavy imports here: `settings.js` is loaded by the popup too.
 */

export const PROFILES = ['core', 'full'];

/**
 * A canonical SAH-pool filename: one leading slash, then a plain name. This is
 * the exact spelling the pool reports and the cleanup compares, so a name that
 * SQLite would normalize differently (`//x`, `/a/../b`, `/./x`) is rejected
 * rather than silently opened under one name and compared under another.
 * @param {any} name - Candidate file name
 * @returns {boolean}
 */
export const isPoolFileName = (name) => typeof name === 'string'
  && /^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  && !name.includes('..');

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

/**
 * Whether a value is a COMPLETE installed record (§2). Every field must be
 * present and of the right type; a partial record is not "damaged database",
 * it is unreadable settings.
 * @param {any} record - Stored `localDb`
 * @returns {boolean}
 */
export const isValidRecord = (record) => Boolean(record)
  && typeof record === 'object' && !Array.isArray(record)
  && PROFILES.includes(record.profile)
  && isNonEmptyString(record.release)
  && typeof record.releaseCommit === 'string' && HEX40.test(record.releaseCommit)
  && isPoolFileName(record.file)
  && Number.isSafeInteger(record.dbSize) && record.dbSize > 0
  && typeof record.sha256Db === 'string' && HEX64.test(record.sha256Db)
  && isNonEmptyString(record.compatFingerprint)
  && isNonEmptyString(record.installedAt);

/**
 * Validate the whole `{lookupBackend, localDb, localDbPendingDeletes}` snapshot.
 * @param {any} snapshot - What the bridge `read` returned
 * @returns {{valid:boolean, reason:string|null}}
 */
export const validateLocalDbSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { valid: false, reason: 'snapshot' };
  const record = snapshot.localDb ?? null;
  if (record !== null && !isValidRecord(record)) return { valid: false, reason: 'record' };
  const pending = snapshot.localDbPendingDeletes;
  if (!Array.isArray(pending)) return { valid: false, reason: 'pending' };
  if (!pending.every(isPoolFileName)) return { valid: false, reason: 'pending-name' };
  // A file cannot be the installed database and a pending deletion at once.
  if (record && pending.includes(record.file)) return { valid: false, reason: 'pending-active' };
  return { valid: true, reason: null };
};

export default validateLocalDbSnapshot;
