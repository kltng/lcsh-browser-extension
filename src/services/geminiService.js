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
  
  // Construct the user message from bibliographic information
  const userMessage = `
Please suggest Library of Congress Subject Headings (LCSH) for the following work:

Title: ${bibliographicInfo.title || 'N/A'}
Author: ${bibliographicInfo.author || 'N/A'}
${bibliographicInfo.abstract ? `Abstract: ${bibliographicInfo.abstract}` : ''}
${bibliographicInfo.tableOfContents ? `Table of Contents: ${bibliographicInfo.tableOfContents}` : ''}
${bibliographicInfo.notes ? `Additional Notes: ${bibliographicInfo.notes}` : ''}
  `;

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: userMessage }]
      }
    ],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
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
  parseLcshSuggestions
}; 