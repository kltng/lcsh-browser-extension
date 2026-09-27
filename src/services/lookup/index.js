/**
 * Lookup backends behind one interface (SPEC-P4 §0 goal 2). P5 adds the local
 * database: ONE coordinator serves `loc-api`, `local-db` and mixed routing
 * (SPEC-P5 §6.1). A `local-db` setting that cannot be served right now falls
 * back to `loc-api` WITH a visible notice (SPEC-P5 §2, §3) — never silently.
 */
import { BACKEND_ID as LOC_API } from './locApi';
import { createCoordinator, LOCAL_DB } from './coordinator';

export { LOC_API, LOCAL_DB };

/** Why this tab is using the Library of Congress online although `local-db` is selected (§2, §3). */
export const FALLBACK_NOTICES = {
  'not-installed': 'Local database not installed; using the Library of Congress online.',
  'other-tab': 'The local database is open in another tab of this extension; using the Library of Congress online.',
  'repair-needed': 'The local database is damaged or missing; using the Library of Congress online.',
  'recovery-unavailable': 'Local database settings could not be read; using the Library of Congress online.',
  'worker-failed': 'The local database could not be started in this tab; using the Library of Congress online.'
};

/**
 * Whether this document may answer lookups from the local database at all.
 * The IDENTITY is NOT frozen here: the coordinator reads it fresh at every
 * lookup attempt (SPEC-P5 §6.5, review finding 8).
 * @param {{lookupBackend?:string, localDb?:object|null}} settings - Merged settings
 * @param {{state:()=>string, installation:()=>object|null}|null} client - The local database client of this document
 * @returns {boolean}
 */
export const usesLocalDb = (settings, client) => {
  if (settings?.lookupBackend !== LOCAL_DB) return false;
  if (!settings?.localDb || typeof settings.localDb.profile !== 'string') return false;
  return Boolean(client) && client.state() === 'ready';
};

/**
 * The notice to show when `local-db` is selected but this tab uses LOC anyway,
 * or null when nothing has to be said.
 * @param {{lookupBackend?:string, localDb?:object|null}} settings - Merged settings
 * @param {{state:()=>string}|null} client - The local database client of this document
 * @returns {string|null}
 */
export const fallbackNotice = (settings, client) => {
  if (settings?.lookupBackend !== LOCAL_DB) return null;
  if (!settings?.localDb) return FALLBACK_NOTICES['not-installed'];
  const state = client ? client.state() : 'other-tab';
  if (state === 'ready') return null;
  return FALLBACK_NOTICES[state] || FALLBACK_NOTICES['worker-failed'];
};

/**
 * The lookup backend chosen in the settings. A new backend (and so a new
 * per-run cache) is created for every run.
 * @param {{lookupBackend?:string, localDb?:object|null}} [settings] - Merged settings
 * @param {{scheduler?:object, cache?:object, client?:object|null}} [deps] - Scheduler, run cache and local client
 * @returns {{id:string, lookup:Function, cache:object}}
 */
export const getLookupBackend = (settings = {}, deps = {}) => {
  const { client = null, ...rest } = deps;
  const id = settings?.lookupBackend || LOC_API;
  if (id !== LOC_API && id !== LOCAL_DB) throw new Error(`Unknown lookup backend: ${id}`);
  if (!usesLocalDb(settings, client)) return createCoordinator(rest);
  return createCoordinator({
    ...rest,
    local: {
      // Read fresh per lookup attempt, never frozen at backend creation.
      installation: () => client.installation(),
      query: (name, args) => client.query(name, args)
    }
  });
};

export default getLookupBackend;
