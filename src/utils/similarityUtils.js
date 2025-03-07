/**
 * Utility functions for calculating similarity between strings
 */

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Levenshtein distance
 */
export const levenshteinDistance = (a, b) => {
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) {
    matrix[0][i] = i;
  }

  for (let j = 0; j <= b.length; j++) {
    matrix[j][0] = j;
  }

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + substitutionCost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
};

/**
 * Calculate similarity score between two strings (0-100)
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Similarity score (0-100)
 */
export const calculateSimilarity = (a, b) => {
  if (!a || !b) return 0;
  
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  
  // Exact match
  if (aLower === bLower) return 100;
  
  // Calculate Levenshtein distance
  const distance = levenshteinDistance(aLower, bLower);
  
  // Calculate similarity score (0-100)
  const maxLength = Math.max(aLower.length, bLower.length);
  const similarity = Math.max(0, Math.round((1 - distance / maxLength) * 100));
  
  return similarity;
};

/**
 * Find the best match for a term in a list of items
 * @param {string} term - The term to match
 * @param {Array} items - Array of items with heading property
 * @returns {Object} - Best match with similarity score
 */
export const findBestMatch = (term, items) => {
  if (!items || items.length === 0) {
    return { item: null, similarity: 0 };
  }
  
  let bestMatch = null;
  let highestSimilarity = 0;
  
  items.forEach(item => {
    const similarity = calculateSimilarity(term, item.heading);
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = item;
    }
  });
  
  return {
    item: bestMatch,
    similarity: highestSimilarity
  };
};

/**
 * Get a color based on similarity score
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
 * Get a text label based on similarity score
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
  calculateSimilarity,
  findBestMatch,
  getSimilarityColor,
  getSimilarityLabel
}; 