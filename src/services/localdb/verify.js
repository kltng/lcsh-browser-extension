/**
 * Verification of an imported database (SPEC-P5 §4.5 steps 2–6), split out of
 * install.js so the stored-byte reader can be tested on its own.
 *
 * HOUSE_RULES 15: the stream hashes of §4.4 prove the stream, not the stored
 * copy. The SAH-pool importer ignores short writes, so the bytes that will
 * later be READ are hashed again here, through the VFS — which hides the
 * pool's own file header and returns the real bytes of every page.
 */
import { createSha256 } from './sha256';

export const SQLITE_OK = 0;
export const SQLITE_IOERR_SHORT_READ = 522;
/** One reusable read buffer; §4.5 step 3 allows at most 8 MiB. */
export const READ_BUFFER_BYTES = 8 * 1024 * 1024;

/** The application objects `sqlite_master` must hold, by name (§4.5 step 6). */
export const REQUIRED_OBJECTS = ['db_meta', 'auth', 'alt_label', 'hierarchy', 'auth_fts', 'alt_label_fts'];
/** FTS5 shadow tables of the two virtual tables; they are allowed, nothing else is. */
export const ALLOWED_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

const KINDS = {
  damaged: 'The download was damaged; nothing was changed.',
  io: 'The local database could not be read.',
  busy: 'The local database is in use. Close the other tab and try again.',
  cancelled: 'Cancelled.'
};

/** A verification failure. Local text only; no library or response text is kept. */
export class VerifyError extends Error {
  /**
   * @param {'damaged'|'io'|'busy'|'cancelled'} kind - Failure kind
   * @param {string} detail - A short local reason, for the log (never a library message)
   */
  constructor(kind, detail = '') {
    super(KINDS[kind] || KINDS.damaged);
    this.name = 'VerifyError';
    this.kind = KINDS[kind] ? kind : 'damaged';
    this.detail = detail;
  }
}

/** `SQLITE_FCNTL_FILE_POINTER`; the constant is also on `capi` in the pinned build. */
export const FCNTL_FILE_POINTER = 7;
/** Byte offsets of `xRead` and `xFileSize` in `sqlite3_io_methods` on wasm32 (lead probe, 2026-09-27). */
export const IO_METHOD_OFFSETS = { xRead: 8, xFileSize: 24 };

/**
 * The `sqlite3_file` methods of an OPEN database, reached through
 * `sqlite3_file_control(db, 'main', SQLITE_FCNTL_FILE_POINTER, …)`. Reading
 * this way goes through the VFS, so the SAH pool's own file header stays
 * hidden and every page's real bytes are read (unlike `sqlite_dbpage`, which
 * synthesizes zeros for the lock-byte page).
 * @param {object} sqlite3 - The initialized sqlite3 module
 * @param {number} dbPointer - `sqlite3*` of the open database
 * @returns {{fileSize:()=>number, read:(buffer:Uint8Array, offset:number, length:number)=>number, dispose:()=>void}}
 */
export const createFilePointerVfs = (sqlite3, dbPointer) => {
  const { capi, wasm } = sqlite3;
  const fcntl = capi.SQLITE_FCNTL_FILE_POINTER ?? FCNTL_FILE_POINTER;
  const pOut = wasm.alloc(8);
  let pFile = 0;
  try {
    const rc = capi.sqlite3_file_control(dbPointer, 'main', fcntl, pOut);
    if (rc !== SQLITE_OK) throw new VerifyError('io', `file-control-${rc}`);
    pFile = wasm.peekPtr(pOut);
  } finally {
    wasm.dealloc(pOut);
  }
  if (!pFile) throw new VerifyError('io', 'no-file-pointer');
  const pMethods = wasm.peekPtr(pFile);
  const xRead = wasm.functionEntry(wasm.peekPtr(pMethods + IO_METHOD_OFFSETS.xRead));
  const xFileSize = wasm.functionEntry(wasm.peekPtr(pMethods + IO_METHOD_OFFSETS.xFileSize));
  if (typeof xRead !== 'function' || typeof xFileSize !== 'function') throw new VerifyError('io', 'no-io-methods');

  // ONE reusable wasm buffer for the whole check.
  let pBuf = 0;
  let bufBytes = 0;
  return {
    fileSize() {
      const pSize = wasm.alloc(8);
      try {
        const rc = xFileSize(pFile, pSize);
        if (rc !== SQLITE_OK) throw new VerifyError('io', `file-size-${rc}`);
        return Number(wasm.peek(pSize, 'i64'));
      } finally {
        wasm.dealloc(pSize);
      }
    },
    read(buffer, offset, length) {
      if (length > bufBytes) {
        if (pBuf) wasm.dealloc(pBuf);
        pBuf = wasm.alloc(length);
        bufBytes = length;
      }
      const rc = xRead(pFile, pBuf, length, BigInt(offset));
      if (rc === SQLITE_OK) buffer.set(wasm.heap8u().subarray(pBuf, pBuf + length));
      return rc;
    },
    dispose() {
      if (pBuf) wasm.dealloc(pBuf);
      pBuf = 0;
      bufBytes = 0;
    }
  };
};

/**
 * Hash the bytes the database actually stores, through the VFS (§4.5 step 3).
 * `xFileSize` must equal `size`; then `[0, size)` is read sequentially with
 * ONE reusable buffer, and every result other than `SQLITE_OK` — including
 * `SQLITE_IOERR_SHORT_READ` — is a failure.
 * @param {{fileSize:()=>number|Promise<number>, read:(buffer:Uint8Array, offset:number, length:number)=>number|Promise<number>}} vfs -
 *   The staging file's `sqlite3_file` methods
 * @param {{size:number, bufferBytes?:number, onBatch?:(read:number, size:number)=>any}} args -
 *   Expected size, buffer size, and the per-batch hook (the worker yields and handles `cancel`/`status` there)
 * @returns {Promise<string>} - The SHA-256 of the stored bytes, lowercase hex
 */
export const hashStoredBytes = async (vfs, { size, bufferBytes = READ_BUFFER_BYTES, onBatch }) => {
  if (!Number.isSafeInteger(size) || size <= 0) throw new VerifyError('damaged', 'size');
  const actual = await vfs.fileSize();
  if (actual !== size) throw new VerifyError('damaged', 'file-size');
  const buffer = new Uint8Array(Math.min(bufferBytes, size));
  const hash = createSha256();
  let at = 0;
  while (at < size) {
    const length = Math.min(buffer.length, size - at);
    const view = length === buffer.length ? buffer : buffer.subarray(0, length);
    const rc = await vfs.read(view, at, length);
    if (rc !== SQLITE_OK) throw new VerifyError('damaged', `read-rc-${rc}`);
    hash.update(view);
    at += length;
    if (onBatch) await onBatch(at, size);
  }
  return hash.digest();
};

/**
 * `db_meta` must describe the SELECTED profile and this format (§4.5 step 5).
 * @param {Object<string,string>} meta - `db_meta` as key → value
 * @param {{profile:string, compatFingerprint:string}} expected - The selected profile and the pointer's fingerprint
 * @returns {void}
 */
export const checkMeta = (meta, { profile, compatFingerprint }) => {
  const want = {
    profile,
    schema_version: '2',
    normalize_version: 'NORMALIZE_V1',
    lh_format: 'LH1',
    compat_fingerprint: compatFingerprint
  };
  for (const [key, value] of Object.entries(want)) {
    if (meta?.[key] !== value) throw new VerifyError('damaged', `db_meta.${key}`);
  }
};

const isAllowedShadow = (name) => ['auth_fts', 'alt_label_fts']
  .some((fts) => ALLOWED_SHADOW_SUFFIXES.some((suffix) => name === `${fts}${suffix}`));

/**
 * `sqlite_master` must hold exactly the §4.5 step 6 application objects by
 * name. FTS shadow tables and indexes are allowed; anything else is not.
 * @param {Array<{name:string, type:string}>} objects - Rows of `sqlite_master`
 * @returns {void}
 */
export const checkObjects = (objects) => {
  const names = (objects || []).map((o) => o.name);
  for (const required of REQUIRED_OBJECTS) {
    if (!names.includes(required)) throw new VerifyError('damaged', `missing:${required}`);
  }
  for (const object of objects) {
    if (REQUIRED_OBJECTS.includes(object.name)) continue;
    if (object.type === 'index') continue;
    if (object.name.startsWith('sqlite_')) continue;
    if (isAllowedShadow(object.name)) continue;
    throw new VerifyError('damaged', 'unexpected-object');
  }
};

/**
 * `page_count × page_size` must equal the pointer's `db_size` (§4.5 step 3).
 * @param {{pageSize:number, pageCount:number}} pages - The two pragmas
 * @param {number} dbSize - Expected size in bytes
 * @returns {void}
 */
export const checkPageProduct = ({ pageSize, pageCount }, dbSize) => {
  if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(pageCount)) throw new VerifyError('damaged', 'pragma');
  if (pageSize * pageCount !== dbSize) throw new VerifyError('damaged', 'page-product');
};

/**
 * The cheap start-up validation of the recorded active file (§3.4 step 3):
 * the INSTALLED RECORD, never the pointer. The full hash was checked at
 * install and is not repeated at every start.
 * @param {{meta:Object<string,string>, objects:Array<object>, pages:{pageSize:number, pageCount:number}}} state - What the handle reports
 * @param {{profile:string, compatFingerprint:string, dbSize:number}} record - The installed record
 * @returns {void}
 */
export const checkAgainstRecord = (state, record) => {
  checkMeta(state.meta, { profile: record.profile, compatFingerprint: record.compatFingerprint });
  checkObjects(state.objects);
  checkPageProduct(state.pages, record.dbSize);
};

export default hashStoredBytes;
