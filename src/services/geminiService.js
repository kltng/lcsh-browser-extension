const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * Call the Gemini API with exponential backoff retry for transient errors
 * @param {string} apiKey - The Gemini API key
 * @param {object} requestBody - The request body
 * @param {number} maxRetries - Maximum number of retries (default 2)
 * @returns {Promise<object>} - The API response data
 */
const callGeminiWithRetry = async (apiKey, requestBody, maxRetries = 2) => {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        return await response.json();
      }

      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;

      // Don't retry client errors (400, 401, 403) — only retry 429 and 5xx
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Gemini API error (${response.status}): ${errorMessage}`);
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      // Non-retryable error
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid or expired API key. Please check your Gemini API key in the extension popup.');
      }
      throw new Error(errorMessage);
    } catch (error) {
      if (error.message?.includes('Invalid or expired API key')) throw error;
      if (error.message?.includes('Gemini API error')) {
        lastError = error;
        continue;
      }
      // Network error
      lastError = new Error(`Network error: ${error.message}. Check your internet connection.`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
  }

  throw lastError || new Error('Failed after retries');
};

// Fixed output format part of the system prompt
const FIXED_OUTPUT_FORMAT = `
### Output Format Instructions

Please provide your LCSH recommendations in the following structured format:

### **Subject Analysis**  
[Brief analysis of the work's subject matter and why certain subject areas are relevant]

---

### **API Validation Process**  
I will validate the following candidate LCSH terms using the API:  
1. **[Term 1]**  
2. **[Term 2]**  
[etc.]  

Now calling the API to verify these terms…  

---

### **Recommended LCSH Terms**  

1. **[LCSH Term 1]** (✓ Verified by API)  
   - **MARC:**
   \`\`\`marc
   [MARC format of the heading]
   \`\`\`
   - **API ID:** [LC identifier]  
   - **URL:** [LCSH Record URL]  
   - **Justification:** [Brief explanation of why this heading is appropriate]

2. **[LCSH Term 2]** (✓ Verified by API)  
   [Same format as above]
   
[etc.]

---

### **Special Considerations**  
[Any additional notes about the headings, potential alternatives, or special cases to consider]
`;

// MARC record generation prompt
const MARC_RECORD_PROMPT = `
You are a library cataloging expert specializing in MARC records for Library of Congress Subject Headings (LCSH) and Name Authority File (LCNAF).

I will provide you with a list of validated terms along with their identifiers, similarity scores, and source authority.
For each term, generate the appropriate MARC field record based on the source and the nature of the heading:
- LCSH geographic names (where the entry element in $a is a place/region/country): use field 651 (Subject Added Entry - Geographic Name)
- LCSH topical terms (non-geographic entry element): use field 650 (Subject Added Entry - Topical Term)
- LCNAF personal names: use field 600 (Subject Added Entry - Personal Name)
- LCNAF corporate names: use field 610 (Subject Added Entry - Corporate Name)

Important: If the $a subfield is a geographic entity (e.g., a country, city, region like "Japan", "United States", "Paris"), use 651 even if the term has topical subdivisions like $x History or $x Economic conditions. The field is determined by the nature of the entry element in $a, not the subdivisions.

Indicators: The first indicator is blank (space). The second indicator MUST be 0 for all headings sourced from LCSH or LCNAF (Library of Congress authorities). For example: 651 _0, 650 _0, 600 10, 610 20.

Please follow these guidelines:
1. Only generate MARC records for terms with similarity scores above 30%
2. Use the correct MARC field based on the source (651 for LCSH geographic, 650 for LCSH topical, 600/610 for LCNAF)
3. Include all necessary indicators and subfields with second indicator 0
4. Be precise and follow cataloging standards
5. Format each record clearly

For each term, provide ONLY the MARC record in the following format:
\`\`\`marc
[field] [indicators] $a [Main heading] $x [General subdivision] $z [Geographic subdivision] $y [Chronological subdivision]
\`\`\`
Examples: 651 _0 $a Japan $x History $y 1868-, 650 _0 $a Economic development, 600 10 $a Gordon, Andrew.

Only include the subfields that are necessary for each term. Do not include any explanations or additional text outside the MARC record format.
`;

/**
 * Constructs the complete system prompt by combining user-editable rules with fixed output format
 * @param {string} userRules - The user-editable rules portion of the system prompt
 * @returns {string} - The complete system prompt
 */
const constructSystemPrompt = (userRules) => {
  return `${userRules}\n\n${FIXED_OUTPUT_FORMAT}`;
};

/**
 * Sends a request to the Gemini API to generate LCSH suggestions
 * @param {string} apiKey - The Gemini API key
 * @param {object} bibliographicInfo - The bibliographic information
 * @param {string} systemPromptRules - The user-editable rules portion of the system prompt
 * @returns {Promise<object>} - The API response
 */
export const generateLcshSuggestions = async (apiKey, bibliographicInfo, systemPromptRules) => {
  const systemPrompt = constructSystemPrompt(systemPromptRules);
  
  // Construct the request body
  const requestBody = {
    contents: [],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  // Add text content
  const textContent = `
Please suggest Library of Congress Subject Headings (LCSH) for the following work:

Title: ${bibliographicInfo.title || 'N/A'}
Author: ${bibliographicInfo.author || 'N/A'}
${bibliographicInfo.abstract ? `Abstract: ${bibliographicInfo.abstract}` : ''}
${bibliographicInfo.tableOfContents ? `Table of Contents: ${bibliographicInfo.tableOfContents}` : ''}
${bibliographicInfo.notes ? `Additional Notes: ${bibliographicInfo.notes}` : ''}
  `;

  // Create the user message parts
  const parts = [{ text: textContent }];

  // Add image parts if available
  if (bibliographicInfo.images && bibliographicInfo.images.length > 0) {
    bibliographicInfo.images.forEach(image => {
      parts.push({
        inlineData: {
          mimeType: image.type,
          data: image.data.split(',')[1] // Remove the data URL prefix
        }
      });
    });
  }

  // Add the user message to the contents
  requestBody.contents.push({
    role: "user",
    parts: parts
  });

  try {
    const data = await callGeminiWithRetry(apiKey, requestBody);
    return data;
  } catch (error) {
    console.error('Error generating LCSH suggestions:', error);
    throw error;
  }
};

/**
 * Generates MARC records for high-scoring best LOC matches
 * @param {string} apiKey - The Gemini API key
 * @param {Array} recommendations - The recommendations with similarity scores and best matches
 * @returns {Promise<object>} - The API response with MARC records
 */
export const generateMarcRecords = async (apiKey, recommendations) => {
  // Filter recommendations with similarity score > 30 and that have a best match
  const highScoringTerms = recommendations.filter(rec => 
    rec.similarity > 30 && rec.bestMatch
  );
  
  if (highScoringTerms.length === 0) {
    return { marcRecords: {} };
  }
  
  // Prepare the prompt with the high-scoring best matches
  const termsPrompt = highScoringTerms.map(rec =>
    `Term: ${rec.bestMatch.heading}
ID: ${rec.bestMatch.identifier || rec.apiId || 'N/A'}
Source: ${(rec.bestMatch.source || 'lcsh').toUpperCase()}
Similarity Score: ${rec.similarity}%
`).join('\n');
  
  // Construct the request body
  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ 
          text: `${MARC_RECORD_PROMPT}\n\nHere are the validated LCSH terms:\n\n${termsPrompt}` 
        }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  try {
    const data = await callGeminiWithRetry(apiKey, requestBody);
    
    // Parse the response to extract MARC records
    const marcRecords = parseMarcRecords(data, highScoringTerms);
    
    return { marcRecords };
  } catch (error) {
    console.error('Error generating MARC records:', error);
    throw error;
  }
};

/**
 * Parse the Gemini API response to extract MARC records
 * @param {object} response - The Gemini API response
 * @param {Array} terms - The high-scoring terms with best matches
 * @returns {object} - Object mapping term to MARC record
 */
const parseMarcRecords = (response, terms) => {
  try {
    const content = response.candidates[0].content.parts[0].text;
    const marcRecords = {};
    
    // Extract MARC records for each term
    terms.forEach(term => {
      // Use a simple regex to find code blocks with "marc" language
      const marcBlockRegex = /```marc\s+([\s\S]*?)```/g;
      let match;
      let found = false;
      
      while ((match = marcBlockRegex.exec(content)) !== null && !found) {
        const marcRecord = match[1].trim();
        
        // Check if this MARC record is for the current term
        // This is a simple heuristic - we're assuming the records appear in the same order as the terms
        if (!Object.values(marcRecords).includes(marcRecord)) {
          // Store the MARC record with the original term as the key
          marcRecords[term.term] = marcRecord;
          found = true;
        }
      }
      
      // If no MARC record was found for this term, use the original one
      if (!found && term.marc) {
        marcRecords[term.term] = term.marc;
      }
    });
    
    return marcRecords;
  } catch (error) {
    console.error('Error parsing MARC records:', error);
    return {};
  }
};

/**
 * Parses the Gemini API response to extract LCSH suggestions
 * @param {object} response - The Gemini API response
 * @returns {object} - The parsed suggestions
 */
export const parseLcshSuggestions = (response) => {
  try {
    // Extract the text content from the response
    const content = response.candidates[0].content.parts[0].text;
    
    // Extract the candidate terms section
    const apiValidationMatch = content.match(/### \*\*API Validation Process\*\*\s+([\s\S]*?)(?=---)/);
    const candidateTermsText = apiValidationMatch ? apiValidationMatch[1] : '';
    
    // Extract the candidate terms
    const candidateTerms = [];
    const termRegex = /\d+\.\s+\*\*([^*]+)\*\*/g;
    let match;
    
    while ((match = termRegex.exec(candidateTermsText)) !== null) {
      candidateTerms.push(match[1].trim());
    }
    
    // Extract the recommended terms section
    const recommendedTermsMatch = content.match(/### \*\*Recommended LCSH Terms\*\*\s+([\s\S]*?)(?=---)/);
    const recommendedTermsText = recommendedTermsMatch ? recommendedTermsMatch[1] : '';
    
    // Extract the recommended terms with details
    const recommendedTerms = [];
    const sections = recommendedTermsText.split(/\d+\.\s+\*\*/).slice(1);
    
    sections.forEach(section => {
      const termMatch = section.match(/([^*]+)\*\*/);
      if (!termMatch) return;
      
      const term = termMatch[1].trim();
      
      const marcMatch = section.match(/```marc\s+([\s\S]*?)```/);
      const marc = marcMatch ? marcMatch[1].trim() : '';
      
      const apiIdMatch = section.match(/\*\*API ID:\*\*\s+([^\s]+)/);
      const apiId = apiIdMatch ? apiIdMatch[1].trim() : '';
      
      const urlMatch = section.match(/\*\*URL:\*\*\s+\[LCSH Record\]\(([^)]+)\)/);
      const url = urlMatch ? urlMatch[1].trim() : '';
      
      const justificationMatch = section.match(/\*\*Justification:\*\*\s+([^\n]+)/);
      const justification = justificationMatch ? justificationMatch[1].trim() : '';
      
      recommendedTerms.push({
        term,
        marc,
        apiId,
        url,
        justification
      });
    });
    
    // Extract the subject analysis
    const subjectAnalysisMatch = content.match(/### \*\*Subject Analysis\*\*\s+([\s\S]*?)(?=---)/);
    const subjectAnalysis = subjectAnalysisMatch ? subjectAnalysisMatch[1].trim() : '';
    
    // Extract special considerations
    const specialConsiderationsMatch = content.match(/### \*\*Special Considerations\*\*\s+([\s\S]*?)(?=$)/);
    const specialConsiderations = specialConsiderationsMatch ? specialConsiderationsMatch[1].trim() : '';
    
    return {
      subjectAnalysis,
      candidateTerms,
      recommendedTerms,
      specialConsiderations,
      rawResponse: content
    };
  } catch (error) {
    console.error('Error parsing LCSH suggestions:', error);
    throw new Error('Failed to parse LCSH suggestions');
  }
};

export default {
  generateLcshSuggestions,
  parseLcshSuggestions,
  generateMarcRecords
}; 