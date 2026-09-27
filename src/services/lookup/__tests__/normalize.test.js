import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeLabel, NORMALIZE_VERSION } from '../normalize';

const vectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../__fixtures__/normalize_vectors.json'), 'utf8'));

describe('[P4 row1] normalize: NORMALIZE_V1 vectors', () => {
  it('the fixture is NORMALIZE_V1 with at least 40 cases', () => {
    expect(vectors.version).toBe(NORMALIZE_VERSION);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(40);
  });

  it.each(vectors.cases.map((c, i) => [i, c.input, c.expected]))('case %i: %j', (_, input, expected) => {
    expect(normalizeLabel(input)).toBe(expected);
  });

  it('every §2.1 whitespace character collapses to one space; others are kept', () => {
    const set = [0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const cp of set) expect(normalizeLabel(`a${String.fromCodePoint(cp)}${String.fromCodePoint(cp)}b`)).toBe('a b');
    // U+200B (zero width space) and U+FEFF are not in the set.
    expect(normalizeLabel(`a${String.fromCodePoint(0x200b)}b`)).toBe(`a${String.fromCodePoint(0x200b)}b`);
    expect(normalizeLabel(`${String.fromCodePoint(0xfeff)}a`)).toBe(`${String.fromCodePoint(0xfeff)}a`);
  });

  it('NFC first: a decomposed é equals the composed one', () => {
    expect(normalizeLabel('Québec')).toBe(normalizeLabel('Québec'));
  });
});
