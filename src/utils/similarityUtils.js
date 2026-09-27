/**
 * String similarity helpers. P4 uses the distance for the display-only
 * "N% similar spelling" (pipeline/select.js); the colors and labels are used
 * only to show scores saved by older versions.
 */

/**
 * Levenshtein distance between two strings, counted in Unicode code points.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Levenshtein distance
 */
export const levenshteinDistance = (a, b) => {
  const x = [...String(a ?? '')];
  const y = [...String(b ?? '')];
  let prev = Array.from({ length: x.length + 1 }, (_, i) => i);
  for (let j = 1; j <= y.length; j++) {
    const row = [j];
    for (let i = 1; i <= x.length; i++) {
      const substitutionCost = x[i - 1] === y[j - 1] ? 0 : 1;
      row[i] = Math.min(row[i - 1] + 1, prev[i] + 1, prev[i - 1] + substitutionCost);
    }
    prev = row;
  }
  return prev[x.length];
};

/**
 * Get a color based on a similarity score
 * @param {number} score - Similarity score (0-100)
 * @returns {string} - Color code
 */
export const getSimilarityColor = (score) => {
  if (score >= 90) return '#4caf50'; // Green
  if (score >= 70) return '#8bc34a'; // Light Green
  if (score >= 50) return '#ffc107'; // Amber
  if (score >= 30) return '#ff9800'; // Orange
  return '#f44336'; // Red
};

/**
 * Get a text label based on a similarity score
 * @param {number} score - Similarity score (0-100)
 * @returns {string} - Text label
 */
export const getSimilarityLabel = (score) => {
  if (score >= 90) return 'Excellent Match';
  if (score >= 70) return 'Good Match';
  if (score >= 50) return 'Moderate Match';
  if (score >= 30) return 'Poor Match';
  return 'No Match';
};

export default {
  levenshteinDistance,
  getSimilarityColor,
  getSimilarityLabel
};
