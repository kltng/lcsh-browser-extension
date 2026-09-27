/**
 * Pipeline fixtures: candidates, lookup results and suggestions (from the
 * evidence rows), shared by the select, run, history and honesty tests.
 */

import {
  initialRunState, beginSuggest, commitSuggest, beginLookup, commitLookup, beginSelect, commitSelect, setManualChoice, buildRun
} from '../src/services/pipeline/run';

let counter = 0;

/**
 * A Candidate.
 * @param {'lcsh'|'lcnaf'|'lcgft'} authority - Authority
 * @param {string} localId - Token
 * @param {string} label - Label
 * @param {string} matchClass - Match class
 * @param {string|null} [marcKey] - Authority key
 * @returns {object}
 */
export const cand = (authority, localId, label, matchClass, marcKey = null) => ({
  cid: `${authority}:${localId}`,
  authority,
  localId,
  uri: `http://id.loc.gov/authorities/${{ lcsh: 'subjects', lcnaf: 'names', lcgft: 'genreForms' }[authority]}/${localId}`,
  label,
  marcKey,
  rdfTypes: [],
  matchClass,
  source: 'loc-api'
});

/**
 * A LookupResult.
 * @param {string} suggestionId - Suggestion id
 * @param {string} outcome - Outcome
 * @param {object[]} [candidates] - Candidates
 * @param {string|null} [errorKind] - Error kind
 * @returns {object}
 */
export const result = (suggestionId, outcome, candidates = [], errorKind = null) => ({
  suggestionId, outcome, candidates, errorKind, searchedAt: `2026-09-27T00:00:${String(counter++ % 60).padStart(2, '0')}.000Z`
});

export const C = {
  mpjh: cand('lcsh', 'sh2008108026', 'Motion pictures--Japan--History', 'exact-full', '150  $aMotion pictures$zJapan$xHistory'),
  mp: cand('lcsh', 'sh85088164', 'Motion pictures', 'exact-main', '150  $aMotion pictures'),
  actors: cand('lcsh', 'sh2010102453', 'Motion picture actors and actresses--Japan--Biography', 'prefix-full', '150  $aMotion picture actors and actresses$zJapan$vBiography'),
  kurosawa: cand('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', 'prefix-main', '1001 $aKurosawa, Akira,$d1910-1998'),
  japanSh: cand('lcsh', 'sh85069407', 'Japan', 'exact-full', null),
  japanN: cand('lcnaf', 'n78089021', 'Japan', 'exact-full', '151  $aJapan'),
  japanHistory: cand('lcsh', 'sh85069426', 'Japan--History', 'prefix-full', '151 0$aJapan$xHistory'),
  biofilms: cand('lcgft', 'gf2011026089', 'Biographical films', 'exact-full', '155  $aBiographical films'),
  mismatch: cand('lcsh', 'sh99999999', 'Dogs', 'keyword', '150  $aCats')
};

/** Suggestions s1..s6 of the 日本電影人物志 case. */
export const SUGGESTIONS = [
  { id: 's1', heading: 'Motion pictures--Japan--History', kind: 'topical', reason: 'Film history.' },
  { id: 's2', heading: 'Motion picture actors and actresses--Japan--Biography', kind: 'topical', reason: 'Biographies.' },
  { id: 's3', heading: 'Japan', kind: 'geographic', reason: 'Place.' },
  { id: 's4', heading: 'Japanese cinema', kind: 'topical', reason: 'Nano legacy suggestion.' },
  { id: 's5', heading: 'Kurosawa, Akira', kind: 'name', reason: 'Director.' },
  { id: 's6', heading: 'Motion pictures--Japan--Biography', kind: 'topical', reason: 'Main heading only.' }
];

/** Lookup results for SUGGESTIONS: every outcome. */
export const RESULTS = {
  s1: result('s1', 'found', [C.mpjh, C.mp]),
  s2: result('s2', 'partial', [C.actors], 'server'),
  s3: result('s3', 'found', [C.japanSh, C.japanN, C.japanHistory]),
  s4: result('s4', 'no-results'),
  s5: result('s5', 'failed', [], 'network'),
  s6: result('s6', 'found', [C.mp, C.mpjh])
};

/**
 * A BUILT run over SUGGESTIONS/RESULTS: AI choices for s1 and s2 (none),
 * a manual choice for s3, a manual "none" for s6, and one additional pick.
 * @returns {object} - Run state
 */
export const builtRun = () => {
  const prov = { providerId: 'deepseek', model: 'deepseek-flash' };
  let { state, token } = beginSuggest(initialRunState(), { runId: 'run-1', snapshot: prov, input: { title: '日本電影人物志' } });
  state = commitSuggest(state, token, { subjectAnalysis: 'Japanese film people.', suggestions: SUGGESTIONS, suggestMode: 'json', provenance: prov });
  const begun = beginLookup(state, SUGGESTIONS.map((s) => s.id));
  state = begun.state;
  for (const s of SUGGESTIONS) state = commitLookup(state, begun.tokens[s.id], RESULTS[s.id]);
  const sel = beginSelect(state, { providerId: 'gemini', model: 'gemini-2.5-flash' });
  state = commitSelect(sel.state, sel.token, {
    mode: 'ai',
    choices: { s1: { cid: C.mpjh.cid, confidence: 85 }, s2: { cid: null, confidence: 30 } },
    additional: [{ cid: C.actors.cid, confidence: 45 }]
  });
  state = setManualChoice(state, 's3', C.japanN.cid);
  state = setManualChoice(state, 's6', null);
  return buildRun(state);
};

/** A dev v1.1.0 history entry (no v, no provenance). */
export const V110_ENTRY = {
  id: 1719000000000,
  timestamp: '2026-06-21T10:00:00.000Z',
  bibliographicInfo: {
    title: 'Cats of Japan', author: 'Tanaka, K.', abstract: 'About cats.', tableOfContents: '', notes: '',
    images: [{ name: 'cover.png', type: 'image/png', size: 1234 }]
  },
  initialSuggestions: { specialConsiderations: 'None.' },
  finalRecommendations: [{
    term: 'Cats', similarity: 90, justification: 'Main topic (✓ Verified by API)',
    bestMatch: { heading: 'Cats', uri: '/authorities/subjects/sh85021262', identifier: 'sh85021262', source: 'lcsh' }
  }],
  selectedRecommendations: [],
  averageSimilarity: 90,
  marcRecords: { Cats: '150 _0 $a Cats\n650 _0 $a Cats' }
};

/** A P3 entry: v1.1.0 shape plus the two provenance fields. */
export const P3_ENTRY = {
  ...V110_ENTRY,
  id: 1727000000000,
  suggestionProvenance: { providerId: 'deepseek', model: 'deepseek-flash' },
  marcProvenance: null
};
