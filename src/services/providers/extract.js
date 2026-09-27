/**
 * Answer text → JSON object (SPEC-P3 §4.2b), and <think> stripping.
 */

/**
 * Remove closed `<think>…</think>` blocks, and an unclosed `<think>` block at the start.
 * @param {string} text - Model answer
 * @returns {string}
 */
export const stripThinkTags = (text) => text
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/^\s*<think>[\s\S]*$/i, '');

const parseObject = (text) => {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (e) {
    return null;
  }
};

/**
 * Find the top-level `{…}` objects with a string- and escape-aware brace counter.
 * @param {string} text - Text to scan
 * @returns {{objects:string[], unclosed:boolean}}
 */
export const scanTopLevelObjects = (text) => {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth > 0 && inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth > 0 && ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) objects.push(text.slice(start, i + 1));
    }
  }
  return { objects, unclosed: depth > 0 };
};

/**
 * Extract exactly one JSON object from a model answer.
 * @param {string} text - Model answer
 * @param {{stripThinkTags?:boolean}} [opts] - Whether to remove reasoning first
 * @returns {object|null} - The object, or null (→ invalid_output)
 */
export const extractJson = (text, { stripThinkTags: strip = false } = {}) => {
  if (typeof text !== 'string') return null;
  const cleaned = (strip ? stripThinkTags(text) : text).trim();
  const whole = parseObject(cleaned);
  if (whole) return whole;

  const fence = cleaned.match(/^```(?:json)?[^\S\n]*\n?([\s\S]*?)\n?```$/i);
  if (fence) {
    const fenced = parseObject(fence[1].trim());
    if (fenced) return fenced;
  }

  const { objects, unclosed } = scanTopLevelObjects(cleaned);
  if (objects.length !== 1 || unclosed) return null;
  return parseObject(objects[0]);
};

export default extractJson;
