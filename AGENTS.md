# AGENTS.md - Developer Guidelines for LCSH Recommendation Tool

This file contains guidelines for agentic coding agents working on this Chrome extension.

## Build Commands

```bash
npm start           # Development build with watch mode and hot reloading
npm run build      # Production build (outputs to dist/)
```

**Note:** This project does not currently have test or lint scripts configured. Before making changes, verify the project structure and test the build succeeds.

## Project Structure

```
src/
├── components/     # React components (PascalCase.jsx)
├── context/        # React Context providers
├── services/       # API integration services
└── utils/          # Utility functions (camelCase.js)
```

## Code Style Guidelines

### Imports

- Import React hooks explicitly: `import React, { useState, useEffect } from 'react';`
- Import Material UI components individually to optimize bundle size:
  ```jsx
  import { Button, TextField, Typography } from '@mui/material';
  import CloudUploadIcon from '@mui/icons-material/CloudUpload';
  ```
- Use named exports for functions/components: `export const MyComponent = () => {}`
- Default exports are acceptable for main exports: `export default MyComponent;`

### Formatting & Style

- Use **2-space indentation** (configured in webpack)
- Always use **semicolons**
- Use consistent spacing around operators and after commas
- Wrap JSX in parentheses when multi-line:
  ```jsx
  return (
    <Box>
      <Typography>Content</Typography>
    </Box>
  );
  ```

### Types

- Use **JSDoc comments** for type annotations in utility functions and services:
  ```javascript
  /**
   * Calculate similarity score between two strings
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} - Similarity score (0-100)
   */
  export const calculateSimilarity = (a, b) => { ... };
  ```
- TypeScript is installed as devDependency but not actively used
- State objects should follow the existing structure in AppContext.jsx

### Naming Conventions

- **Components:** PascalCase (e.g., `BibliographicInfoForm.jsx`, `InitialSuggestions.jsx`)
- **Functions:** camelCase (e.g., `handleInputChange`, `validateForm`, `generateLcshSuggestions`)
- **Constants:** SCREAMING_SNAKE_CASE (e.g., `DEFAULT_SYSTEM_PROMPT_RULES`, `FIXED_OUTPUT_FORMAT`)
- **State variables:** camelCase with `set` prefix for setters (e.g., `apiKey`, `setApiKey`)
- **File names:** PascalCase for components, camelCase for services/utils
- **Event handlers:** Prefix with `handle` (e.g., `handleSubmit`, `handleDelete`)

### React Patterns

- Use **functional components with hooks** exclusively
- Custom hooks should follow `use` prefix (e.g., `useAppContext`)
- State management uses Context API (AppContext.jsx is the single source of truth)
- Use Material UI's `sx` prop for styling:
  ```jsx
  <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5', py: 4 }}>
  ```
- Destructure context values:
  ```jsx
  const { apiKey, setApiKey, error, setError } = useAppContext();
  ```

### Error Handling

- Always use try-catch blocks for async operations
- Set error state with user-friendly messages: `setError('Failed to generate LCSH suggestions')`
- Log errors to console: `console.error('Error generating LCSH suggestions:', err);`
- Use Alert component from MUI to display errors to users:
  ```jsx
  {error && <Alert severity="error">{error}</Alert>}
  ```

### API Integration

- All API calls go through `src/services/geminiService.js`
- Follow the existing pattern of returning parsed data from API responses
- Use the `isLoading` state during async operations
- API key is managed via Chrome storage and AppContext

### Chrome Extension API

- Background script: `src/background.js` handles extension lifecycle
- Content script: `src/contentScript.js` for DOM interaction
- Use `chrome.storage.local` for persistent data
- Use `chrome.runtime.sendMessage` for inter-component communication

### Utility Functions

- Place reusable logic in `src/utils/`
- Export functions individually and provide a default export object
- Include JSDoc comments for all exported functions
- Examples: Levenshtein distance, similarity calculation, color coding

### Testing

- Currently no tests are configured
- When adding tests, check package.json and add appropriate test script

### Adding New Features

1. Create component in `src/components/` following naming convention
2. Add to App.jsx stepper if it's a workflow step
3. Use AppContext for state management
4. Follow Material UI design patterns
5. Add proper error handling and loading states
6. Update conversation history saving if needed (remove large image data)

### Material UI Guidelines

- Use `Box` for layout containers
- Use `Container` for main content wrapper with `maxWidth`
- Use `Paper` for card-like sections
- Use `Grid` for responsive layouts
- Use `Alert` for notifications
- Use `CircularProgress` for loading indicators
- Use theme colors: primary (`#1976d2`), secondary (`#dc004e`)

### Memory Management

- Revoke object URLs after use: `URL.revokeObjectURL(preview)`
- Remove large image data before saving to storage (see AppContext.jsx line 87-93)
- Clean up event listeners in useEffect cleanup functions

### Constants

- Fixed prompts and templates go in `src/services/geminiService.js` (e.g., `FIXED_OUTPUT_FORMAT`)
- Default configurations in AppContext (e.g., `DEFAULT_SYSTEM_PROMPT_RULES`)
