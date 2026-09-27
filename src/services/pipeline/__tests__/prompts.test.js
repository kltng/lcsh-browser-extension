import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  SUGGEST_FIXED, DEFAULT_RULES, SELECT_FIXED, SUGGESTION_COUNT_HINT, SUGGESTION_COUNT_HINTS, RULES_PRECEDENCE,
  buildSuggestPrompt, buildSuggestFixed, buildSelectPrompt, buildBibliographicText
} from '../prompts';

const FORBIDDEN = /verif|validat|API ID|URL|MARC|identifier/i;

describe('[P4 row3] suggest: prompt static check (§3)', () => {
  it('neither SUGGEST_FIXED nor DEFAULT_RULES asks for identifiers, URLs, MARC, validation or verification', () => {
    expect(SUGGEST_FIXED).not.toMatch(FORBIDDEN);
    expect(DEFAULT_RULES).not.toMatch(FORBIDDEN);
    for (const hint of SUGGESTION_COUNT_HINTS) expect(buildSuggestFixed(hint)).not.toMatch(FORBIDDEN);
  });

  it('SUGGEST_FIXED asks for LCSH-style headings with subdivisions, a kind, a reason, the count hint, and kind name for works about a person', () => {
    expect(SUGGEST_FIXED).toContain('Library of Congress Subject Headings');
    expect(SUGGEST_FIXED).toContain('subdivisions');
    expect(SUGGEST_FIXED).toContain('about 3 to 6 headings');
    expect(SUGGEST_FIXED).toMatch(/ABOUT a person or an organization gets a heading of kind "name"/);
    for (const kind of ['topical', 'geographic', 'name', 'genre']) expect(SUGGEST_FIXED).toContain(`"${kind}"`);
    expect(SUGGEST_FIXED).toContain('short reason');
  });

  it('SUGGESTION_COUNT_HINT defaults to "3 to 6"; "up to 8" is the other allowed value', () => {
    expect(SUGGESTION_COUNT_HINT).toBe('3 to 6');
    expect(SUGGESTION_COUNT_HINTS).toEqual(['3 to 6', 'up to 8']);
    expect(buildSuggestFixed('up to 8')).toContain('about up to 8 headings');
  });

  it('the system prompt = SUGGEST_FIXED + the fixed precedence sentence + the user rules', () => {
    const { system, userText } = buildSuggestPrompt({ title: 'Cats', author: 'Tanaka', abstract: 'About cats.' }, 'MY RULES');
    expect(system).toBe(`${SUGGEST_FIXED}\n\nCataloging rules from the user (follow them unless they conflict with the instructions above):\nMY RULES`);
    expect(RULES_PRECEDENCE).toBe('\n\nCataloging rules from the user (follow them unless they conflict with the instructions above):\n');
    expect(userText).toContain('Title: Cats\nAuthor: Tanaka\nAbstract: About cats.');
    expect(buildSuggestPrompt({}, 'R', { countHint: 'up to 8' }).system).toContain('about up to 8 headings');
  });

  it('DEFAULT_RULES keeps the cataloging guidance and drops the count line', () => {
    expect(DEFAULT_RULES).toContain('most specific heading');
    expect(DEFAULT_RULES).toContain('chronological subdivisions');
    expect(DEFAULT_RULES).not.toMatch(/1-6|3-4/);
  });

  it('the select prompt lists s{n}c{m} ids with label, authority and match class, and no URIs or IDs', () => {
    const { system, userText } = buildSelectPrompt({ title: 'Cats' }, [{
      suggestionId: 's1', heading: 'Cats', kind: 'topical',
      candidates: [{ pid: 's1c1', label: 'Cats', authority: 'lcsh', matchClass: 'exact-full', uri: 'http://id.loc.gov/x', cid: 'lcsh:sh85021262' }]
    }]);
    expect(system).toBe(SELECT_FIXED);
    expect(userText).toContain('s1: "Cats" (kind: topical)');
    expect(userText).toContain('  s1c1: Cats [LCSH; exact-full]');
    expect(userText).not.toMatch(/id\.loc\.gov|sh85021262/);
    expect(buildBibliographicText({})).toBe('Title: N/A\nAuthor: N/A');
  });

  it('prompts.js and schemas.js import in plain Node (ESM, no browser globals)', () => {
    const dir = path.resolve(__dirname, '..');
    const script = [
      `const p = await import(${JSON.stringify(path.join(dir, 'prompts.js'))});`,
      `const s = await import(${JSON.stringify(path.join(dir, 'schemas.js'))});`,
      'console.log(JSON.stringify({ hint: p.SUGGESTION_COUNT_HINT, suggest: Object.keys(s.SUGGEST_SCHEMA.properties), fixed: typeof p.SUGGEST_FIXED }));'
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(JSON.parse(out.trim().split('\n').pop())).toEqual({ hint: '3 to 6', suggest: ['subjectAnalysis', 'suggestions'], fixed: 'string' });
  });
});
