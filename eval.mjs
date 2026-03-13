/**
 * Evaluation script for the LCSH Browser Extension
 * Replicates the extension's exact pipeline: Gemini suggestions → LOC validation → similarity matching
 * Compares results against ground truth from dataset_100_eng.json
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const LCSH_SUGGEST_URL = 'https://id.loc.gov/authorities/subjects/suggest2';
const LCNAF_SUGGEST_URL = 'https://id.loc.gov/authorities/names/suggest2';

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error('Set GOOGLE_API_KEY env var');
  process.exit(1);
}

// --- System prompt (same as extension default) ---
const SYSTEM_PROMPT_RULES = `# LCSH Selection Rules

1. Select subject headings that represent the main topics of the work.
2. Prefer established LCSH terms over creating new ones.
3. Use the most specific heading available for a topic.
4. Assign 1-6 subject headings, with 3-4 being optimal for most works.
5. For personal names, verify the authorized form in the LC Name Authority File (LCNAF).
6. For geographic subjects, use established subdivisions.
7. For works about multiple topics, assign a heading for each significant topic.
8. For works of literature, assign genre/form terms as appropriate.
9. For biographies, assign a heading for the subject of the biography.
10. For historical works, assign chronological subdivisions as appropriate.
11. If images are provided, analyze them for additional bibliographic information.
12. For book covers or title pages, extract relevant subject information.
13. Terms will be validated against both LCSH and LCNAF authorities.`;

const FIXED_OUTPUT_FORMAT = `
### Output Format Instructions

Please provide your LCSH recommendations in the following structured format:

### **Subject Analysis**
[Brief analysis of the work's subject matter and why certain subject areas are relevant]

---

### **API Validation Process**
I will validate the following candidate LCSH terms using the API:
1. **[Term 1]**
2. **[Term 2]**
[etc.]

Now calling the API to verify these terms…

---

### **Recommended LCSH Terms**

1. **[LCSH Term 1]** (✓ Verified by API)
   - **MARC:**
   \`\`\`marc
   [MARC format of the heading]
   \`\`\`
   - **API ID:** [LC identifier]
   - **URL:** [LCSH Record URL]
   - **Justification:** [Brief explanation of why this heading is appropriate]

2. **[LCSH Term 2]** (✓ Verified by API)
   [Same format as above]

[etc.]

---

### **Special Considerations**
[Any additional notes about the headings, potential alternatives, or special cases to consider]
`;

// --- Utility functions (same as extension) ---

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

function findBestMatch(term, items) {
  if (!items || items.length === 0) return { item: null, similarity: 0 };
  let best = null, highest = 0;
  for (const item of items) {
    const sim = calculateSimilarity(term, item.heading);
    if (sim > highest) { highest = sim; best = item; }
  }
  return { item: best, similarity: highest };
}

// --- API calls ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callGemini(requestBody) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(`${GEMINI_API_URL}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const err = await res.json().catch(() => ({}));
      if (attempt < 3) {
        // Parse retry delay from error message, or use exponential backoff
        const retryMatch = (err.error?.message || '').match(/retry in ([\d.]+)s/i);
        const delay = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) * 1000 + 1000 : Math.pow(2, attempt + 2) * 1000;
        console.log(`    (429 — waiting ${Math.round(delay/1000)}s before retry ${attempt + 1}/3)`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${err.error?.message || res.statusText}`);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini ${res.status}: ${err.error?.message || res.statusText}`);
  }
}

async function searchSuggest2(url, query, count = 20) {
  const params = new URLSearchParams({ q: query, count: String(count) });
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(`${url}?${params}`, {
      headers: { 'User-Agent': 'LCSH-Eval/1.0', 'Accept': 'application/json' },
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
    }
    if (!res.ok) return [];
    const data = await res.json();
    const source = url.includes('subjects') ? 'lcsh' : 'lcnaf';

    // New format: {hits: [...]}
    if (data && data.hits && Array.isArray(data.hits)) {
      return data.hits.map(hit => ({
        heading: hit.aLabel || hit.suggestLabel || '',
        uri: hit.uri || '',
        identifier: hit.uri ? hit.uri.split('/').pop() : '',
        source,
      })).filter(r => r.heading);
    }
    // Legacy format: [query, [labels], [uris]]
    if (Array.isArray(data) && data.length >= 3) {
      const labels = data[1] || [];
      const uris = data[2] || [];
      return labels.map((label, i) => ({
        heading: label,
        uri: uris[i] || '',
        identifier: uris[i] ? uris[i].split('/').pop() : '',
        source,
      })).filter(r => r.heading);
    }
    return [];
  }
  return [];
}

function normalizeQuery(q) { return q.replace(/--/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractMainHeading(h) { return h.split('--')[0].trim(); }

async function searchLcsh(term) {
  const norm = normalizeQuery(term);
  let results = await searchSuggest2(LCSH_SUGGEST_URL, norm);
  await sleep(500);
  // Keyword search fallback
  if (results.length === 0) {
    results = await searchSuggest2(LCSH_SUGGEST_URL, 'keyword*' + norm);
    await sleep(500);
  }
  // Main heading fallback for subdivided terms
  if (results.length === 0 && term.includes('--')) {
    results = await searchSuggest2(LCSH_SUGGEST_URL, extractMainHeading(term));
    await sleep(500);
  }
  return results;
}

async function searchLcnaf(term) {
  const results = await searchSuggest2(LCNAF_SUGGEST_URL, normalizeQuery(term));
  await sleep(500);
  return results;
}

// --- Pipeline (replicates extension flow) ---

async function generateSuggestions(record) {
  const systemPrompt = `${SYSTEM_PROMPT_RULES}\n\n${FIXED_OUTPUT_FORMAT}`;
  const textContent = `
Please suggest Library of Congress Subject Headings (LCSH) for the following work:

Title: ${record.title || 'N/A'}
Author: ${(record.authors || []).join('; ') || 'N/A'}
${record.abstract ? `Abstract: ${record.abstract}` : ''}
${record.toc ? `Table of Contents: ${record.toc}` : ''}
${record.notes ? `Additional Notes: ${record.notes}` : ''}
  `;

  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: textContent }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.2, topK: 40, topP: 0.95, maxOutputTokens: 8192 },
  };

  const data = await callGemini(requestBody);
  return parseSuggestions(data);
}

function parseSuggestions(response) {
  const content = response.candidates[0].content.parts[0].text;
  const allTerms = new Set();

  // Strategy 1: Extract from "API Validation Process" section
  const apiMatch = content.match(/(?:API Validation|Candidate|validate)[^]*?(?=---|###\s|$)/i);
  if (apiMatch) {
    const termRe = /\d+\.\s*\*?\*?([^*\n]+)\*?\*?/g;
    let m;
    while ((m = termRe.exec(apiMatch[0])) !== null) {
      const term = m[1].replace(/[*()✓✗]/g, '').replace(/Verified.*$/i, '').trim();
      if (term && !term.match(/^(I will|Now calling|validate|the following)/i) && term.length > 2) {
        allTerms.add(term);
      }
    }
  }

  // Strategy 2: Extract from "Recommended LCSH Terms" section
  const recMatch = content.match(/Recommended LCSH Terms[^]*?(?=---|###\s*\*\*Special|$)/i);
  if (recMatch) {
    const sections = recMatch[0].split(/\d+\.\s+\*\*/).slice(1);
    for (const sec of sections) {
      const tm = sec.match(/([^*]+)\*\*/);
      if (tm) {
        const term = tm[1].replace(/[()✓✗]/g, '').replace(/Verified.*$/i, '').trim();
        if (term && term.length > 2) allTerms.add(term);
      }
    }
  }

  // Strategy 3: Extract MARC fields (650, 600, 610, 651)
  const marcRe = /(?:650|600|610|651)\s+.{2}\s+\$a\s+([^\n]+)/g;
  let mm;
  while ((mm = marcRe.exec(content)) !== null) {
    const term = mm[1].replace(/\s*\$[a-z]\s*/g, '--').replace(/--$/, '').trim();
    if (term.length > 2) allTerms.add(term);
  }

  // Strategy 4: Fallback — any bold terms that look like LCSH headings
  if (allTerms.size === 0) {
    const boldRe = /\*\*([^*]{3,80})\*\*/g;
    let bm;
    while ((bm = boldRe.exec(content)) !== null) {
      const term = bm[1].trim();
      // Skip section headers and non-LCSH text
      if (!term.match(/^(Subject Analysis|API|Recommended|Special|Output|MARC|Justification|URL|LCSH)/i)
          && !term.match(/^(Precision|Recall|Verified|Note)/i)) {
        allTerms.add(term);
      }
    }
  }

  const terms = [...allTerms];
  return { terms, rawResponse: content };
}

async function validateAndScore(terms) {
  const results = [];
  // Process with concurrency limit of 3
  const queue = [...terms];
  const concurrency = 3;

  const processNext = async () => {
    while (queue.length > 0) {
      const term = queue.shift();
      try {
        const [lcshResults, lcnafResults] = await Promise.all([
          searchLcsh(term).catch(() => []),
          searchLcnaf(term).catch(() => []),
        ]);
        const allResults = [
          ...lcshResults.map(r => ({ ...r, source: 'lcsh' })),
          ...lcnafResults.map(r => ({ ...r, source: 'lcnaf' })),
        ];
        const best = findBestMatch(term, allResults);
        results.push({
          term,
          bestMatch: best.item ? { heading: best.item.heading, source: best.item.source, identifier: best.item.identifier } : null,
          similarity: best.similarity,
        });
      } catch {
        results.push({ term, bestMatch: null, similarity: 0 });
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, terms.length); i++) workers.push(processNext());
  await Promise.all(workers);

  // Filter to similarity > 30 (same threshold as extension)
  return results.filter(r => r.similarity > 30 && r.bestMatch);
}

// --- Evaluation metrics ---

function normalizeHeading(h) { return h.toLowerCase().replace(/\s+/g, ' ').trim(); }

function computeMetrics(predicted, groundTruth) {
  const predNorm = predicted.map(normalizeHeading);
  const gtNorm = groundTruth.map(normalizeHeading);

  // Exact match
  const exactTP = predNorm.filter(p => gtNorm.includes(p)).length;
  const exactPrec = predNorm.length > 0 ? exactTP / predNorm.length : 0;
  const exactRecall = gtNorm.length > 0 ? exactTP / gtNorm.length : 0;
  const exactF1 = exactPrec + exactRecall > 0 ? 2 * exactPrec * exactRecall / (exactPrec + exactRecall) : 0;

  // Fuzzy match (similarity >= 80)
  let fuzzyTP = 0;
  const matchedGt = new Set();
  for (const p of predNorm) {
    for (let i = 0; i < gtNorm.length; i++) {
      if (!matchedGt.has(i) && calculateSimilarity(p, gtNorm[i]) >= 80) {
        fuzzyTP++;
        matchedGt.add(i);
        break;
      }
    }
  }
  const fuzzyPrec = predNorm.length > 0 ? fuzzyTP / predNorm.length : 0;
  const fuzzyRecall = gtNorm.length > 0 ? fuzzyTP / gtNorm.length : 0;
  const fuzzyF1 = fuzzyPrec + fuzzyRecall > 0 ? 2 * fuzzyPrec * fuzzyRecall / (fuzzyPrec + fuzzyRecall) : 0;

  // Main heading match (ignore subdivisions)
  const predMain = predNorm.map(p => p.split('--')[0].trim());
  const gtMain = gtNorm.map(g => g.split('--')[0].trim());
  const mainTP = predMain.filter(p => gtMain.includes(p)).length;
  const mainPrec = predMain.length > 0 ? mainTP / predMain.length : 0;
  const mainRecall = gtMain.length > 0 ? mainTP / gtMain.length : 0;
  const mainF1 = mainPrec + mainRecall > 0 ? 2 * mainPrec * mainRecall / (mainPrec + mainRecall) : 0;

  return {
    exact: { precision: exactPrec, recall: exactRecall, f1: exactF1 },
    fuzzy: { precision: fuzzyPrec, recall: fuzzyRecall, f1: fuzzyF1 },
    mainHeading: { precision: mainPrec, recall: mainRecall, f1: mainF1 },
  };
}

// --- Main ---

import { readFileSync } from 'fs';

const SAMPLE_SIZE = parseInt(process.argv[2] || '5', 10);
const dataset = JSON.parse(readFileSync('../lcsh-database-validation/data/dataset_100_eng.json', 'utf-8'));
const records = dataset.records.slice(0, SAMPLE_SIZE);

console.log(`\n=== LCSH Browser Extension Evaluation ===`);
console.log(`Model: gemini-2.5-flash`);
console.log(`Records: ${records.length} / ${dataset.records.length}`);
console.log(`Similarity threshold: >30%\n`);

const allMetrics = [];

for (let i = 0; i < records.length; i++) {
  const rec = records[i];
  // Merge ground truth from both catalogs
  const gtSet = new Set([
    ...(rec.ground_truth_lcsh?.harvard || []),
    ...(rec.ground_truth_lcsh?.columbia || []),
  ]);
  const groundTruth = [...gtSet];

  console.log(`--- Record ${i + 1}/${records.length}: "${rec.title.slice(0, 60)}" ---`);
  console.log(`  Ground truth (${groundTruth.length}): ${groundTruth.join('; ')}`);

  try {
    // Step 1: Gemini suggestions
    console.log('  [1/2] Calling Gemini...');
    const { terms } = await generateSuggestions(rec);
    console.log(`  Gemini suggested ${terms.length} terms: ${terms.join('; ')}`);

    // Step 2: LOC validation + similarity scoring
    console.log('  [2/2] Validating against LOC...');
    const validated = await validateAndScore(terms);
    const predicted = validated.map(v => v.bestMatch.heading);
    console.log(`  Validated ${validated.length} terms: ${validated.map(v => `${v.bestMatch.heading} (${v.similarity}%)`).join('; ')}`);

    // Compute metrics
    const metrics = computeMetrics(predicted, groundTruth);
    allMetrics.push(metrics);

    console.log(`  Exact F1: ${(metrics.exact.f1 * 100).toFixed(1)}% | Fuzzy F1: ${(metrics.fuzzy.f1 * 100).toFixed(1)}% | Main Heading F1: ${(metrics.mainHeading.f1 * 100).toFixed(1)}%`);

    // Rate limit: wait between Gemini calls (free tier: 10 RPM for gemini-2.5-flash)
    if (i < records.length - 1) {
      console.log('  Waiting 15s (rate limit)...');
      await sleep(15000);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    allMetrics.push({ exact: { precision: 0, recall: 0, f1: 0 }, fuzzy: { precision: 0, recall: 0, f1: 0 }, mainHeading: { precision: 0, recall: 0, f1: 0 } });
  }
  console.log();
}

// --- Aggregate results ---
const avg = (arr, key) => arr.reduce((s, m) => s + m[key], 0) / arr.length;

console.log(`\n========== AGGREGATE RESULTS (${allMetrics.length} records) ==========\n`);
console.log('Metric           | Precision | Recall | F1');
console.log('-----------------|-----------|--------|------');
console.log(`Exact Match      | ${(avg(allMetrics.map(m => m.exact), 'precision') * 100).toFixed(1)}%    | ${(avg(allMetrics.map(m => m.exact), 'recall') * 100).toFixed(1)}%  | ${(avg(allMetrics.map(m => m.exact), 'f1') * 100).toFixed(1)}%`);
console.log(`Fuzzy Match (≥80)| ${(avg(allMetrics.map(m => m.fuzzy), 'precision') * 100).toFixed(1)}%    | ${(avg(allMetrics.map(m => m.fuzzy), 'recall') * 100).toFixed(1)}%  | ${(avg(allMetrics.map(m => m.fuzzy), 'f1') * 100).toFixed(1)}%`);
console.log(`Main Heading     | ${(avg(allMetrics.map(m => m.mainHeading), 'precision') * 100).toFixed(1)}%    | ${(avg(allMetrics.map(m => m.mainHeading), 'recall') * 100).toFixed(1)}%  | ${(avg(allMetrics.map(m => m.mainHeading), 'f1') * 100).toFixed(1)}%`);
console.log();
