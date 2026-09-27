import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMarc, parseMarcKey, foldLabel } from '../marc';

const golden = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../__fixtures__/marc_golden.json'), 'utf8'));
const available = golden.cases.filter((c) => c.expectStatus === 'from-authority');
const adversarial = golden.cases.filter((c) => c.expectStatus === 'unavailable');

describe('[P4 row11] marc: golden rows', () => {
  it('the lead fixture has its 29 cases', () => {
    expect(golden.cases).toHaveLength(29);
  });

  it.each(available.map((c) => [c.marcKey, c]))('%s → exact text', (_, c) => {
    const marc = buildMarc({ marcKey: c.marcKey, label: c.label, authority: c.authority });
    expect(marc.status).toBe('from-authority');
    expect(marc.text).toBe(c.expectText);
    expect(marc.reason).toBeNull();
  });

  it('the synthetic 130 4 → 630 40', () => {
    expect(buildMarc({ marcKey: '130 4$aThe example', label: 'The example' }).text).toBe('630 40 $a The example');
  });

  it('structured fields: tag, indicators, subfields in order, $2 lcgft for 655', () => {
    expect(buildMarc({ marcKey: '1001 $aKurosawa, Akira,$d1910-1998', label: 'Kurosawa, Akira, 1910-1998' })).toEqual({
      status: 'from-authority', tag: '600', ind1: '1', ind2: '0',
      subfields: [['a', 'Kurosawa, Akira,'], ['d', '1910-1998']],
      text: '600 10 $a Kurosawa, Akira, $d 1910-1998', reason: null
    });
    expect(buildMarc({ marcKey: '155  $aBiographical films', label: 'Biographical films' })).toMatchObject({
      tag: '655', ind1: '_', ind2: '7', subfields: [['a', 'Biographical films'], ['2', 'lcgft']]
    });
  });
});

describe('[P4 row11] marc: adversarial keys', () => {
  it.each(adversarial.map((c) => [c.marcKey, c.expectReason, c]))('%j → unavailable (%s)', (_, reason, c) => {
    const marc = buildMarc({ marcKey: c.marcKey, label: c.label, authority: c.authority });
    expect(marc).toEqual({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason });
  });

  it('the fixture includes Total $ value and 1009', () => {
    expect(adversarial.map((c) => c.marcKey)).toEqual(expect.arrayContaining(['150  $aTotal $ value', '1009 $aSmith, John']));
  });

  it('more unparseable forms: a non-a first subfield for 150, an uppercase code, an empty later value', () => {
    expect(buildMarc({ marcKey: '150  $xCats', label: 'Cats' }).reason).toBe('unparseable key');
    expect(buildMarc({ marcKey: '150  $ACats', label: 'Cats' }).reason).toBe('unparseable key');
    expect(buildMarc({ marcKey: '150  $aCats$x', label: 'Cats' }).reason).toBe('unparseable key');
    expect(buildMarc({ marcKey: '', label: 'Cats' }).reason).toBe('no key');
    expect(buildMarc({ marcKey: undefined, label: 'Cats' }).reason).toBe('no key');
  });

  it('bad indicators per tag: 610 needs 0/1/2, 630 needs a digit', () => {
    expect(buildMarc({ marcKey: '1103 $aHarvard University', label: 'Harvard University' }).reason).toBe('bad indicator');
    expect(buildMarc({ marcKey: '1113 $aX', label: 'X' }).reason).toBe('bad indicator');
    expect(buildMarc({ marcKey: '130 x$aX', label: 'X' }).reason).toBe('bad indicator');
  });

  it('parse and fold helpers', () => {
    expect(parseMarcKey('151  $aChina$xHistory')).toEqual({ tag: '151', a1: ' ', a2: ' ', subfields: [['a', 'China'], ['x', 'History']] });
    expect(foldLabel([['a', 'Bible.'], ['l', 'English']])).toBe('Bible. English');
    expect(foldLabel([['a', 'A'], ['z', 'B'], ['v', 'C'], ['y', 'D'], ['x', 'E'], ['d', 'F']])).toBe('A--B--C--D--E F');
  });
});
