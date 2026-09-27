import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  QUERY_TEXT, QUERY_NAMES, AUTHORITY_QUERIES, AUTHORITY_ORDER_QUERIES, buildQuery, buildMatch, AUTHORITY_ALLOWLIST
} from '../sql';
import FIXTURE from '../__fixtures__/schema_queries.json';

const sha256Hex = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

describe('[P5 row1] sql.js reproduces the lead-owned query text byte for byte', () => {
  it('every query has the pinned sha256 and the pinned text', () => {
    expect(Object.keys(FIXTURE.queries).sort()).toEqual([...QUERY_NAMES].sort());
    for (const [name, pinned] of Object.entries(FIXTURE.queries)) {
      expect(QUERY_TEXT[name], name).toBe(pinned.sql);
      expect(sha256Hex(QUERY_TEXT[name]), name).toBe(pinned.sha256);
    }
  });

  it('the placeholders are present exactly once in the queries that take them', () => {
    for (const name of AUTHORITY_QUERIES) expect(QUERY_TEXT[name].split(':authorities')).toHaveLength(2);
    // Q3a/Q3b order by bm25, so the lead-owned text has no <authority order>.
    for (const name of AUTHORITY_ORDER_QUERIES) expect(QUERY_TEXT[name].split('<authority order>')).toHaveLength(2);
    for (const name of ['Q3a', 'Q3b', 'Q4', 'Q5']) expect(QUERY_TEXT[name]).not.toContain('<authority order>');
    for (const name of ['Q4', 'Q5']) expect(QUERY_TEXT[name]).not.toContain(':authorities');
  });
});

describe('[P5 row1] buildQuery expands only the two placeholders and binds everything else', () => {
  it('Q1 with one authority', () => {
    const { sql, params } = buildQuery('Q1', { authorities: ['lcsh'], text: 'cats' });
    expect(sql).toContain('AND authority IN (?2)');
    expect(sql).toContain('ORDER BY deprecated ASC, CASE authority WHEN ?2 THEN 0 ELSE 1 END, uri ASC');
    expect(params).toEqual(['cats', 'lcsh']);
  });

  it('Q2 with three authorities keeps the caller routing order', () => {
    const { sql, params } = buildQuery('Q2', { authorities: ['lcnaf', 'lcsh', 'lcgft'], text: 'cats' });
    expect(sql).toContain('AND a.authority IN (?2,?3,?4)');
    expect(sql).toContain('CASE authority WHEN ?2 THEN 0 WHEN ?3 THEN 1 WHEN ?4 THEN 2 ELSE 3 END');
    expect(params).toEqual(['cats', 'lcnaf', 'lcsh', 'lcgft']);
  });

  it('Q3b binds the authority list and keeps the bm25 order of the contract', () => {
    const { sql, params } = buildQuery('Q3b', { authorities: ['lcnaf', 'lcsh', 'lcgft'], text: '"a" "b"' });
    expect(sql).toContain('WHERE a.authority IN (?2,?3,?4)');
    expect(sql).toContain('ORDER BY score ASC, a.deprecated ASC, a.uri ASC');
    expect(params).toEqual(['"a" "b"', 'lcnaf', 'lcsh', 'lcgft']);
  });

  it('Q4 and Q5 bind an integer auth id and are unchanged', () => {
    for (const name of ['Q4', 'Q5']) {
      const built = buildQuery(name, { authId: 7 });
      expect(built.sql).toBe(QUERY_TEXT[name]);
      expect(built.params).toEqual([7]);
      expect(() => buildQuery(name, { authId: '7' })).toThrow();
    }
  });

  it('rejects unknown queries, unknown or duplicate authorities and non-string text', () => {
    expect(() => buildQuery('Q9', { authorities: ['lcsh'], text: 'x' })).toThrow();
    expect(() => buildQuery('Q1', { authorities: ['lcsh; DROP TABLE auth'], text: 'x' })).toThrow();
    expect(() => buildQuery('Q1', { authorities: ['lcsh', 'lcsh'], text: 'x' })).toThrow();
    expect(() => buildQuery('Q1', { authorities: [], text: 'x' })).toThrow();
    expect(() => buildQuery('Q1', { authorities: ['lcsh'], text: null })).toThrow();
    expect(AUTHORITY_ALLOWLIST).toEqual(['lcsh', 'lcgft', 'lcnaf']);
  });
});

describe('[P5 row2] the Q3 MATCH builder', () => {
  it('normalizes, drops --, quotes each token and joins with single spaces', () => {
    expect(buildMatch('Motion pictures--Japan--History')).toBe('"motion" "pictures" "japan" "history"');
    expect(buildMatch('Japan – History')).toBe('"japan" "history"');
    expect(buildMatch('Kurosawa, Akira, 1910-1998.')).toBe('"kurosawa" "akira" "1910" "1998"');
  });

  it('drops duplicate tokens, keeping the first occurrence order', () => {
    expect(buildMatch('cats and cats and dogs')).toBe('"cats" "and" "dogs"');
  });

  it('keeps at most the first 12 tokens', () => {
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const match = buildMatch(text);
    expect(match.split(' ')).toHaveLength(12);
    expect(match.startsWith('"w0" "w1"')).toBe(true);
    expect(match.endsWith('"w11"')).toBe(true);
  });

  it('no token → null, so Q3 does not run', () => {
    expect(buildMatch(' -- . ')).toBeNull();
    expect(buildMatch('')).toBeNull();
    expect(buildMatch('---')).toBeNull();
    expect(buildMatch('!@#$%^&*()')).toBeNull();
    expect(buildMatch(null)).toBeNull();
  });

  it('a CJK run is one token (the documented tokenizer limitation)', () => {
    expect(buildMatch('日本電影人物志')).toBe('"日本電影人物志"');
    expect(buildMatch('東京 (日本)')).toBe('"東京" "日本"');
  });

  it('never emits an FTS operator from user text', () => {
    expect(buildMatch('cats OR dogs NEAR/2 "x*"')).toBe('"cats" "or" "dogs" "near" "2" "x"');
    expect(buildMatch('label:cats')).toBe('"label" "cats"');
  });
});
