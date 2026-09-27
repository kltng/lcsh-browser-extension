import { describe, it, expect } from 'vitest';
import {
  assertSchema, validate, toGeminiSchema, toAnthropicSchema, countNullableUnions, TEST_SCHEMA
} from '../schema';
import { GEMINI_TEST_SCHEMA, ANTHROPIC_TEST_SCHEMA } from '../../../../test/fixtures';

const obj = (properties) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties
});

describe('[row 5] schema: assertSchema', () => {
  it('accepts TEST_SCHEMA', () => {
    expect(assertSchema(TEST_SCHEMA)).toBe(TEST_SCHEMA);
  });

  const nest = (levels) => {
    let node = { type: 'string' };
    for (let i = 0; i < levels; i++) node = obj({ a: node });
    return node;
  };
  const manyProps = (n) => obj(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: 'string' }])));

  it.each([
    ['a null root', null],
    ['an array root', { type: 'array', items: { type: 'string' } }],
    ['a string root', { type: 'string' }],
    ['a forbidden keyword ($ref)', obj({ a: { $ref: '#/x' } })],
    ['a forbidden keyword (pattern)', obj({ a: { type: 'string', pattern: '^a' } })],
    ['anyOf', obj({ a: { anyOf: [{ type: 'string' }] } })],
    ['an object without additionalProperties:false', { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }],
    ['additionalProperties:true', { type: 'object', additionalProperties: true, required: ['a'], properties: { a: { type: 'string' } } }],
    ['required missing a key', { type: 'object', additionalProperties: false, required: [], properties: { a: { type: 'string' } } }],
    ['required with an extra key', { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'string' } } }],
    ['an unknown type', obj({ a: { type: 'date' } })],
    ['the null type alone', obj({ a: { type: 'null' } })],
    ['[object, null]', obj({ a: { type: ['object', 'null'] } })],
    ['[null, string] (wrong order)', obj({ a: { type: ['null', 'string'] } })],
    ['a three-type array', obj({ a: { type: ['string', 'integer', 'null'] } })],
    ['enum on integer', obj({ a: { type: 'integer', enum: [1, 2] } })],
    ['enum containing only null', obj({ a: { type: ['string', 'null'], enum: [null] } })],
    ['null in the enum of a non-nullable string', obj({ a: { type: 'string', enum: ['x', null] } })],
    ['an empty enum', obj({ a: { type: 'string', enum: [] } })],
    ['a negative bound', obj({ a: { type: 'string', maxLength: -1 } })],
    ['a non-integer bound', obj({ a: { type: 'integer', minimum: 0.5 } })],
    ['minLength > maxLength', obj({ a: { type: 'string', minLength: 5, maxLength: 2 } })],
    ['minItems > maxItems', obj({ a: { type: 'array', minItems: 3, maxItems: 1, items: { type: 'string' } } })],
    ['depth greater than 5', nest(5)],
    ['more than 100 properties', manyProps(101)],
    ['an array without items', obj({ a: { type: 'array' } })],
    ['a non-string description', obj({ a: { type: 'string', description: 5 } })]
  ])('rejects %s', (_, schema) => {
    expect(() => assertSchema(schema)).toThrow();
  });

  it('accepts depth 5 and 100 properties', () => {
    expect(() => assertSchema(nest(4))).not.toThrow();
    expect(() => assertSchema(manyProps(100))).not.toThrow();
  });
});

describe('[row 5] schema: validate', () => {
  const valid = {
    analysis: 'A book about cats.',
    terms: [{ heading: 'Cats', kind: 'topical', confidence: 90, uri: null }]
  };
  const term = valid.terms[0];

  it.each([
    ['the canonical valid answer', valid],
    ['a string uri', { ...valid, terms: [{ ...term, uri: 'http://id.loc.gov/x' }] }],
    ['three terms', { ...valid, terms: [term, term, term] }],
    ['confidence 0 and 100', { ...valid, terms: [{ ...term, confidence: 0 }, { ...term, confidence: 100 }] }],
    ['400 code points of CJK text', { ...valid, analysis: '猫'.repeat(400) }],
    ['400 emoji (surrogate pairs count once)', { ...valid, analysis: '🐈'.repeat(400) }]
  ])('accepts %s', (_, value) => {
    expect(validate(TEST_SCHEMA, value)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ['a missing key', { terms: valid.terms }],
    ['an extra key', { ...valid, extra: 1 }],
    ['an empty analysis', { ...valid, analysis: '' }],
    ['401 code points', { ...valid, analysis: '🐈'.repeat(401) }],
    ['zero terms', { ...valid, terms: [] }],
    ['four terms', { ...valid, terms: [term, term, term, term] }],
    ['an enum miss', { ...valid, terms: [{ ...term, kind: 'other' }] }],
    ['a non-integer confidence', { ...valid, terms: [{ ...term, confidence: 90.5 }] }],
    ['confidence above maximum', { ...valid, terms: [{ ...term, confidence: 101 }] }],
    ['a string confidence', { ...valid, terms: [{ ...term, confidence: '90' }] }],
    ['a null heading', { ...valid, terms: [{ ...term, heading: null }] }],
    ['a nested extra key', { ...valid, terms: [{ ...term, note: 'x' }] }],
    ['a nested missing key', { ...valid, terms: [{ heading: 'Cats', kind: 'topical', confidence: 90 }] }],
    ['an array root', [valid]],
    ['null', null]
  ])('rejects %s', (_, value) => {
    const result = validate(TEST_SCHEMA, value);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('checks finite numbers', () => {
    const schema = obj({ n: { type: 'number' } });
    expect(validate(schema, { n: 1.5 }).ok).toBe(true);
    expect(validate(schema, { n: Infinity }).ok).toBe(false);
    expect(validate(schema, { n: NaN }).ok).toBe(false);
  });
});

describe('[row 5] schema: converters', () => {
  it('toGeminiSchema(TEST_SCHEMA) is the exact fixture', () => {
    expect(toGeminiSchema(TEST_SCHEMA)).toEqual(GEMINI_TEST_SCHEMA);
  });

  it('toAnthropicSchema(TEST_SCHEMA) is the exact fixture', () => {
    expect(toAnthropicSchema(TEST_SCHEMA)).toEqual(ANTHROPIC_TEST_SCHEMA);
  });

  it('converters do not change the canonical schema', () => {
    const before = JSON.stringify(TEST_SCHEMA);
    toGeminiSchema(TEST_SCHEMA);
    toAnthropicSchema(TEST_SCHEMA);
    expect(JSON.stringify(TEST_SCHEMA)).toBe(before);
  });

  it('Anthropic keeps minItems 0 and 1 and describes larger ones', () => {
    const schema = obj({
      a: { type: 'array', minItems: 0, items: { type: 'string' } },
      b: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'List.' }
    });
    const out = toAnthropicSchema(schema);
    expect(out.properties.a).toEqual({ type: 'array', minItems: 0, items: { type: 'string' } });
    expect(out.properties.b).toEqual({ type: 'array', items: { type: 'string' }, description: 'List. At least 2 items.' });
  });
});

describe('[row 21] schema extras', () => {
  it('a nullable enum becomes a Gemini wire enum without null', () => {
    const schema = obj({ k: { type: ['string', 'null'], enum: ['a', 'b', null] } });
    expect(() => assertSchema(schema)).not.toThrow();
    expect(toGeminiSchema(schema).properties.k).toEqual({ type: 'STRING', nullable: true, enum: ['a', 'b'] });
    expect(validate(schema, { k: null }).ok).toBe(true);
    expect(validate(schema, { k: 'a' }).ok).toBe(true);
    expect(validate(schema, { k: 'c' }).ok).toBe(false);
  });

  it('counts nullable unions (TEST_SCHEMA passes the Anthropic 16-union preflight)', () => {
    expect(countNullableUnions(TEST_SCHEMA)).toBe(1);
    const seventeen = obj(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }])));
    expect(countNullableUnions(seventeen)).toBe(17);
  });
});

describe('fix-1 #2: validate enforces the full canonical schema', () => {
  it('a nullable enum accepts null only when the enum lists null', () => {
    const withoutNull = obj({ k: { type: ['string', 'null'], enum: ['a'] } });
    expect(validate(withoutNull, { k: null }).ok).toBe(false);
    expect(validate(withoutNull, { k: 'a' }).ok).toBe(true);
    const withNull = obj({ k: { type: ['string', 'null'], enum: ['a', null] } });
    expect(validate(withNull, { k: null }).ok).toBe(true);
    // A nullable string without an enum still accepts null.
    expect(validate(obj({ k: { type: ['string', 'null'] } }), { k: null }).ok).toBe(true);
  });

  it('a required integer named "constructor" is not satisfied by {} (inherited property)', () => {
    const schema = obj({ constructor: { type: 'integer' } });
    expect(() => assertSchema(schema)).not.toThrow();
    expect(validate(schema, {}).ok).toBe(false);
    expect(validate(schema, { constructor: 5 }).ok).toBe(true);
    expect(validate(schema, { constructor: 'x' }).ok).toBe(false);
  });

  it('"toString" is checked as an own property, both as required key and as an extra key', () => {
    const schema = obj({ toString: { type: 'string' } });
    expect(validate(schema, {}).ok).toBe(false);
    expect(validate(schema, { toString: 'ok' }).ok).toBe(true);
    // A schema without toString rejects a value that has it as an own key.
    expect(validate(obj({ a: { type: 'string' } }), { a: 'x', toString: 'y' }).ok).toBe(false);
  });

  it('"__proto__" as a property name (own property, as JSON.parse creates it)', () => {
    const schema = JSON.parse('{"type":"object","additionalProperties":false,"required":["__proto__"],"properties":{"__proto__":{"type":"integer"}}}');
    expect(() => assertSchema(schema)).not.toThrow();
    expect(validate(schema, {}).ok).toBe(false);
    expect(validate(schema, JSON.parse('{"__proto__": 5}')).ok).toBe(true);
    expect(validate(schema, JSON.parse('{"__proto__": "x"}')).ok).toBe(false);
    // An own __proto__ key is an extra key for a schema that does not list it.
    expect(validate(obj({ a: { type: 'string' } }), JSON.parse('{"a":"x","__proto__":{}}')).ok).toBe(false);
  });
});
