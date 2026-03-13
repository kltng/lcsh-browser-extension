/**
 * LOC Service — uses the Library of Congress suggest2 API
 * Replaces the previous web-scraping approach with direct API calls.
 * This is faster, more reliable, and doesn't require the tabs permission.
 */

const LCSH_SUGGEST_URL = 'https://id.loc.gov/authorities/subjects/suggest2';
const LCNAF_SUGGEST_URL = 'https://id.loc.gov/authorities/names/suggest2';
const LOC_USER_AGENT = 'LCSH-Browser-Extension/1.1 (https://github.com/kltng/lcsh-browser-extension)';

/**
 * Fetch from LOC API with retry on 429/503 (exponential backoff).
 */
const fetchLOCWithRetry = async (url, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': LOC_USER_AGENT,
      },
    });

    if (response.ok) return response;

    if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
      const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new Error(`LOC API error: ${response.status} ${response.statusText}`);
  }
  throw new Error('LOC API request failed after retries');
};

/**
 * Normalize a query for LOC search — strip subdivisions, clean up whitespace
 * @param {string} query - The raw search term
 * @returns {string} - Normalized query
 */
export const normalizeQuery = (query) => {
  return query
    .replace(/--/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Extract the main heading before the first subdivision
 * @param {string} heading - Full heading with possible subdivisions
 * @returns {string}
 */
export const extractMainHeading = (heading) => {
  const parts = heading.split('--');
  return parts[0].trim();
};

/**
 * Search the LOC suggest2 API for a given authority file
 * @param {string} url - The suggest2 endpoint URL
 * @param {string} query - The search term
 * @param {number} count - Max results to return
 * @returns {Promise<Array<{heading: string, uri: string, identifier: string, datasetType: string}>>}
 */
const searchSuggest2 = async (url, query, count = 20) => {
  const params = new URLSearchParams({ q: query, count: String(count) });
  const fullUrl = `${url}?${params}`;

  const response = await fetchLOCWithRetry(fullUrl);
  const data = await response.json();

  // suggest2 response: { hits: [ { uri, aLabel, vLabel, ... } ] }
  if (!data.hits || !Array.isArray(data.hits)) {
    return [];
  }

  return data.hits.map(hit => ({
    heading: hit.aLabel || hit.suggestLabel || '',
    uri: hit.uri || '',
    identifier: hit.uri ? hit.uri.split('/').pop() : '',
    datasetType: hit.memberOf || 'LCSH',
  }));
};

/**
 * Search LCSH for a term
 * @param {string} term - The search term
 * @param {number} count - Max results
 * @returns {Promise<Array>}
 */
export const searchLcsh = async (term, count = 20) => {
  const normalized = normalizeQuery(term);
  let results = await searchSuggest2(LCSH_SUGGEST_URL, normalized, count);

  // Fallback: if query has subdivisions and returned 0 results, try main heading
  if (results.length === 0 && term.includes('--')) {
    const mainHeading = extractMainHeading(term);
    results = await searchSuggest2(LCSH_SUGGEST_URL, mainHeading, count);
  }

  return results;
};

/**
 * Search LCNAF for a term
 * @param {string} term - The search term
 * @param {number} count - Max results
 * @returns {Promise<Array>}
 */
export const searchLcnaf = async (term, count = 20) => {
  const normalized = normalizeQuery(term);
  return searchSuggest2(LCNAF_SUGGEST_URL, normalized, count);
};

/**
 * Search both LCSH and LCNAF in parallel for a single term
 * @param {string} term - The search term
 * @returns {Promise<{lcshResults: Array, lcnafResults: Array}>}
 */
export const searchLOCForTerm = async (term) => {
  const [lcshResults, lcnafResults] = await Promise.all([
    searchLcsh(term).catch(() => []),
    searchLcnaf(term).catch(() => []),
  ]);

  return {
    lcshResults: lcshResults.map(r => ({ ...r, source: 'lcsh' })),
    lcnafResults: lcnafResults.map(r => ({ ...r, source: 'lcnaf' })),
  };
};

/**
 * Validate multiple terms against LOC, with progress callback
 * @param {string[]} terms - The search terms
 * @param {function} onProgress - Called with (completed, total) after each term
 * @returns {Promise<object>} - Map of term → { success, items, source }
 */
export const validateMultipleTerms = async (terms, onProgress) => {
  const results = {};
  let completed = 0;

  // Trim whitespace from each term before validation
  const trimmedTerms = terms.map(t => t.trim());

  // Process all terms with concurrency limit of 3
  const queue = [...trimmedTerms];
  const concurrency = 3;

  const processNext = async () => {
    while (queue.length > 0) {
      const term = queue.shift();
      try {
        const { lcshResults, lcnafResults } = await searchLOCForTerm(term);
        const allResults = [...lcshResults, ...lcnafResults];

        results[term] = {
          success: allResults.length > 0,
          items: allResults,
          error: allResults.length === 0 ? 'No results found' : null,
        };
      } catch (error) {
        results[term] = {
          success: false,
          items: [],
          error: error.message || 'Failed to search LOC',
        };
      }

      completed++;
      if (onProgress) {
        onProgress(completed, trimmedTerms.length);
      }
      // Rate limit: space LOC requests to avoid overwhelming the API
      await new Promise(r => setTimeout(r, 500));
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, trimmedTerms.length); i++) {
    workers.push(processNext());
  }
  await Promise.all(workers);

  return results;
};

// Legacy exports for backward compatibility
export const constructLocSearchUrl = (term) => {
  const encodedTerm = encodeURIComponent(term);
  return `https://id.loc.gov/search/?q=${encodedTerm}&q=cs%3Ahttp%3A%2F%2Fid.loc.gov%2Fauthorities%2Fsubjects`;
};

export default {
  normalizeQuery,
  extractMainHeading,
  searchLcsh,
  searchLcnaf,
  searchLOCForTerm,
  validateMultipleTerms,
  constructLocSearchUrl,
};
