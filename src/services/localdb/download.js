/**
 * The download half of the install protocol (SPEC-P5 §4.4 and §4.5 step 1):
 * fetch, count and hash the compressed bytes, decompress, count and hash the
 * decompressed bytes, and hand them to the SAH-pool importer through a `pull`
 * function. Split out of install.js so the commit protocol stays readable.
 *
 * Nothing here is committed anywhere: on any failure the caller applies the
 * §4.8 terminal rule.
 */
import { createSha256 } from './sha256';

/** Progress events are throttled to this interval (§4.4 step 7). */
export const PROGRESS_INTERVAL_MS = 500;
/** No bytes for this long → `network_stalled` (§4.4 step 8). */
export const STALL_TIMEOUT_MS = 60000;
/** The first chunk handed to the importer is at least this big (§4.4 step 6). */
export const MIN_FIRST_CHUNK = 512;

const MESSAGES = {
  busy: 'Another database operation is running',
  finishing: 'Finishing install',
  damaged: 'The download was damaged; nothing was changed.',
  network: 'The download could not be completed. Check your connection.',
  network_stalled: 'The download stopped. Check your connection.',
  storage: 'The database could not be stored. Free some disk space and try again.',
  settings: 'The settings could not be saved; nothing was changed.',
  settings_invalid: 'Local database settings could not be read',
  cancelled: 'Cancelled.'
};

/** An install failure with local text only (HOUSE_RULES 6). */
export class InstallError extends Error {
  /** @param {string} kind - Failure kind */
  constructor(kind) {
    super(MESSAGES[kind] || MESSAGES.damaged);
    this.name = 'InstallError';
    this.kind = MESSAGES[kind] ? kind : 'damaged';
  }
}

/**
 * Coalesce the leading chunks so the FIRST chunk handed to the importer is at
 * least 512 bytes (§4.4 step 6), and drop empty chunks.
 * @param {()=>Promise<Uint8Array|undefined>} next - The raw chunk source
 * @param {number} [minFirst] - Minimum size of the first chunk
 * @returns {()=>Promise<Uint8Array|undefined>}
 */
export const coalescingPull = (next, minFirst = MIN_FIRST_CHUNK) => {
  let first = true;
  return async () => {
    if (!first) {
      let chunk = await next();
      while (chunk && chunk.length === 0) chunk = await next();
      return chunk;
    }
    first = false;
    const parts = [];
    let total = 0;
    while (total < minFirst) {
      const chunk = await next();
      if (!chunk) break;
      if (chunk.length === 0) continue;
      parts.push(chunk);
      total += chunk.length;
    }
    if (total === 0) return undefined;
    if (parts.length === 1) return parts[0];
    const merged = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      merged.set(part, at);
      at += part.length;
    }
    return merged;
  };
};

/** A stream that counts and hashes, and aborts as soon as it exceeds its limit. */
const meteredStream = (hash, limit) => new TransformStream({
  transform(chunk, controller) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (bytes.length > 0) {
      hash.update(bytes);
      if (hash.bytes() > limit) throw new InstallError('damaged');
    }
    controller.enqueue(bytes);
  }
});

/**
 * Stream one profile into a staging file and verify the STREAM (§4.5 step 1).
 * The stored bytes are verified separately, by verify.js.
 * @param {{entry:object, staging:string, pool:object, controller:AbortController,
 *   isCancelled:()=>boolean, fetchImpl:Function, decompressionStream:Function, stallMs:number,
 *   now:()=>number, onProgress:(event:object)=>void}} args - The download and its environment
 * @returns {Promise<void>}
 */
export const streamDatabase = async ({
  entry, staging, pool, controller, isCancelled, fetchImpl, decompressionStream, stallMs, now, onProgress
}) => {
  // Review finding 10: the inactivity deadline starts BEFORE the fetch, so a
  // request whose headers never arrive stops the install as well; it is reset
  // only by bytes that actually arrived.
  let lastByteAt = now();
  let reader = null;

  /**
   * Race one step against the inactivity deadline. The timer is always
   * released, whichever side wins.
   */
  const race = async (promise) => {
    let timer = null;
    const stalled = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new InstallError('network_stalled'));
      }, Math.max(0, stallMs - (now() - lastByteAt)));
    });
    stalled.catch(() => {});
    try {
      return await Promise.race([promise, stalled]);
    } finally {
      clearTimeout(timer);
    }
  };

  const failure = (err) => {
    if (err instanceof InstallError) return err;
    if (isCancelled()) return new InstallError('cancelled');
    return new InstallError(controller.signal.aborted ? 'network_stalled' : 'network');
  };

  try {
    if (isCancelled()) throw new InstallError('cancelled');
    let res;
    try {
      res = await race(fetchImpl(entry.url, {
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal
      }));
    } catch (err) {
      throw failure(err);
    }
    if (res.status !== 200) throw new InstallError('network');

    const gzHash = createSha256();
    const dbHash = createSha256();
    reader = res.body
      .pipeThrough(meteredStream(gzHash, entry.gzSize))
      .pipeThrough(decompressionStream())
      .pipeThrough(meteredStream(dbHash, entry.dbSize))
      .getReader();

    let lastProgress = 0;
    const report = () => onProgress({ phase: 'downloading', done: gzHash.bytes(), total: entry.gzSize });

    const next = async () => {
      if (isCancelled()) throw new InstallError('cancelled');
      let step;
      try {
        step = await race(reader.read());
      } catch (err) {
        throw failure(err);
      }
      if (step.done) return undefined;
      lastByteAt = now();
      if (now() - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now();
        report();
      }
      return step.value;
    };

    try {
      await pool.importDb(staging, coalescingPull(next));
    } catch (err) {
      if (err instanceof InstallError) throw err;
      throw new InstallError('storage');
    }
    report();
    if (gzHash.bytes() !== entry.gzSize || dbHash.bytes() !== entry.dbSize) throw new InstallError('damaged');
    if (gzHash.digest() !== entry.sha256Gz || dbHash.digest() !== entry.sha256Db) throw new InstallError('damaged');
  } finally {
    // The reader and the fetch are released on success, failure AND cancel
    // (HOUSE_RULES 12).
    if (reader) {
      await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch (e) {
        // Already released by cancel().
      }
    }
  }
};

export default streamDatabase;
