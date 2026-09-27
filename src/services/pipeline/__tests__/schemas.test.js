import { describe, it, expect } from 'vitest';
import { SUGGEST_SCHEMA, SELECT_SCHEMA } from '../schemas';
import { assertSchema, validate, toGeminiSchema, toAnthropicSchema, countNullableUnions, ANTHROPIC_MAX_NULLABLE_UNIONS } from '../../providers/schema';

describe('[P4 row3] suggest: SUGGEST_SCHEMA / SELECT_SCHEMA (SPEC-P3 §4.2 subset)', () => {
  it('both pass assertSchema and every provider preflight', () => {
    for (const schema of [SUGGEST_SCHEMA, SELECT_SCHEMA]) {
      expect(() => assertSchema(schema)).not.toThrow();
      expect(() => toGeminiSchema(schema)).not.toThrow();
      expect(() => toAnthropicSchema(schema)).not.toThrow();
      expect(countNullableUnions(schema)).toBeLessThanOrEqual(ANTHROPIC_MAX_NULLABLE_UNIONS);
    }
  });

  it('SUGGEST_SCHEMA bounds', () => {
    const ok = { subjectAnalysis: 'x', suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }] };
    expect(validate(SUGGEST_SCHEMA, ok).ok).toBe(true);
    expect(validate(SUGGEST_SCHEMA, { ...ok, suggestions: [] }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, suggestions: Array(9).fill(ok.suggestions[0]) }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, subjectAnalysis: '' }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, subjectAnalysis: 'x'.repeat(1201) }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, suggestions: [{ heading: 'x'.repeat(201), kind: 'topical', reason: '' }] }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, suggestions: [{ heading: 'Cats', kind: 'unknown', reason: '' }] }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, suggestions: [{ heading: 'Cats', kind: 'name', reason: 'r'.repeat(301) }] }).ok).toBe(false);
    expect(validate(SUGGEST_SCHEMA, { ...ok, extra: 1 }).ok).toBe(false);
  });

  it('SELECT_SCHEMA bounds', () => {
    const ok = { selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 85 }], additional: [] };
    expect(validate(SELECT_SCHEMA, ok).ok).toBe(true);
    expect(validate(SELECT_SCHEMA, { selections: [], additional: [] }).ok).toBe(true);
    expect(validate(SELECT_SCHEMA, { ...ok, additional: Array(4).fill({ choice: 's1c2', confidence: 1 }) }).ok).toBe(false);
    expect(validate(SELECT_SCHEMA, { ...ok, selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 101 }] }).ok).toBe(false);
    expect(validate(SELECT_SCHEMA, { ...ok, selections: [{ suggestionId: 's1', choice: 's1c1', confidence: 8.5 }] }).ok).toBe(false);
    expect(validate(SELECT_SCHEMA, { ...ok, selections: [{ suggestionId: 's123456789', choice: 'none', confidence: 1 }] }).ok).toBe(false);
    expect(validate(SELECT_SCHEMA, { ...ok, selections: [{ suggestionId: 's1', choice: 'x'.repeat(13), confidence: 1 }] }).ok).toBe(false);
  });
});
