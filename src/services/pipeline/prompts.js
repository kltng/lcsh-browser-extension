/**
 * Prompts of the P4 pipeline (SPEC-P4 §3, §5.1). Plain ESM with no imports,
 * no browser globals and no chrome.* use, so the lead's evaluation harness
 * can import it in Node.
 */

/**
 * How many headings step 1 asks for (§11). The two allowed values are
 * "3 to 6" (the default) and "up to 8"; the prompt-evaluation gate picks one.
 * @type {'3 to 6'|'up to 8'}
 */
export const SUGGESTION_COUNT_HINT = '3 to 6';

/** The two values the evaluation gate compares. */
export const SUGGESTION_COUNT_HINTS = ['3 to 6', 'up to 8'];

/** The fixed sentence placed between the fixed prompt and the user's rules. */
export const RULES_PRECEDENCE = '\n\nCataloging rules from the user (follow them unless they conflict with the instructions above):\n';

/** The instruction of the disclosed text fallback (§3). */
export const TEXT_FALLBACK_INSTRUCTION = 'List the headings only, one per line, at most 8.';

/**
 * The fixed part of the step-1 system prompt for a count hint.
 * @param {string} [countHint] - "3 to 6" or "up to 8"
 * @returns {string}
 */
export const buildSuggestFixed = (countHint = SUGGESTION_COUNT_HINT) => `You are an experienced library cataloger. Read the description of a work and suggest Library of Congress Subject Headings (LCSH) for it.

Instructions:
- First write a short subject analysis: what the work is about, in two to four sentences.
- Then suggest about ${countHint} headings. Write each heading the way LCSH writes headings, with subdivisions separated by "--" where a cataloger would use them (for example "Motion pictures--Japan--History").
- Give each heading a kind:
  - "topical" for topics and concepts;
  - "geographic" for places;
  - "name" for a person, family, organization, meeting or work title. A work ABOUT a person or an organization gets a heading of kind "name" for that person or organization;
  - "genre" for genre/form terms that describe what the work IS (for example "Biographical films"), not what it is about.
- Give each heading a short reason (one sentence) that links it to the work.
- Write the headings in English, as LCSH does, even when the work is in another language.`;

/** The fixed part of the step-1 system prompt (default count hint). */
export const SUGGEST_FIXED = buildSuggestFixed();

/**
 * Default cataloging rules (replaces DEFAULT_SYSTEM_PROMPT_RULES): the same
 * guidance, without the lines about checking headings and heading counts.
 */
export const DEFAULT_RULES = `# LCSH Selection Rules

1. Select subject headings that represent the main topics of the work.
2. Prefer established LCSH terms over creating new ones.
3. Use the most specific heading available for a topic.
4. For geographic subjects, use established subdivisions.
5. For works about multiple topics, assign a heading for each significant topic.
6. For works of literature, assign genre/form terms as appropriate.
7. For biographies, assign a heading for the subject of the biography.
8. For historical works, assign chronological subdivisions as appropriate.
9. If images are provided, analyze them for additional bibliographic information.
10. For book covers or title pages, extract relevant subject information.`;

/** The fixed step-3 (selection) system prompt. */
export const SELECT_FIXED = `You are an experienced library cataloger. A work is described below, followed by subject headings that an AI suggested for it. For each suggestion, a search of the Library of Congress returned candidate headings, each with an id such as "s1c2".

Instructions:
- For each suggestion, choose the ONE candidate that best fits the work, or "none" when no candidate fits.
- Choose only an id listed under that suggestion. Never write a heading of your own.
- Prefer the candidate that has the meaning of the suggestion and fits the work. A shorter candidate (with fewer subdivisions) is acceptable when it is the best one listed.
- Give a confidence from 0 to 100 for each choice.
- In "additional", you may list up to 3 more candidate ids that also fit the work well and were not chosen above. Leave it empty when there are none.`;

const AUTHORITY_NAMES = { lcsh: 'LCSH', lcnaf: 'LC Names', lcgft: 'LC Genre/Form' };

/**
 * The bibliographic text sent to both AI steps (already budgeted).
 * @param {{title?:string, author?:string, abstract?:string, tableOfContents?:string, notes?:string}} info - Bibliographic info
 * @returns {string}
 */
export const buildBibliographicText = (info = {}) => {
  const lines = [`Title: ${info.title || 'N/A'}`, `Author: ${info.author || 'N/A'}`];
  if (info.abstract) lines.push(`Abstract: ${info.abstract}`);
  if (info.tableOfContents) lines.push(`Table of contents: ${info.tableOfContents}`);
  if (info.notes) lines.push(`Notes: ${info.notes}`);
  return lines.join('\n');
};

/**
 * The step-1 prompt.
 * @param {object} info - Bibliographic info (budgeted)
 * @param {string} rules - The user's cataloging rules
 * @param {{countHint?:string}} [opts] - Count hint override (evaluation harness)
 * @returns {{system:string, userText:string}}
 */
export const buildSuggestPrompt = (info, rules, { countHint = SUGGESTION_COUNT_HINT } = {}) => ({
  system: `${buildSuggestFixed(countHint)}${RULES_PRECEDENCE}${rules || ''}`,
  userText: `Suggest subject headings for this work.\n\n${buildBibliographicText(info)}`
});

/**
 * The step-3 prompt.
 * @param {object} info - Bibliographic info (budgeted; images are not sent)
 * @param {Array<{suggestionId:string, heading:string, kind:string,
 *   candidates:Array<{pid:string, label:string, authority:string, matchClass:string}>}>} presented - Presentation
 * @returns {{system:string, userText:string}}
 */
export const buildSelectPrompt = (info, presented) => {
  const blocks = presented.map((p) => [
    `${p.suggestionId}: "${p.heading}" (kind: ${p.kind})`,
    ...p.candidates.map((c) => `  ${c.pid}: ${c.label} [${AUTHORITY_NAMES[c.authority] || c.authority}; ${c.matchClass}]`)
  ].join('\n'));
  return {
    system: SELECT_FIXED,
    userText: `The work:\n${buildBibliographicText(info)}\n\nSuggestions and their candidates:\n${blocks.join('\n\n')}`
  };
};
