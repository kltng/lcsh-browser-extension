/**
 * LOC suggest2 fixtures built from the evidence tables
 * (docs/evidence/loc_suggest2_marckeys_2026-09-27.md and its addendum), and a
 * fake id.loc.gov: fetch is mocked; no test makes a real network request.
 */
import { vi } from 'vitest';
import { response } from './setup';

const SEGMENT = { lcsh: 'subjects', lcnaf: 'names', lcgft: 'genreForms' };
const AUTHORITY_OF_SEGMENT = { subjects: 'lcsh', names: 'lcnaf', genreForms: 'lcgft' };

/**
 * One suggest2 hit.
 * @param {'lcsh'|'lcnaf'|'lcgft'} authority - Authority
 * @param {string} token - Local id
 * @param {string} aLabel - Label
 * @param {{marcKey?:string|null, rdftypes?:string[], collections?:string[]}} [more] - Metadata
 * @returns {object}
 */
export const hit = (authority, token, aLabel, { marcKey = null, rdftypes, collections } = {}) => ({
  aLabel,
  token,
  uri: `http://id.loc.gov/authorities/${SEGMENT[authority]}/${token}`,
  more: {
    ...(marcKey ? { marcKeys: [marcKey] } : {}),
    ...(rdftypes ? { rdftypes } : {}),
    ...(collections ? { collections } : {})
  }
});

/** Evidence rows as hits. */
export const EVIDENCE = {
  chinaMing: hit('lcsh', 'sh85024072', 'China--History--Ming dynasty, 1368-1644', { marcKey: '151  $aChina$xHistory$yMing dynasty, 1368-1644', rdftypes: ['ComplexSubject'] }),
  actorsJapanBio: hit('lcsh', 'sh2010102453', 'Motion picture actors and actresses--Japan--Biography', { marcKey: '150  $aMotion picture actors and actresses$zJapan$vBiography', rdftypes: ['ComplexSubject'] }),
  cats: hit('lcsh', 'sh85021262', 'Cats', { marcKey: '150 0$aCats', rdftypes: ['Topic'] }),
  kurosawa: hit('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', { marcKey: '1001 $aKurosawa, Akira,$d1910-1998', rdftypes: ['PersonalName'] }),
  harvard: hit('lcnaf', 'n78096930', 'Harvard University', { marcKey: '1102 $aHarvard University', rdftypes: ['CorporateName'] }),
  japanSubdivision: hit('lcnaf', 'n78089021-781', 'Japan', { marcKey: '181  $zJapan', rdftypes: ['Geographic'] }),
  japanName: hit('lcnaf', 'n78089021', 'Japan', { marcKey: '151  $aJapan' }),
  biographicalFilms: hit('lcgft', 'gf2011026089', 'Biographical films', { marcKey: '155  $aBiographical films', rdftypes: ['GenreForm'] }),
  motionPicturesJapanHistory: hit('lcsh', 'sh2008108026', 'Motion pictures--Japan--History', { marcKey: '150  $aMotion pictures$zJapan$xHistory' }),
  japanHistory: hit('lcsh', 'sh85069426', 'Japan--History', { marcKey: '151 0$aJapan$xHistory', rdftypes: ['ComplexSubject'] }),
  kyotoName: hit('lcnaf', 'n80024170', 'Kyoto (Japan)', { marcKey: '151  $aKyoto (Japan)', rdftypes: ['Geographic'] }),
  kyotoSubdivision: hit('lcsh', 'sh85073829-781', 'Kyoto (Japan)', { marcKey: '181  $zKyoto (Japan)', rdftypes: ['Geographic'], collections: ['http://id.loc.gov/authorities/subjects/collection_Subdivisions'] }),
  historyTopic: hit('lcsh', 'sh85061212', 'History', { marcKey: '150  $aHistory', rdftypes: ['Topic'], collections: ['http://id.loc.gov/authorities/subjects/collection_LCSH_General'] }),
  historySubdivision: hit('lcsh', 'sh99005024', 'History', { marcKey: '180  $xHistory', rdftypes: ['Topic'], collections: ['http://id.loc.gov/authorities/subjects/collection_Subdivisions', 'http://id.loc.gov/authorities/subjects/collection_TopicSubdivisions'] })
};

/**
 * The parts of a suggest2 URL.
 * @param {string} url - Request URL
 * @returns {{authority:string, q:string, searchtype:string, count:string}}
 */
export const parseLocUrl = (url) => {
  const u = new URL(url);
  const segment = u.pathname.split('/')[2];
  return {
    authority: AUTHORITY_OF_SEGMENT[segment],
    q: u.searchParams.get('q'),
    searchtype: u.searchParams.get('searchtype'),
    count: u.searchParams.get('count')
  };
};

/** A readable request key: `lcsh leftanchored "Cats"`. */
export const keyOf = (url) => {
  const { authority, q, searchtype } = parseLocUrl(url);
  return `${authority} ${searchtype} "${q}"`;
};

/**
 * Install a fake id.loc.gov. `routes` maps a request key (see keyOf) to hits,
 * to a response() object, or to a function returning one; unknown requests
 * get `{hits: []}`.
 * @param {Object<string, object[]|object|Function>} routes - Answers
 * @returns {{fetch:Function, keys:()=>string[]}}
 */
export const mockLoc = (routes = {}) => {
  const fetchMock = vi.fn(async (url, init) => {
    const route = routes[keyOf(url)];
    if (typeof route === 'function') return route(url, init);
    if (Array.isArray(route)) return response({ q: parseLocUrl(url).q, count: route.length, hits: route });
    if (route) return route;
    return response({ hits: [] });
  });
  globalThis.fetch = fetchMock;
  return { fetch: fetchMock, keys: () => fetchMock.mock.calls.map(([url]) => keyOf(url)) };
};

/** A scheduler without spacing, for stage tests that do not test timing. */
export const fastSchedulerOptions = { spacingMs: 0, maxInFlight: 8 };
