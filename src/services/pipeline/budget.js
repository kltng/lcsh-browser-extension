/**
 * Input budgets (SPEC-P4 §10): bibliographic text trimming for step 1 (and
 * step 3), and the number of candidates per suggestion.
 */

export const SUGGEST_LIMITS = {
  nano: { abstract: 2000, tableOfContents: 1500, notes: 800 },
  cloud: { abstract: 8000, tableOfContents: 4000, notes: 2000 }
};

export const CANDIDATE_LIMITS = { nano: 4, cloud: 10 };

/** Candidates per suggestion in the Nano `too_long` retry. */
export const NANO_RETRY_CANDIDATES = 2;

/**
 * Whether a provider config is Gemini Nano.
 * @param {object|null} cfg - ProviderConfig
 * @returns {boolean}
 */
export const isNano = (cfg) => cfg?.providerId === 'gemini-nano' || cfg?.entry?.adapter === 'chrome-nano';

/**
 * Cut a text to at most `max` characters (code points): at a word boundary,
 * then `…`. A text that fits is returned unchanged.
 * @param {string} text - Text
 * @param {number} max - Maximum length, including the ellipsis
 * @returns {string}
 */
export const trimAtWord = (text, max) => {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, Math.max(0, max - 1)).join('');
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
};

/**
 * A budgeted COPY of the bibliographic info (the live form data is not changed).
 * @param {object} info - Bibliographic info
 * @param {object|null} cfg - ProviderConfig (Nano gets the smaller limits)
 * @returns {object}
 */
export const budgetBibliographic = (info = {}, cfg = null) => {
  const limits = isNano(cfg) ? SUGGEST_LIMITS.nano : SUGGEST_LIMITS.cloud;
  return {
    title: info.title || '',
    author: info.author || '',
    abstract: trimAtWord(info.abstract || '', limits.abstract),
    tableOfContents: trimAtWord(info.tableOfContents || '', limits.tableOfContents),
    notes: trimAtWord(info.notes || '', limits.notes)
  };
};

/**
 * Candidates per suggestion for a provider config.
 * @param {object|null} cfg - ProviderConfig
 * @returns {number}
 */
export const candidateLimit = (cfg) => (isNano(cfg) ? CANDIDATE_LIMITS.nano : CANDIDATE_LIMITS.cloud);
