import { describe, it, expect } from 'vitest';
import { toCandidate, parseSuggestBody } from '../hit';
import { createLocApiBackend } from '../locApi';
import { createScheduler, createRunCache } from '../scheduler';
import { response } from '../../../../test/setup';
import { hit, EVIDENCE, mockLoc, fastSchedulerOptions } from '../../../../test/locFixtures';

const good = () => hit('lcsh', 'sh85021262', 'Cats', { marcKey: '150 0$aCats', rdftypes: ['Topic'] });

describe('[P4 row4] hit.js: accepted hits', () => {
  it('builds the Candidate from a valid hit', () => {
    expect(toCandidate(good(), 'lcsh')).toEqual({
      cid: 'lcsh:sh85021262', authority: 'lcsh', localId: 'sh85021262',
      uri: 'http://id.loc.gov/authorities/subjects/sh85021262', label: 'Cats',
      marcKey: '150 0$aCats', rdfTypes: ['Topic'], source: 'loc-api'
    });
  });

  it('`more` absent → empty metadata; missing/empty marcKeys → marcKey null; rdfTypes []', () => {
    const { more, ...bare } = good();
    expect(toCandidate(bare, 'lcsh')).toMatchObject({ marcKey: null, rdfTypes: [] });
    expect(toCandidate({ ...bare, more: { marcKeys: [] } }, 'lcsh')).toMatchObject({ marcKey: null });
  });

  it('marcKey = marcKeys[0], with no rescue from later keys', () => {
    expect(toCandidate({ ...good(), more: { marcKeys: ['150  $aCats', '180  $xCats'] } }, 'lcsh').marcKey).toBe('150  $aCats');
    expect(toCandidate({ ...good(), more: { marcKeys: ['180  $xCats', '150  $aCats'] } }, 'lcsh')).toBeNull();
  });

  it('accepts a token with a -NNN suffix and every evidence heading row', () => {
    expect(toCandidate(EVIDENCE.japanName, 'lcnaf')).not.toBeNull();
    for (const [name, authority] of [['chinaMing', 'lcsh'], ['kurosawa', 'lcnaf'], ['biographicalFilms', 'lcgft'], ['historyTopic', 'lcsh']]) {
      expect(toCandidate(EVIDENCE[name], authority), name).not.toBeNull();
    }
    expect(toCandidate(hit('lcnaf', 'n80008522-12', 'X'), 'lcnaf')).not.toBeNull();
  });
});

describe('[P4 row4] hit.js: rejected hits', () => {
  const reject = (h, authority = 'lcsh') => expect(toCandidate(h, authority)).toBeNull();

  it('not an object', () => {
    for (const h of [null, 'Cats', 3, [good()]]) reject(h);
  });

  it('aLabel missing, empty, whitespace-only, not a string or over 500 characters', () => {
    reject({ ...good(), aLabel: undefined });
    reject({ ...good(), aLabel: '' });
    reject({ ...good(), aLabel: ' \t ' });
    reject({ ...good(), aLabel: 42 });
    reject({ ...good(), aLabel: 'x'.repeat(501) });
    expect(toCandidate({ ...good(), aLabel: 'x'.repeat(500), more: {} }, 'lcsh')).not.toBeNull();
  });

  it('a bad token', () => {
    for (const token of ['', 'SH85021262', 'sh', 'abcd123', 'sh8502x', 'sh85021262-', 'sh1-2-3', ' sh1', 12]) {
      reject({ ...good(), token, uri: `http://id.loc.gov/authorities/subjects/${token}` });
    }
  });

  it('a URI mismatch: other token, other authority path, https, extra path', () => {
    reject({ ...good(), uri: 'http://id.loc.gov/authorities/subjects/sh99999999' });
    reject(good(), 'lcnaf');
    reject({ ...good(), uri: 'https://id.loc.gov/authorities/subjects/sh85021262' });
    reject({ ...good(), uri: 'http://id.loc.gov/authorities/subjects/sh85021262.html' });
    reject({ ...good(), uri: undefined });
  });

  it('a malformed `more`', () => {
    for (const more of [null, 'x', [], 5]) reject({ ...good(), more });
  });

  it('non-array or non-string marcKeys', () => {
    for (const marcKeys of ['150  $aCats', {}, [1], [null], null]) reject({ ...good(), more: { marcKeys } });
  });

  it('18X keys (180, 181, 185) are subdivision records', () => {
    reject(EVIDENCE.historySubdivision);
    reject(EVIDENCE.japanSubdivision, 'lcnaf');
    reject({ ...good(), more: { marcKeys: ['185  $vCats'] } });
  });

  it('the Subdivisions collection, or malformed collections', () => {
    reject({ ...good(), more: { marcKeys: ['150  $aCats'], collections: ['http://id.loc.gov/authorities/subjects/collection_Subdivisions'] } });
    reject({ ...good(), more: { collections: 'collection_LCSH_General' } });
    reject({ ...good(), more: { collections: [3] } });
    expect(toCandidate({ ...good(), more: { collections: ['http://id.loc.gov/authorities/subjects/collection_TopicSubdivisionsX'] } }, 'lcsh')).not.toBeNull();
  });

  it('malformed rdftypes', () => {
    reject({ ...good(), more: { rdftypes: 'Topic' } });
    reject({ ...good(), more: { rdftypes: [{}] } });
  });
});

describe('[P4 row4] hit.js: response bodies', () => {
  it('counts rejected hits', () => {
    const body = JSON.stringify({ hits: [good(), EVIDENCE.historySubdivision, { junk: true }] });
    const parsed = parseSuggestBody(body, 'lcsh');
    expect(parsed.ok).toBe(true);
    expect(parsed.candidates.map((c) => c.cid)).toEqual(['lcsh:sh85021262']);
    expect(parsed.rejectedHits).toBe(2);
  });

  it.each([['a non-JSON body', '<html>busy</html>'], ['hits not an array', '{"hits":{}}'], ['no hits', '{}'], ['a JSON array', '[]'], ['null', 'null']])(
    '%s → not ok',
    (_, body) => {
      expect(parseSuggestBody(body, 'lcsh')).toEqual({ ok: false });
    }
  );

  it('a non-JSON body marks that request failed (invalid_output)', async () => {
    mockLoc({ 'lcsh leftanchored "Cats"': response('<html>maintenance</html>') });
    const backend = createLocApiBackend({ scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache() });
    const raw = await backend.lookup({ id: 's1', heading: 'Cats', kind: 'topical' });
    expect(raw.failures[0]).toBe('invalid_output');
  });
});
