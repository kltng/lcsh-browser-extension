# Privacy Policy - LCSH Recommendation Tool

Last Updated: January 9, 2026

## Introduction

The LCSH Recommendation Tool is a Chrome extension designed to assist librarians and catalogers in generating Library of Congress Subject Headings (LCSH) for bibliographic materials. This privacy policy explains how we handle, store, and protect your data.

## Data We Collect

### Bibliographic Information
When you use this extension, you may provide the following bibliographic information:
- Title of the work
- Author name
- Abstract or summary
- Table of contents
- Additional notes

### Images
You may upload images of:
- Book covers
- Title pages
- Other bibliographic materials

### API Key
You must provide your personal Gemini API key to use this extension's AI features.

### Conversation History
The extension saves your conversation history locally, including:
- Bibliographic information provided
- Generated LCSH recommendations
- Similarity scores
- MARC records

## How We Use Your Data

### AI Processing
Your bibliographic information and uploaded images are sent to the Google Gemini API to generate subject heading suggestions. We use the Gemini 2.5 Flash model for this purpose.

### Data Validation
The extension queries the Library of Congress website (id.loc.gov) to validate and verify suggested subject headings against official LCSH records.

### Local Processing
All similarity score calculations, MARC record generation, and recommendation filtering are performed locally within the extension.

## Data Storage

### Chrome Local Storage
All data is stored locally on your device using Chrome's local storage:
- Your Gemini API key
- System prompt rules
- Conversation history

### Image Handling
**Important:** Full image data is NOT saved in conversation history to protect your privacy and save storage space. Only image metadata (name, type, size) is preserved.

### No Server Storage
We do not store any of your data on our servers. All processing occurs either locally on your device or through third-party APIs that you authorize.

## Third-Party Services

### Google Gemini API
- **Purpose:** Generate LCSH suggestions using AI
- **Data Sent:** Bibliographic information and images you provide
- **Privacy Policy:** [Google AI Privacy Policy](https://policies.google.com/privacy)
- **Your API Key:** Your personal API key is stored locally and used directly to authenticate with Google. We do not have access to your API key or your Google account.

### Library of Congress
- **Purpose:** Validate and verify LCSH terms
- **Data Sent:** Suggested subject headings (not your original bibliographic information)
- **Privacy Policy:** [Library of Congress Privacy Policy](https://www.loc.gov/legal/privacy-policy/)
- **Note:** The Library of Congress website may collect standard web analytics data when the extension makes requests.

## Data Sharing

We do not sell, rent, or share your data with any third parties for marketing or advertising purposes. Your data is only shared with:

1. **Google Gemini API** - For generating suggestions (requires your API key)
2. **Library of Congress** - For validating subject headings (public website queries)

## Data Retention

Your data remains stored on your device until you:
- Clear your conversation history using the extension's built-in feature
- Uninstall the Chrome extension
- Clear Chrome browser data

## Your Rights

You have the right to:
- **Access:** View your stored conversation history anytime
- **Delete:** Remove individual conversations or clear all history
- **Export:** Export recommendations to CSV format
- **Revoke:** Remove your API key or uninstall the extension at any time

## Security Measures

- **API Key Storage:** Your Gemini API key is stored securely in Chrome's local storage
- **No Data Transmission:** We do not transmit your data to any servers other than the authorized third-party APIs
- **Image Privacy:** Full image data is not saved, only metadata
- **Local Processing:** Sensitive operations occur locally on your device

## Children's Privacy

This extension is not intended for children under 13. We do not knowingly collect personal information from children under 13.

## Changes to This Privacy Policy

We may update this privacy policy from time to time. We will notify you of any material changes by updating the date at the top of this policy.

## Contact Us

If you have questions about this privacy policy or our data practices, please contact us through the extension's GitHub repository:

**Repository:** [LCSH Recommendation Tool on GitHub](https://github.com/yourusername/lcsh-recommendation-tool)

## Third-Party Links

This extension may contain links to external websites (e.g., id.loc.gov for LCSH records). We are not responsible for the privacy practices of these external sites. We encourage you to read the privacy policies of any third-party websites you visit.

---

**Summary:** Your data is stored locally on your device and only shared with Google's Gemini API (using your personal API key) and the Library of Congress website for validation purposes. We do not store your data on our servers or share it for marketing purposes.
