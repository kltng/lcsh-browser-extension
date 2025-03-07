# LCSH Recommendation Tool - Chrome Extension

A Chrome extension that suggests Library of Congress Subject Headings (LCSH) based on bibliographic information using the Gemini API.

## Features

- Accept a Gemini API key from the user
- Process bibliographic information (title, author, abstract, TOC, etc.)
- Upload and process images of book covers, title pages, or other bibliographic materials
- Generate initial LCSH suggestions using the Gemini 2.0 Flash API
- Scrape results from id.loc.gov for validation
- Calculate similarity scores between suggested terms and LOC results
- Use best LOC matches as final recommendations
- Generate accurate MARC records for field 650 (Topical Terms)
- Display recommendations in descending order of similarity score
- Render markdown content in special considerations
- Analyze and present final LCSH recommendations with explanations
- Save conversation history to local storage with management options

## Installation

### Development Mode

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/lcsh-recommendation-tool.git
   cd lcsh-recommendation-tool
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the extension:
   ```
   npm run build
   ```

4. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right corner
   - Click "Load unpacked" and select the `dist` directory from this project

### Production Mode

The extension will be available on the Chrome Web Store once published.

## Usage

1. Click on the extension icon in your Chrome toolbar
2. Enter your Gemini API key (you can get one from [Google AI Studio](https://ai.google.dev/))
3. Click "Launch LCSH Tool" to open the main application
4. Enter bibliographic information about the work you want to catalog
5. Optionally upload images of book covers, title pages, or other bibliographic materials (PNG and JPEG formats supported)
6. Follow the step-by-step process to generate and validate LCSH recommendations
7. Review similarity scores to evaluate the quality of recommendations
8. View MARC records for high-scoring terms (above 30% similarity)
9. Export or copy the final recommendations for use in your cataloging system

## Image Upload Feature

The extension supports uploading images to enhance the LCSH recommendation process:

- Supported formats: PNG and JPEG
- Multiple images can be uploaded
- Images are processed by the Gemini 2.0 Flash API to extract additional bibliographic information
- Images are not stored on any server - they are processed locally and sent directly to the Gemini API
- For privacy reasons, image data is not saved in the conversation history (only metadata is saved)

## Similarity Score Feature

The extension calculates similarity scores between suggested terms and actual Library of Congress Subject Headings:

- Each suggested term is compared to LOC results using Levenshtein distance algorithm
- Scores range from 0% (no match) to 100% (exact match)
- Visual indicators show the quality of matches (green for excellent, amber for moderate, red for poor)
- An overall validation score is calculated for the entire set of recommendations
- Only terms with similarity scores above 30% are shown in the final recommendations
- Results are sorted by similarity score in descending order
- Similarity scores are included in CSV exports and saved in conversation history

## MARC Record Generation

The extension generates accurate MARC records for high-scoring terms:

- A second round of Gemini inference is used to generate MARC records
- Only terms with similarity scores above 30% are processed
- MARC records are specifically for field 650 (Topical Terms)
- Records include all necessary indicators and subfields
- MARC records can be copied to clipboard with a single click
- Records are included in CSV exports and saved in conversation history

## Best LOC Match Feature

The extension uses the best matches found in the Library of Congress database as the final recommendations:

- Initial suggestions from Gemini are validated against the LOC database
- The best match for each term is identified based on similarity score
- Final recommendations use the actual LOC headings rather than the suggested terms
- LCSH IDs are taken from the LOC database for accurate identification
- Direct links to the LOC website are provided for each term
- Original suggested terms are preserved for reference

## Development

- `npm start` - Start the development server with hot reloading
- `npm run build` - Build the extension for production

## Project Structure

- `src/` - Source code
  - `components/` - React components
  - `context/` - React context for state management
  - `services/` - Services for API calls and data processing
  - `utils/` - Utility functions and algorithms
- `assets/` - Static assets like icons
- `dist/` - Built extension (generated)

## Technologies Used

- React
- Material UI
- Chrome Extension API
- Gemini 2.0 Flash API (with multimodal capabilities for image processing)
- React Markdown for rendering markdown content
- Webpack

## License

MIT

## Acknowledgements

- Library of Congress for providing the LCSH database
- Google for the Gemini API 