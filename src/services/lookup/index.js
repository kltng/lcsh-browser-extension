/**
 * Lookup backends behind one interface (SPEC-P4 §0 goal 2). P4 has one
 * backend, the LOC API; P5 adds the local database here.
 */
import { createLocApiBackend, BACKEND_ID as LOC_API } from './locApi';

export { LOC_API };

/**
 * The lookup backend chosen in the settings. A new backend (and so a new
 * per-run cache) is created for every run.
 * @param {{lookupBackend?:string}} [settings] - Merged settings
 * @param {{scheduler?:object, cache?:object}} [deps] - Scheduler and run cache overrides
 * @returns {{id:string, lookup:Function, cache:object}}
 */
export const getLookupBackend = (settings = {}, deps = {}) => {
  const id = settings?.lookupBackend || LOC_API;
  if (id === LOC_API) return createLocApiBackend(deps);
  throw new Error(`Unknown lookup backend: ${id}`);
};

export default getLookupBackend;
