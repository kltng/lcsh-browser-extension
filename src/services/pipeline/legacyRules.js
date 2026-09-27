/**
 * The frozen default rules of older versions (byte-exact copies). A stored
 * value EXACTLY equal to one of them was never edited by the user, so
 * settings.js replaces it with DEFAULT_RULES. Any other string is custom and
 * is kept as it is. Plain ESM with no imports.
 */

/** DEFAULT_SYSTEM_PROMPT_RULES of v1.1.0 (the Chrome Web Store version). */
export const OLD_DEFAULT_RULES_V1_1_0 = `# LCSH Selection Rules

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

/** DEFAULT_SYSTEM_PROMPT_RULES of v1.0.x. */
export const OLD_DEFAULT_RULES_V1_0 = `# LCSH Selection Rules

1. Select subject headings that represent the main topics of the work.
2. Prefer established LCSH terms over creating new ones.
3. Use the most specific heading available for a topic.
4. Assign 1-6 subject headings, with 3-4 being optimal for most works.
5. For personal names, verify the authorized form in the LC Name Authority File.
6. For geographic subjects, use established subdivisions.
7. For works about multiple topics, assign a heading for each significant topic.
8. For works of literature, assign genre/form terms as appropriate.
9. For biographies, assign a heading for the subject of the biography.
10. For historical works, assign chronological subdivisions as appropriate.
11. If images are provided, analyze them for additional bibliographic information.
12. For book covers or title pages, extract relevant subject information.
13. Use Gemini 2.5 Flash capabilities to process both text and image content.`;

/** Every frozen old default. */
export const OLD_DEFAULT_RULES = [OLD_DEFAULT_RULES_V1_1_0, OLD_DEFAULT_RULES_V1_0];
