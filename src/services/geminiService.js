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
You are a library cataloging expert specializing in MARC records for Library of Congress Subject Headings (LCSH).

I will provide you with a list of validated LCSH terms along with their identifiers and similarity scores. 
These terms are the best matches found in the Library of Congress database.
For each term with a similarity score above 30%, please generate a MARC record specifically for field 650 (Topical Terms).

Please follow these guidelines:
1. Only generate MARC records for terms with similarity scores above 30%
2. Focus ONLY on field 650 (Topical Terms) - do not include other fields
3. Include all necessary indicators and subfields for field 650
4. Be precise and follow cataloging standards
5. Format each record clearly

For each term, provide ONLY the MARC field 650 record in the following format:
\`\`\`marc
650 [indicators] $a [Main heading] $x [Subdivision] $z [Geographic subdivision] $y [Chronological subdivision]
\`\`\`

Only include the subfields that are necessary for each term. Do not include any explanations, justifications, or additional text outside the MARC record format.
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
    // Use Gemini 2.0 Flash model instead of Gemini 1.5 Pro Vision
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Failed to generate LCSH suggestions');
    }

    const data = await response.json();
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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Failed to generate MARC records');
    }

    const data = await response.json();
    
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