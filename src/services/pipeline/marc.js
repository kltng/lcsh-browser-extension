/**
 * Step 4 — MARC (SPEC-P4 §6): a bibliographic 6XX field built by code from
 * the LC authority key of the chosen record. The UI calls it a "MARC field
 * (text form)", never a MARC record.
 */

const TAG_MAP = { 100: '600', 110: '610', 111: '611', 130: '630', 150: '650', 151: '651', 155: '655' };
const FIRST_MUST_BE_A = new Set(['100', '110', '111', '130', '150', '151', '155']);
const DASH_CODES = new Set(['x', 'y', 'z', 'v']);
const BLANK = '_';

const unavailable = (reason) => ({
  status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason
});

/**
 * Parse an authority key: tag, two indicators, subfields in order.
 * @param {string} key - marcKey, e.g. `150  $aCats`
 * @returns {{tag:string, a1:string, a2:string, subfields:Array<[string,string]>}|null}
 */
export const parseMarcKey = (key) => {
  const head = /^(\d{3})(.)(.)\$/.exec(key);
  if (!head) return null;
  const [, tag, a1, a2] = head;
  const parts = key.slice(5).split(/\$([a-z0-9])/);
  if (parts[0] !== '' || parts.length < 3) return null;
  const subfields = [];
  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i];
    const value = parts[i + 1];
    if (!value || value.includes('$')) return null;
    subfields.push([code, value]);
  }
  if (FIRST_MUST_BE_A.has(tag) && subfields[0][0] !== 'a') return null;
  return { tag, a1, a2, subfields };
};

/**
 * The label the subfields spell (§6 step 3): values in parsed order, `--`
 * before $x $y $z $v, a single space before any other code.
 * @param {Array<[string,string]>} subfields - Parsed subfields
 * @returns {string}
 */
export const foldLabel = (subfields) => subfields.reduce((acc, [code, value], i) => {
  if (i === 0) return value;
  return `${acc}${DASH_CODES.has(code) ? '--' : ' '}${value}`;
}, '');

const indicatorsFor = (bibTag, a1, a2) => {
  if (bibTag === '600') return ['0', '1', '3'].includes(a1) ? [a1, '0'] : null;
  if (bibTag === '610' || bibTag === '611') return ['0', '1', '2'].includes(a1) ? [a1, '0'] : null;
  if (bibTag === '630') return /^[0-9]$/.test(a2) ? [a2, '0'] : null;
  if (bibTag === '655') return [BLANK, '7'];
  return [BLANK, '0'];
};

/**
 * Build the MARC field of a candidate, or `unavailable` with the reason of
 * the first failed step.
 * @param {{marcKey:string|null, label:string}} candidate - The chosen Candidate
 * @returns {{status:'from-authority'|'unavailable', tag:string|null, ind1:string|null, ind2:string|null,
 *   subfields:Array<[string,string]>, text:string|null, reason:string|null}}
 */
export const buildMarc = (candidate) => {
  const key = candidate?.marcKey;
  if (typeof key !== 'string' || key === '') return unavailable('no key');
  const parsed = parseMarcKey(key);
  if (!parsed) return unavailable('unparseable key');
  if (foldLabel(parsed.subfields) !== candidate.label) return unavailable('key does not match label');
  const tag = TAG_MAP[parsed.tag];
  if (!tag) return unavailable('unsupported tag');
  const indicators = indicatorsFor(tag, parsed.a1, parsed.a2);
  if (!indicators) return unavailable('bad indicator');
  const [ind1, ind2] = indicators;
  const subfields = parsed.subfields.map(([code, value]) => [code, value]);
  if (tag === '655') subfields.push(['2', 'lcgft']);
  const text = `${tag} ${ind1}${ind2} ${subfields.map(([code, value]) => `$${code} ${value}`).join(' ')}`;
  return { status: 'from-authority', tag, ind1, ind2, subfields, text, reason: null };
};

export default buildMarc;
