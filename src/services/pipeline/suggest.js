/**
 * Step 1 — suggest (SPEC-P4 §3): JSON suggestions through generate(), and
 * the ONE disclosed text-mode retry after `invalid_output` (the §3
 * exception to SPEC-P3 §4.1). Every other ProviderError propagates.
 */
import { generate as defaultGenerate, ProviderError } from '../providers/index';
import { errorContext, rejectEchoedKey } from '../providers/errors';
import { normalizeLabel } from '../lookup/normalize';
import { hasLetterOrNumber } from '../lookup/searchText';
import { buildSuggestPrompt, TEXT_FALLBACK_INSTRUCTION, SUGGESTION_COUNT_HINT } from './prompts';
import { SUGGEST_SCHEMA } from './schemas';
import { budgetBibliographic } from './budget';
import { toGenerateImages } from './images';
import { makeSuggestion } from './types';

/** One deadline for the JSON attempt and the text fallback together. */
export const SUGGEST_DEADLINE_MS = 90000;
export const MAX_SUGGESTIONS = 8;
const MAX_LINE = 200;

export const TEXT_FALLBACK_NOTICE = 'The model did not return structured output; suggestions were read from plain text.';

/**
 * Trim, merge duplicates (normalizeLabel; first kept), drop headings with no
 * letter or number, and number the rest s1..sN in model order.
 * @param {Array<{heading:string, kind?:string, reason?:string}>} raw - Model suggestions
 * @returns {object[]} - Suggestions
 */
export const postProcessSuggestions = (raw) => {
  const seen = new Set();
  const kept = [];
  for (const item of raw) {
    const heading = String(item.heading ?? '').trim();
    const key = normalizeLabel(heading);
    if (!hasLetterOrNumber(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push({ heading, kind: item.kind, reason: String(item.reason ?? '').trim() });
  }
  return kept.map((item, i) => makeSuggestion({ id: `s${i + 1}`, ...item }));
};

const stripFence = (text) => {
  const trimmed = String(text ?? '').trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : trimmed;
};

/**
 * Parse the plain-text fallback answer (§3 steps 1–7). A leading `*` bullet
 * is removed only when it is not the start of a `**` wrapper.
 * @param {string} text - Answer text
 * @returns {string[]} - At most 8 headings
 */
export const parseTextFallback = (text) => {
  const seen = new Set();
  const out = [];
  for (const rawLine of stripFence(text).split(/\r?\n/)) {
    let line = rawLine.replace(/^\s*(\d+[.)]|[-•]|\*(?!\*))\s*/, '');
    const bold = line.match(/^\s*\*\*(.*)\*\*\s*$/);
    if (bold) line = bold[1];
    line = line.trim();
    if (!line || [...line].length > MAX_LINE) continue;
    const key = normalizeLabel(line);
    if (!hasLetterOrNumber(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
};

/**
 * Run step 1 with ONE config snapshot.
 * @param {{cfg:object, bibliographicInfo:object, rules:string, signal?:AbortSignal,
 *   countHint?:string, generateImpl?:Function}} args - Snapshot, form data, rules, signal
 * @returns {Promise<{subjectAnalysis:string, suggestions:object[], suggestMode:'json'|'text-fallback',
 *   provenance:{providerId:string, model:string}}>}
 */
export async function runSuggest({
  cfg, bibliographicInfo, rules, signal, countHint = SUGGESTION_COUNT_HINT, generateImpl = defaultGenerate
}) {
  const ctx = errorContext(cfg);
  const provenance = { providerId: cfg.providerId, model: cfg.model };
  const { system, userText } = buildSuggestPrompt(budgetBibliographic(bibliographicInfo, cfg), rules, { countHint });
  const images = toGenerateImages(bibliographicInfo?.images);
  const startedAt = Date.now();
  let json = null;
  try {
    const result = await generateImpl(cfg, {
      system, userText, images, schema: SUGGEST_SCHEMA, temperature: 0.2, maxOutputTokens: 2048, signal,
      deadlineMs: SUGGEST_DEADLINE_MS
    });
    json = result.json;
  } catch (err) {
    // Only an `invalid_output` thrown by generate() leads to the text fallback.
    if (!(err instanceof ProviderError) || err.kind !== 'invalid_output') throw err;
  }
  if (json) {
    const suggestions = postProcessSuggestions(json.suggestions);
    if (suggestions.length === 0) throw new ProviderError('invalid_output', ctx);
    const subjectAnalysis = json.subjectAnalysis.trim();
    // P6 security re-review: the key check runs again on the FINAL values,
    // after trimming and merging, right before they are returned.
    rejectEchoedKey(cfg, { subjectAnalysis, suggestions: suggestions.map(({ heading, kind, reason }) => ({ heading, kind, reason })) });
    return { subjectAnalysis, suggestions, suggestMode: 'json', provenance };
  }

  const remaining = SUGGEST_DEADLINE_MS - (Date.now() - startedAt);
  if (remaining <= 0) throw new ProviderError('timeout', ctx);
  const result = await generateImpl(cfg, {
    system: `${system}\n\n${TEXT_FALLBACK_INSTRUCTION}`,
    userText, images, schema: null, temperature: 0.2, maxOutputTokens: 2048, signal, deadlineMs: remaining
  });
  const headings = parseTextFallback(result.text);
  if (headings.length === 0) throw new ProviderError('invalid_output', ctx);
  // The raw answer was checked inside generate(); parsing strips bullets,
  // numbers, ** and fences, so "- a" only BECOMES the key "a" here.
  rejectEchoedKey(cfg, headings);
  return {
    subjectAnalysis: '',
    suggestions: headings.map((heading, i) => makeSuggestion({ id: `s${i + 1}`, heading, kind: 'unknown', reason: '' })),
    suggestMode: 'text-fallback',
    provenance
  };
}

export default runSuggest;
