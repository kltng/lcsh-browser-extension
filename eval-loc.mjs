/**
 * LOC Validation-only evaluation
 * Skips Gemini — feeds ground truth headings directly into LOC suggest2 validation
 * to measure how well the LOC search + similarity matching works.
 */

import { readFileSync } from 'fs';

const LCSH_SUGGEST_URL = 'https://id.loc.gov/authorities/subjects/suggest2';
const LCNAF_SUGGEST_URL = 'https://id.loc.gov/authorities/names/suggest2';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Levenshtein similarity (same as extension) ---

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function calculateSimilarity(a, b) {
  if (!a || !b) return 0;
  const aL = a.toLowerCase(), bL = b.toLowerCase();
  if (aL === bL) return 100;
  const dist = levenshteinDistance(aL, bL);
  return Math.max(0, Math.round((1 - dist / Math.max(aL.length, bL.length)) * 100));
}

// --- LOC API ---

async function searchSuggest2(url, query, count = 20) {
  const params = new URLSearchParams({ q: query, count: String(count) });
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${url}?${params}`, {
        headers: { 'User-Agent': 'LCSH-Eval/1.0', 'Accept': 'application/json' },
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
        return [];
      }
      if (!res.ok) return [];
      const data = await res.json();
      const source = url.includes('subjects') ? 'lcsh' : 'lcnaf';

      if (data && data.hits && Array.isArray(data.hits)) {
        return data.hits.map(hit => ({
          heading: hit.aLabel || hit.suggestLabel || '',
          uri: hit.uri || '',
          source,
        })).filter(r => r.heading);
      }
      if (Array.isArray(data) && data.length >= 3) {
        const labels = data[1] || [];
        const uris = data[2] || [];
        return labels.map((label, i) => ({
          heading: label, uri: uris[i] || '', source,
        })).filter(r => r.heading);
      }
      return [];
    } catch { return []; }
  }
  return [];
}

function normalizeQuery(q) { return q.replace(/--/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractMainHeading(h) { return h.split('--')[0].trim(); }

async function validateTerm(term) {
  const norm = normalizeQuery(term);
  const isName = /^\w+,\s/.test(term); // Simple heuristic: "LastName, ..." is a name

  // Search LCSH
  let results = await searchSuggest2(LCSH_SUGGEST_URL, norm);
  await sleep(500);

  // Keyword search fallback
  if (results.length === 0) {
    results = await searchSuggest2(LCSH_SUGGEST_URL, 'keyword*' + norm);
    await sleep(500);
  }

  // LCNAF search for names or as fallback
  if (isName || results.length === 0) {
    const nameResults = await searchSuggest2(LCNAF_SUGGEST_URL, norm);
    results = [...results, ...nameResults];
    await sleep(500);
  }

  // Main heading fallback for subdivided terms
  if (results.length === 0 && term.includes('--')) {
    results = await searchSuggest2(LCSH_SUGGEST_URL, extractMainHeading(term));
    await sleep(500);
  }

  // Find best match
  let bestMatch = null, bestSim = 0;
  for (const r of results) {
    const sim = calculateSimilarity(term, r.heading);
    if (sim > bestSim) { bestSim = sim; bestMatch = r; }
  }

  return { term, bestMatch, similarity: bestSim, totalResults: results.length };
}

// --- Main ---

const SAMPLE_SIZE = parseInt(process.argv[2] || '20', 10);
const SIM_THRESHOLD = parseInt(process.argv[3] || '70', 10);

const dataset = JSON.parse(readFileSync('../lcsh-database-validation/data/dataset_100_eng.json', 'utf-8'));
const records = dataset.records.slice(0, SAMPLE_SIZE);

// Collect all unique ground truth headings
const allHeadings = new Set();
for (const rec of records) {
  for (const h of (rec.ground_truth_lcsh?.harvard || [])) allHeadings.add(h);
  for (const h of (rec.ground_truth_lcsh?.columbia || [])) allHeadings.add(h);
}

const headings = [...allHeadings];
console.log(`\n=== LOC Validation Evaluation ===`);
console.log(`Records: ${records.length} | Unique GT headings: ${headings.length}`);
console.log(`Similarity threshold: ≥${SIM_THRESHOLD}%\n`);

let exact = 0, fuzzy90 = 0, fuzzy80 = 0, fuzzy70 = 0, noMatch = 0;
const results = [];

for (let i = 0; i < headings.length; i++) {
  const h = headings[i];
  const r = await validateTerm(h);
  results.push(r);

  const simStr = r.bestMatch ? `${r.similarity}% → ${r.bestMatch.heading}` : 'no results';

  if (r.similarity === 100) {
    exact++;
    // Don't log exact matches to reduce noise
  } else if (r.similarity >= 90) {
    fuzzy90++;
    console.log(`  [~90%] "${h}" → "${r.bestMatch?.heading}" (${r.similarity}%)`);
  } else if (r.similarity >= 80) {
    fuzzy80++;
    console.log(`  [~80%] "${h}" → "${r.bestMatch?.heading}" (${r.similarity}%)`);
  } else if (r.similarity >= 70) {
    fuzzy70++;
    console.log(`  [~70%] "${h}" → "${r.bestMatch?.heading}" (${r.similarity}%)`);
  } else {
    noMatch++;
    console.log(`  [MISS] "${h}" → ${r.bestMatch ? `"${r.bestMatch.heading}" (${r.similarity}%)` : 'no results'}`);
  }

  // Progress every 20
  if ((i + 1) % 20 === 0) {
    console.log(`  ... ${i + 1}/${headings.length} processed`);
  }
}

// --- Summary ---
console.log(`\n========== RESULTS (${headings.length} headings) ==========\n`);
console.log(`Exact match (100%):  ${exact} (${(exact/headings.length*100).toFixed(1)}%)`);
console.log(`Close match (≥90%):  ${fuzzy90} (${(fuzzy90/headings.length*100).toFixed(1)}%)`);
console.log(`Fuzzy match (≥80%):  ${fuzzy80} (${(fuzzy80/headings.length*100).toFixed(1)}%)`);
console.log(`Weak match  (≥70%):  ${fuzzy70} (${(fuzzy70/headings.length*100).toFixed(1)}%)`);
console.log(`No match    (<70%):  ${noMatch} (${(noMatch/headings.length*100).toFixed(1)}%)`);
console.log(`\nValidation rate (≥${SIM_THRESHOLD}%): ${results.filter(r => r.similarity >= SIM_THRESHOLD).length}/${headings.length} (${(results.filter(r => r.similarity >= SIM_THRESHOLD).length/headings.length*100).toFixed(1)}%)`);
console.log(`Validation rate (≥80%): ${results.filter(r => r.similarity >= 80).length}/${headings.length} (${(results.filter(r => r.similarity >= 80).length/headings.length*100).toFixed(1)}%)`);
console.log(`Validation rate (≥90%): ${results.filter(r => r.similarity >= 90).length}/${headings.length} (${(results.filter(r => r.similarity >= 90).length/headings.length*100).toFixed(1)}%)`);

// Show missed headings for analysis
const missed = results.filter(r => r.similarity < SIM_THRESHOLD);
if (missed.length > 0 && missed.length <= 30) {
  console.log(`\n--- Missed headings (< ${SIM_THRESHOLD}%) ---`);
  for (const r of missed) {
    console.log(`  "${r.term}" → ${r.bestMatch ? `"${r.bestMatch.heading}" (${r.similarity}%)` : 'no results'} [${r.totalResults} candidates]`);
  }
}
