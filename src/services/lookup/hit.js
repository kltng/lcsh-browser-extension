/**
 * suggest2 hit → Candidate validation (SPEC-P4 §4.3). A Candidate is built
 * ONLY here, from data returned by id.loc.gov.
 */

/** The authorities of P4: the id.loc.gov path segment of each. */
export const AUTHORITY_SEGMENTS = {
  lcsh: 'subjects',
  lcnaf: 'names',
  lcgft: 'genreForms'
};

const TOKEN = /^[a-z]{1,3}[0-9]+(-[0-9]+)?$/;
const MAX_LABEL = 500;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validate one hit and build its Candidate (without a match class).
 * @param {any} hit - One element of `hits`
 * @param {'lcsh'|'lcnaf'|'lcgft'} authority - The authority that was searched
 * @returns {object|null} - The Candidate, or null when the hit is rejected
 */
export const toCandidate = (hit, authority) => {
  const segment = AUTHORITY_SEGMENTS[authority];
  if (!segment || !isPlainObject(hit)) return null;
  const { aLabel, token, uri } = hit;
  if (typeof aLabel !== 'string' || aLabel.trim() === '' || [...aLabel].length > MAX_LABEL) return null;
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  if (uri !== `http://id.loc.gov/authorities/${segment}/${token}`) return null;

  const more = hit.more === undefined ? {} : hit.more;
  if (!isPlainObject(more)) return null;

  let marcKey = null;
  if (more.marcKeys !== undefined) {
    if (!isStringArray(more.marcKeys)) return null;
    marcKey = more.marcKeys.length > 0 ? more.marcKeys[0] : null;
  }
  // Subdivision records (18X) are never candidates.
  if (marcKey !== null && marcKey.slice(0, 3).startsWith('18')) return null;

  if (more.collections !== undefined) {
    if (!isStringArray(more.collections)) return null;
    if (more.collections.some((c) => c.endsWith('collection_Subdivisions'))) return null;
  }
  if (more.rdftypes !== undefined && !isStringArray(more.rdftypes)) return null;

  return {
    cid: `${authority}:${token}`,
    authority,
    localId: token,
    uri,
    label: aLabel,
    marcKey,
    rdfTypes: isStringArray(more.rdftypes) ? [...more.rdftypes] : [],
    source: 'loc-api'
  };
};

/**
 * Parse a suggest2 response body. A body that is not JSON, or whose `hits`
 * is not an array, is a failed request (`invalid_output`).
 * @param {string} text - Response body
 * @param {'lcsh'|'lcnaf'|'lcgft'} authority - The authority that was searched
 * @returns {{ok:true, candidates:object[], rejectedHits:number}|{ok:false}}
 */
export const parseSuggestBody = (text, authority) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false };
  }
  if (!isPlainObject(data) || !Array.isArray(data.hits)) return { ok: false };
  const candidates = [];
  let rejectedHits = 0;
  for (const hit of data.hits) {
    const candidate = toCandidate(hit, authority);
    if (candidate) candidates.push(candidate);
    else rejectedHits += 1;
  }
  return { ok: true, candidates, rejectedHits };
};

export default toCandidate;
