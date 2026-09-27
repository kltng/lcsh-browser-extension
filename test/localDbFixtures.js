/**
 * Node test harness for the local database (SPEC-P5 §12): the lead-supplied
 * fixture databases opened IN MEMORY with the pinned `@sqlite.org/sqlite-wasm`
 * (no OPFS, no SAH pool), behind the same named-query contract the worker
 * exposes through its `query` RPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { buildQuery } from '../src/services/localdb/sql';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, '..', 'src', 'services', 'localdb', '__fixtures__');

/**
 * The bytes of a fixture database.
 * @param {'core'|'full'} profile - Profile
 * @returns {Uint8Array}
 */
export const fixtureBytes = (profile) => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, `fixture_${profile}.db`)));

let modulePromise = null;
const sqlite = () => {
  if (!modulePromise) modulePromise = sqlite3InitModule({ print: () => {}, printErr: () => {} });
  return modulePromise;
};

/**
 * Open a database from bytes, in memory.
 * @param {Uint8Array} bytes - The database file
 * @returns {Promise<object>} - An oo1 DB
 */
export const openBytes = async (bytes) => {
  const sqlite3 = await sqlite();
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer, 'main', pointer, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc !== 0) throw new Error(`sqlite3_deserialize failed: ${rc}`);
  return db;
};

/**
 * Open a fixture profile behind the named-query contract.
 * @param {'core'|'full'} profile - Profile
 * @returns {Promise<{profile:string, db:object, query:Function, close:Function, rows:Function}>}
 */
export const openFixture = async (profile) => {
  const db = await openBytes(fixtureBytes(profile));
  const rows = (sql, bind) => db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' })
    .map((row) => ({ ...row }));
  return {
    profile,
    db,
    rows,
    /**
     * Run one NAMED query (never raw SQL), exactly as the worker does.
     * @param {string} name - Q1 | Q2 | Q3a | Q3b | Q4 | Q5
     * @param {object} args - Bound values
     * @returns {Promise<object[]>}
     */
    query: async (name, args) => {
      const { sql, params } = buildQuery(name, args);
      return rows(sql, params);
    },
    close: () => db.close()
  };
};

/**
 * The comparable form of a row for the builder goldens: authority, uri, label,
 * deprecated and marc_key, in the query's order.
 * @param {object[]} list - Query rows
 * @returns {object[]}
 */
export const goldenShape = (list) => list.map((r) => ({
  authority: r.authority, uri: r.uri, label: r.label, deprecated: r.deprecated, marc_key: r.marc_key ?? null
}));
