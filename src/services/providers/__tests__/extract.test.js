import { describe, it, expect } from 'vitest';
import { extractJson, stripThinkTags, scanTopLevelObjects } from '../extract';

describe('[row 6] extract', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it('parses fenced JSON (```json and bare ```)', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"b":[1,2]}\n```')).toEqual({ b: [1, 2] });
  });

  it('finds one object in prose around it', () => {
    expect(extractJson('Here is the result:\n{"a": {"b": 2}}\nHope this helps!')).toEqual({ a: { b: 2 } });
  });

  it('ignores braces inside strings', () => {
    expect(extractJson('Answer: {"text": "a } and { b", "n": 1} done')).toEqual({ text: 'a } and { b', n: 1 });
  });

  it('removes closed <think> blocks when asked', () => {
    const text = '<think>maybe {"wrong":true}</think>\n{"right":true}';
    expect(extractJson(text, { stripThinkTags: true })).toEqual({ right: true });
    // Without stripping, two objects are found → no choice is made.
    expect(extractJson(text)).toBeNull();
  });

  it('removes an unclosed <think> block at the start', () => {
    expect(stripThinkTags('<think>still thinking {"a":1}')).toBe('');
    expect(extractJson('<think>still thinking {"a":1}', { stripThinkTags: true })).toBeNull();
    expect(stripThinkTags('  <think>a</think>OK')).toBe('  OK');
  });

  it('returns null when there is no JSON', () => {
    expect(extractJson('No JSON here.')).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson(null)).toBeNull();
    expect(extractJson('[1, 2, 3]')).toBeNull();
  });
});

describe('[row 22] extraction', () => {
  it('handles escaped quotes and backslashes inside strings', () => {
    const text = 'Result: {"q": "she said \\"{hi}\\"", "path": "C:\\\\dir\\\\{x}"} end';
    expect(extractJson(text)).toEqual({ q: 'she said "{hi}"', path: 'C:\\dir\\{x}' });
  });

  it('rejects two objects (never chooses)', () => {
    expect(extractJson('{"a":1} and {"b":2}')).toBeNull();
    expect(scanTopLevelObjects('{"a":1} {"b":2}').objects).toHaveLength(2);
  });

  it('accepts one object with trailing garbage', () => {
    expect(extractJson('{"a":1} trailing words ]]')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}}}')).toEqual({ a: 1 });
  });

  it('rejects an unclosed second object and a broken object', () => {
    expect(extractJson('{"a":1} {"b":')).toBeNull();
    expect(extractJson('note {"a": 1,} end')).toBeNull();
  });

  it('parses fenced JSON with surrounding whitespace', () => {
    expect(extractJson('\n\n```JSON\n{"a": "x"}\n```\n')).toEqual({ a: 'x' });
  });
});
