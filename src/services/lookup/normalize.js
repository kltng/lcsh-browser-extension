/**
 * Identity normalization NORMALIZE_V1 (SPEC-P4 §2.1). Used for dedupe and for
 * every match class. The P5 database builder must produce the same output;
 * the vectors live in __fixtures__/normalize_vectors.json.
 */

export const NORMALIZE_VERSION = 'NORMALIZE_V1';

// The regular expressions are built from code point numbers, so the source
// holds no invisible or line-breaking characters.
const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
const range = (a, b) => (b ? `${hex(a)}-${hex(b)}` : hex(a));

/** The §2.1 step-3 whitespace set, as a regex character-class body. */
export const WHITESPACE_CLASS = [
  [0x0009, 0x000d], [0x0020], [0x00a0], [0x1680], [0x2000, 0x200a], [0x2028], [0x2029], [0x202f], [0x205f], [0x3000]
].map(([a, b]) => range(a, b)).join('');

/** One run of §2.1 whitespace (also used by searchText.js). */
export const WHITESPACE_RUN = new RegExp(`[${WHITESPACE_CLASS}]+`, 'g');

/** An en dash or an em dash. */
export const DASH_CLASS = `${hex(0x2013)}${hex(0x2014)}`;

const DASH_SPACED = new RegExp(` *[${DASH_CLASS}] *`, 'g');
const DOUBLE_HYPHEN_SPACED = / *-- */g;

const trimSpaces = (s) => s.replace(/^ +| +$/g, '');

/**
 * Normalize a heading label for identity comparison.
 * @param {string} s - A heading or label
 * @returns {string}
 */
export const normalizeLabel = (s) => {
  let t = String(s ?? '').normalize('NFC');
  t = t.toLowerCase();
  t = t.replace(WHITESPACE_RUN, ' ');
  t = t.replace(DASH_SPACED, '--').replace(DOUBLE_HYPHEN_SPACED, '--');
  t = trimSpaces(t);
  t = trimSpaces(t.replace(/\.+$/, ''));
  return t;
};

export default normalizeLabel;
