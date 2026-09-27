/**
 * Canonical JSON-Schema subset, local validator and per-provider converters
 * (SPEC-P3 §4.2). No ajv: it uses `new Function`, which MV3 CSP forbids.
 */

const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems',
  'maxItems', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'description'
]);
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const ALL_TYPES = new Set(['object', 'array', ...SCALAR_TYPES]);
const KEYWORDS_BY_TYPE = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  string: ['enum', 'minLength', 'maxLength'],
  integer: ['minimum', 'maximum'],
  number: ['minimum', 'maximum'],
  boolean: []
};
const BOUND_PAIRS = [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']];
const MAX_DEPTH = 5;
const MAX_PROPERTIES = 100;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split a schema `type` into its base type and nullability.
 * @param {string|string[]} type - Schema type
 * @returns {{base:string, nullable:boolean}}
 */
const splitType = (type) => (Array.isArray(type)
  ? { base: type[0], nullable: true }
  : { base: type, nullable: false });

const checkNode = (node, path, depth, state) => {
  if (!isPlainObject(node)) throw new Error(`${path}: a schema must be an object`);
  if (depth > MAX_DEPTH) throw new Error(`${path}: nesting deeper than ${MAX_DEPTH}`);
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) throw new Error(`${path}: keyword "${key}" is not allowed`);
  }
  const { type } = node;
  if (Array.isArray(type)) {
    if (type.length !== 2 || type[1] !== 'null' || !SCALAR_TYPES.has(type[0])) {
      throw new Error(`${path}: a type array must be [scalar, 'null']`);
    }
  } else if (!ALL_TYPES.has(type)) {
    throw new Error(`${path}: unsupported type`);
  }
  const { base, nullable } = splitType(type);
  const allowedHere = new Set(['type', 'description', ...KEYWORDS_BY_TYPE[base]]);
  for (const key of Object.keys(node)) {
    if (!allowedHere.has(key)) throw new Error(`${path}: "${key}" is not allowed on ${base}`);
  }
  if ('description' in node && typeof node.description !== 'string') {
    throw new Error(`${path}: description must be a string`);
  }
  for (const [lo, hi] of BOUND_PAIRS) {
    for (const key of [lo, hi]) {
      if (key in node && (!Number.isInteger(node[key]) || node[key] < 0)) {
        throw new Error(`${path}: ${key} must be a non-negative integer`);
      }
    }
    if (lo in node && hi in node && node[lo] > node[hi]) {
      throw new Error(`${path}: ${lo} is greater than ${hi}`);
    }
  }
  if ('enum' in node) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0) throw new Error(`${path}: enum must be a non-empty array`);
    if (values.some((v) => !(typeof v === 'string' || (nullable && v === null)))) {
      throw new Error(`${path}: enum values must be strings${nullable ? ' or null' : ''}`);
    }
    if (values.every((v) => v === null)) throw new Error(`${path}: enum contains only null`);
  }
  if (base === 'object') {
    if (!isPlainObject(node.properties)) throw new Error(`${path}: an object needs properties`);
    if (node.additionalProperties !== false) throw new Error(`${path}: an object needs additionalProperties:false`);
    const keys = Object.keys(node.properties);
    const required = node.required;
    if (!Array.isArray(required) || required.length !== keys.length
      || new Set(required).size !== required.length
      || !required.every((k) => keys.includes(k))) {
      throw new Error(`${path}: required must list exactly the property keys`);
    }
    state.properties += keys.length;
    if (state.properties > MAX_PROPERTIES) throw new Error(`more than ${MAX_PROPERTIES} properties`);
    for (const key of keys) checkNode(node.properties[key], `${path}.${key}`, depth + 1, state);
  }
  if (base === 'array') {
    if (!('items' in node)) throw new Error(`${path}: an array needs items`);
    checkNode(node.items, `${path}[]`, depth + 1, state);
  }
};

/**
 * Throw if `schema` is outside the canonical subset. Run it when a schema module loads.
 * @param {object} schema - Canonical schema
 * @returns {object} - The same schema
 */
export const assertSchema = (schema) => {
  if (!isPlainObject(schema) || schema.type !== 'object') {
    throw new Error('Schema root must be {type:"object"}');
  }
  checkNode(schema, '$', 1, { properties: 0 });
  return schema;
};

const typeMatches = (base, value) => {
  switch (base) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
};

const validateNode = (node, value, path, errors) => {
  const { base, nullable } = splitType(node.type);
  if (value === null && nullable) {
    // A nullable enum accepts null only when the enum lists null.
    if (node.enum && !node.enum.includes(null)) errors.push(`${path}: not an allowed value`);
    return;
  }
  if (!typeMatches(base, value)) {
    errors.push(`${path}: expected ${base}${nullable ? ' or null' : ''}`);
    return;
  }
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: not an allowed value`);
  if (base === 'string') {
    const length = [...value].length;
    if ('minLength' in node && length < node.minLength) errors.push(`${path}: too short`);
    if ('maxLength' in node && length > node.maxLength) errors.push(`${path}: too long`);
  }
  if (base === 'integer' || base === 'number') {
    if ('minimum' in node && value < node.minimum) errors.push(`${path}: below minimum`);
    if ('maximum' in node && value > node.maximum) errors.push(`${path}: above maximum`);
  }
  if (base === 'array') {
    if ('minItems' in node && value.length < node.minItems) errors.push(`${path}: too few items`);
    if ('maxItems' in node && value.length > node.maxItems) errors.push(`${path}: too many items`);
    value.forEach((item, i) => validateNode(node.items, item, `${path}[${i}]`, errors));
  }
  if (base === 'object') {
    // Own properties only: inherited names such as `constructor` or `toString` do not count.
    for (const key of node.required) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(node.properties, key)) errors.push(`${path}.${key}: not allowed`);
      else validateNode(node.properties[key], value[key], `${path}.${key}`, errors);
    }
  }
};

/**
 * Validate a value against a canonical schema.
 * @param {object} schema - Canonical schema
 * @param {any} value - Value to check
 * @returns {{ok:boolean, errors:string[]}}
 */
export const validate = (schema, value) => {
  const errors = [];
  validateNode(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
};

/**
 * Convert a canonical schema to Gemini's responseSchema (OpenAPI subset).
 * @param {object} schema - Canonical schema
 * @returns {object}
 */
export const toGeminiSchema = (schema) => {
  const { base, nullable } = splitType(schema.type);
  const out = { type: base.toUpperCase() };
  if (nullable) out.nullable = true;
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.properties) {
    out.properties = {};
    for (const [key, sub] of Object.entries(schema.properties)) out.properties[key] = toGeminiSchema(sub);
  }
  if (schema.required) out.required = [...schema.required];
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.enum) out.enum = schema.enum.filter((v) => v !== null);
  if (schema.minItems !== undefined) out.minItems = schema.minItems;
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
  return out;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Convert a canonical schema for Anthropic structured outputs. Unsupported
 * constraints are removed and described in plain words instead.
 * @param {object} schema - Canonical schema
 * @returns {object}
 */
export const toAnthropicSchema = (schema) => {
  const out = {};
  const notes = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      out.properties = {};
      for (const [prop, sub] of Object.entries(value)) out.properties[prop] = toAnthropicSchema(sub);
    } else if (key === 'items') {
      out.items = toAnthropicSchema(value);
    } else if (key === 'minLength') {
      notes.push(`At least ${plural(value, 'character')}.`);
    } else if (key === 'maxLength') {
      notes.push(`At most ${plural(value, 'character')}.`);
    } else if (key === 'minimum') {
      notes.push(`Minimum value ${value}.`);
    } else if (key === 'maximum') {
      notes.push(`Maximum value ${value}.`);
    } else if (key === 'maxItems') {
      notes.push(`At most ${plural(value, 'item')}.`);
    } else if (key === 'minItems' && value > 1) {
      notes.push(`At least ${plural(value, 'item')}.`);
    } else if (key !== 'description') {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  const description = [schema.description, ...notes].filter(Boolean).join(' ');
  if (description) out.description = description;
  return out;
};

/**
 * Count the nullable union types (`[T,'null']`) in a schema.
 * @param {object} schema - Canonical schema
 * @returns {number}
 */
export const countNullableUnions = (schema) => {
  let count = Array.isArray(schema.type) ? 1 : 0;
  if (schema.properties) {
    for (const sub of Object.values(schema.properties)) count += countNullableUnions(sub);
  }
  if (schema.items) count += countNullableUnions(schema.items);
  return count;
};

/** Anthropic allows at most this many nullable union types per schema. */
export const ANTHROPIC_MAX_NULLABLE_UNIONS = 16;

/** Schema used by Test connection (SPEC-P3 §4.2). */
export const TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['analysis', 'terms'],
  properties: {
    analysis: { type: 'string', minLength: 1, maxLength: 400 },
    terms: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      required: ['heading', 'kind', 'confidence', 'uri'],
      properties: {
        heading: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: ['topical', 'name', 'geographic', 'genre'] },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
        uri: { type: ['string', 'null'], maxLength: 300 }
      } } }
  }
};

assertSchema(TEST_SCHEMA);

export default { assertSchema, validate, toGeminiSchema, toAnthropicSchema, TEST_SCHEMA };
