/**
 * Search-input normalization (SPEC-P4 §4.1): the `full` and `main` search
 * strings of a suggested heading.
 */
import { WHITESPACE_RUN, DASH_CLASS } from './normalize';

const DASH_SPACED = new RegExp(`\\s*[${DASH_CLASS}]\\s*`, 'g');

const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Whether a string contains at least one Unicode letter or number.
 * @param {string} s - Text
 * @returns {boolean}
 */
export const hasLetterOrNumber = (s) => HAS_LETTER_OR_NUMBER.test(String(s ?? ''));

/**
 * The search strings of a heading, or null when the heading must not be
 * searched (empty, punctuation-only, or an empty `--` component). A null
 * result means the suggestion is `no-results` with no requests.
 * @param {string} heading - Suggested heading
 * @returns {{full:string, main:string, components:string[]}|null}
 */
export const toSearch = (heading) => {
  let s = String(heading ?? '').normalize('NFC');
  s = s.replace(WHITESPACE_RUN, ' ');
  s = s.replace(DASH_SPACED, '--').replace(/\s*--\s*/g, '--');
  s = s.trim().replace(/\.+$/, '').trim();
  if (!s || !hasLetterOrNumber(s)) return null;
  const components = s.split('--').map((part) => part.trim());
  if (components.some((part) => part === '')) return null;
  return { full: s, main: components[0], components };
};

/**
 * Keyword-search text: `--` replaced by a space.
 * @param {string} x - A `full` or `main` string
 * @returns {string}
 */
export const keywordText = (x) => x.replace(/--/g, ' ');

export default toSearch;
