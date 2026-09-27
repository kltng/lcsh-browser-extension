import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createSha256, sha256Hex, toHex } from '../sha256';

const enc = (s) => new TextEncoder().encode(s);

/** The three classic NIST/FIPS-180 sample vectors, plus the empty string. */
const NIST_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1']
];

describe('[P5 row8] the SHA-256 wrapper', () => {
  it('matches the NIST vectors, in one piece and byte by byte', () => {
    for (const [text, expected] of NIST_VECTORS) {
      expect(sha256Hex(enc(text))).toBe(expected);
      const h = createSha256();
      for (const byte of enc(text)) h.update(Uint8Array.of(byte));
      expect(h.digest()).toBe(expected);
    }
  });

  it('a million "a" (the FIPS long vector)', () => {
    const h = createSha256();
    const chunk = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) h.update(chunk);
    expect(h.bytes()).toBe(1000000);
    expect(h.digest()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('random chunk boundaries and empty chunks give the same digest as one buffer', () => {
    let seed = 20260927;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const data = new Uint8Array(100000);
    for (let i = 0; i < data.length; i++) data[i] = rand(256);
    const expected = createHash('sha256').update(data).digest('hex');
    for (let attempt = 0; attempt < 20; attempt++) {
      const h = createSha256();
      let at = 0;
      while (at < data.length) {
        if (rand(4) === 0) h.update(new Uint8Array(0));
        const size = Math.min(rand(9000) + 1, data.length - at);
        h.update(data.subarray(at, at + size));
        at += size;
      }
      expect(h.bytes()).toBe(data.length);
      expect(h.digest()).toBe(expected);
    }
    expect(sha256Hex(data)).toBe(expected);
  });

  it('refuses anything that is not a Uint8Array, and refuses reuse after digest', () => {
    const h = createSha256();
    expect(() => h.update('abc')).toThrow();
    expect(() => h.update([1, 2, 3])).toThrow();
    h.digest();
    expect(() => h.update(enc('x'))).toThrow();
    expect(() => h.digest()).toThrow();
  });

  it('toHex is lowercase and zero-padded', () => {
    expect(toHex(Uint8Array.of(0, 1, 15, 16, 171, 255))).toBe('00010f10abff');
  });

  // §12 row 8: the length field of SHA-256 is 64 bits. A stream longer than
  // 2^32 bytes must not wrap it. The data is generated, never held in memory.
  it('accounts the length of a stream longer than 2^32 bytes', { timeout: 300000 }, () => {
    const TOTAL = 2 ** 32 + 64;
    const chunk = new Uint8Array(8 * 1024 * 1024); // all zero bytes
    const h = createSha256();
    const node = createHash('sha256');
    let left = TOTAL;
    while (left > 0) {
      const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
      h.update(piece);
      node.update(piece);
      left -= piece.length;
    }
    expect(h.bytes()).toBe(TOTAL);
    expect(h.digest()).toBe(node.digest('hex'));
  });
});
