/**
 * Server rendering for component tests (no DOM library): the HTML of a
 * component, without React's `<!-- -->` text separators.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';

/**
 * Render a component to HTML.
 * @param {Function} Component - React component
 * @param {object} [props] - Props
 * @returns {string}
 */
export const renderHtml = (Component, props = {}) => renderToString(React.createElement(Component, props)).replace(/<!-- -->/g, '');

/**
 * The visible text of rendered HTML (tags removed, entities decoded for the common cases).
 * @param {string} html - HTML
 * @returns {string}
 */
export const textOf = (html) => html
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ');
