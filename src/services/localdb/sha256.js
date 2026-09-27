/**
 * A narrow wrapper over the pinned `@noble/hashes` incremental SHA-256
 * (SPEC-P5 §14.1). It exists so the streaming hashes of §4.4 and the
 * stored-byte hash of §4.5 step 3 use ONE implementation with one output
 * form (lowercase hex), and so the dependency is pinned in one place.
 *
 * `crypto.subtle.digest` is not usable here: it has no incremental form, and
 * the database can be gigabytes.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Lowercase hex of a byte array.
 * @param {Uint8Array} bytes - Digest bytes
 * @returns {string}
 */
export const toHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
};

/**
 * An incremental SHA-256. `update` accepts any number of chunks of any size
 * (empty chunks included) and counts the bytes; `digest` closes the hash and
 * may be called only once.
 * @returns {{update:(chunk:Uint8Array)=>void, bytes:()=>number, digest:()=>string}}
 */
export const createSha256 = () => {
  const hash = nobleSha256.create();
  let bytes = 0;
  let closed = false;
  return {
    update(chunk) {
      if (closed) throw new Error('SHA-256 already closed');
      if (!(chunk instanceof Uint8Array)) throw new Error('SHA-256 needs a Uint8Array');
      if (chunk.length === 0) return;
      hash.update(chunk);
      bytes += chunk.length;
    },
    /** Bytes fed so far (a Number; exact well past 2^32, up to 2^53). */
    bytes: () => bytes,
    digest() {
      if (closed) throw new Error('SHA-256 already closed');
      closed = true;
      return toHex(hash.digest());
    }
  };
};

/**
 * SHA-256 of one byte array, as lowercase hex.
 * @param {Uint8Array} bytes - Input
 * @returns {string}
 */
export const sha256Hex = (bytes) => toHex(nobleSha256(bytes));

export default createSha256;
