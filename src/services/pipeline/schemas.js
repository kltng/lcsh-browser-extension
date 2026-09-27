/**
 * JSON schemas of the two AI steps, in the SPEC-P3 §4.2 canonical subset.
 * Importable in plain Node (ESM; no browser globals at import time).
 */
import { assertSchema } from '../providers/schema.js';

/** Step 1 (§3). */
export const SUGGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subjectAnalysis', 'suggestions'],
  properties: {
    subjectAnalysis: { type: 'string', minLength: 1, maxLength: 1200 },
    suggestions: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'kind', 'reason'],
        properties: {
          heading: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['topical', 'geographic', 'name', 'genre'] },
          reason: { type: 'string', minLength: 0, maxLength: 300 }
        }
      }
    }
  }
};

/** Step 3 (§5.1). */
export const SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['selections', 'additional'],
  properties: {
    selections: {
      type: 'array',
      minItems: 0,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['suggestionId', 'choice', 'confidence'],
        properties: {
          suggestionId: { type: 'string', minLength: 1, maxLength: 8 },
          choice: { type: 'string', minLength: 1, maxLength: 12 },
          confidence: { type: 'integer', minimum: 0, maximum: 100 }
        }
      }
    },
    additional: {
      type: 'array',
      minItems: 0,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['choice', 'confidence'],
        properties: {
          choice: { type: 'string', minLength: 1, maxLength: 12 },
          confidence: { type: 'integer', minimum: 0, maximum: 100 }
        }
      }
    }
  }
};

assertSchema(SUGGEST_SCHEMA);
assertSchema(SELECT_SCHEMA);
