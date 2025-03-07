# LCSH Recommendation Tool - Chrome Extension

A Chrome extension that suggests Library of Congress Subject Headings (LCSH) based on bibliographic information using the Gemini API.

## Features

- Accept a Gemini API key from the user
- Process bibliographic information (title, author, abstract, TOC, etc.)
- Upload and process images of book covers, title pages, or other bibliographic materials
- Generate initial LCSH suggestions using the Gemini 2.0 Flash API
- Scrape results from id.loc.gov for validation
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
7. Export or copy the final recommendations for use in your cataloging system

## Image Upload Feature

The extension supports uploading images to enhance the LCSH recommendation process:

- Supported formats: PNG and JPEG
- Multiple images can be uploaded
- Images are processed by the Gemini 2.0 Flash API to extract additional bibliographic information
- Images are not stored on any server - they are processed locally and sent directly to the Gemini API
- For privacy reasons, image data is not saved in the conversation history (only metadata is saved)

## Development

- `npm start` - Start the development server with hot reloading
- `npm run build` - Build the extension for production

## Project Structure

- `src/` - Source code
  - `components/` - React components
  - `context/` - React context for state management
  - `services/` - Services for API calls and data processing
  - `utils/` - Utility functions
- `assets/` - Static assets like icons
- `dist/` - Built extension (generated)

## Technologies Used

- React
- Material UI
- Chrome Extension API
- Gemini 2.0 Flash API (with multimodal capabilities for image processing)
- Webpack

## License

MIT

## Acknowledgements

- Library of Congress for providing the LCSH database
- Google for the Gemini API 