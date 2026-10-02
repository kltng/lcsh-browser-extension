/**
 * SPEC-UI2 §11 (contrast) and §12 (button text): ratio tests for the colour
 * pairs the app and the popup actually use, composited over their real
 * backgrounds, and rendered checks that the components use those colours.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@mui/material';
import { decomposeColor, getLuminance, lighten, darken, alpha } from '@mui/material/styles';
import { appTheme, CHIP_TEXT_ON_SCORE } from '../../theme';
import { getSimilarityColor } from '../../utils/similarityUtils';
import AppContext from '../../context/AppContext';
import ConversationHistory from '../ConversationHistory';
import { PopupView } from '../PopupLauncher';
import { V110_ENTRY } from '../../../test/pipelineFixtures';

const { palette } = appTheme;
const WHITE = '#ffffff';
const AA_NORMAL = 4.5;

/** Composite a colour (maybe with alpha) over an opaque background. */
const over = (color, background) => {
  const fg = decomposeColor(color);
  const bg = decomposeColor(background);
  const a = fg.values[3] ?? 1;
  const mix = [0, 1, 2].map((i) => Math.round(fg.values[i] * a + bg.values[i] * (1 - a)));
  return `rgb(${mix.join(', ')})`;
};

/** WCAG 2.1 contrast ratio of a (maybe translucent) text colour on its background. */
const ratio = (text, background) => {
  const a = getLuminance(over(text, background));
  const b = getLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// The backgrounds text is shown on (each composited over the white paper).
const SELECTED_ROW = over(alpha(palette.primary.main, palette.action.selectedOpacity), WHITE);
const SELECTED_HOVER_ROW = over(
  alpha(palette.primary.main, palette.action.selectedOpacity + palette.action.hoverOpacity), WHITE
);
const HOVER_ROW = over(palette.action.hover, WHITE);
const ENTRY_HEADER = over('rgba(0, 0, 0, 0.03)', WHITE);
const CHIP_FILLED = over(palette.action.selected, WHITE);
const IMAGE_BOX = '#f5f5f5';
const TEXT_BACKGROUNDS = {
  white: WHITE, selectedRow: SELECTED_ROW, selectedHoverRow: SELECTED_HOVER_ROW, hoverRow: HOVER_ROW,
  entryHeader: ENTRY_HEADER, filledChip: CHIP_FILLED, imageBox: IMAGE_BOX
};

describe('[UI2 §11] contrast of the supported palette (app and popup share one theme)', () => {
  it('body and secondary text (captions, helper text, "Current choice") on every background they appear on', () => {
    for (const name of ['primary', 'secondary']) {
      for (const [where, bg] of Object.entries(TEXT_BACKGROUNDS)) {
        expect([name, where, ratio(palette.text[name], bg) >= AA_NORMAL]).toEqual([name, where, true]);
      }
    }
  });

  it('status text: each colour on the backgrounds where the app uses it', () => {
    const pairs = [
      // Settings provider list: the ✓ Configured / Available mark sits in a row that may be selected
      ['success.dark', palette.success.dark, ['white', 'selectedRow', 'selectedHoverRow', 'hoverRow']],
      // "Installed ✓" in the local database panel
      ['success.main', palette.success.main, ['white']],
      // History: the unverified-MARC caption of an old entry
      ['warning.dark', palette.warning.dark, ['white', 'hoverRow']],
      // Inline errors and the error helper text of fields
      ['error.main', palette.error.main, ['white']],
      // Links and the selected step label
      ['primary.main', palette.primary.main, ['white', 'selectedRow', 'selectedHoverRow', 'hoverRow', 'imageBox']]
    ];
    for (const [name, colour, places] of pairs) {
      for (const where of places) {
        expect([name, where, ratio(colour, TEXT_BACKGROUNDS[where]) >= AA_NORMAL]).toEqual([name, where, true]);
      }
    }
  });

  it('the old primary blue failed on its hover tint and on a selected row', () => {
    expect(palette.primary.main).toBe('#1565c0');
    const old = '#1976d2';
    expect(ratio(old, over(alpha(old, palette.action.hoverOpacity), WHITE))).toBeLessThan(AA_NORMAL);
    expect(ratio(old, over(alpha(old, palette.action.selectedOpacity), WHITE))).toBeLessThan(AA_NORMAL);
  });

  it('the old warning text colour fails, so it is no longer used for text', () => {
    expect(palette.warning.dark).toBe('#a14b00');
    expect(ratio(palette.warning.main, WHITE)).toBeLessThan(AA_NORMAL);
    expect(ratio(palette.warning.dark, WHITE)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('enabled contained, outlined and text buttons', () => {
    for (const name of ['primary', 'secondary', 'error', 'success']) {
      const p = palette[name];
      expect([name, 'contained', ratio(p.contrastText, p.main) >= AA_NORMAL]).toEqual([name, 'contained', true]);
      expect([name, 'contained hover', ratio(p.contrastText, p.dark) >= AA_NORMAL]).toEqual([name, 'contained hover', true]);
      // Outlined/text buttons: the main colour on white and on their hover tint
      const hover = over(alpha(p.main, palette.action.hoverOpacity), WHITE);
      expect([name, 'outlined', ratio(p.main, WHITE) >= AA_NORMAL]).toEqual([name, 'outlined', true]);
      expect([name, 'outlined hover', ratio(p.main, hover) >= AA_NORMAL]).toEqual([name, 'outlined hover', true]);
    }
  });

  it('standard alerts (error, warning, info, success): the text on the tinted background', () => {
    for (const name of ['error', 'warning', 'info', 'success']) {
      const text = darken(palette[name].light, 0.6);
      const bg = lighten(palette[name].light, 0.9);
      expect([name, ratio(text, bg) >= AA_NORMAL]).toEqual([name, true]);
      // A text button inside the alert uses color="inherit"
    }
  });

  it('the legacy similarity chip: its text colour on every score colour (white failed)', () => {
    const scores = [95, 75, 55, 35, 10];
    expect(scores.some((s) => ratio(WHITE, getSimilarityColor(s)) < AA_NORMAL)).toBe(true);
    for (const s of scores) {
      expect([s, ratio(CHIP_TEXT_ON_SCORE, getSimilarityColor(s)) >= AA_NORMAL]).toEqual([s, true]);
    }
  });
});

const renderHistory = (entries) => renderToString(React.createElement(
  ThemeProvider, { theme: appTheme },
  React.createElement(AppContext.Provider, {
    value: {
      conversationHistory: entries,
      deleteConversation: vi.fn(async () => {}),
      clearConversationHistory: vi.fn(async () => {}),
      setActiveStep: vi.fn(),
      setBibliographicInfo: vi.fn(),
      error: null,
      setError: vi.fn()
    }
  }, React.createElement(ConversationHistory))
)).replace(/<!-- -->/g, '');

describe('[UI2 §11] rendered states use the checked colours', () => {
  it('an old history entry: the unverified-MARC caption and the score chip', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderHistory([V110_ENTRY]);
    errors.mockRestore();
    const css = (html.match(/<style[\s\S]*?<\/style>/g) || []).join('\n').toLowerCase();
    const rules = css.match(/[^{}]+\{[^{}]*\}/g) || [];
    expect(rules.some((r) => r.includes('color:#a14b00'))).toBe(true);
    // The old warning orange is left only on the alert icon (an icon, not text)
    const orange = rules.filter((r) => /(^|[;{])color:#ed6c02/.test(r));
    expect(orange.every((r) => r.includes('muialert-icon'))).toBe(true);
    // The 90% score chip: black text on the green
    expect(rules.some((r) => r.includes('background-color:#4caf50') && r.includes(`color:${CHIP_TEXT_ON_SCORE}`))).toBe(true);
    expect(rules.some((r) => r.includes('background-color:#4caf50') && r.includes('color:white'))).toBe(false);
  });
});

describe('[UI2 §12] sentence-case buttons in the app and the popup', () => {
  it('the shared theme does not transform button text', () => {
    expect(appTheme.components.MuiButton.styleOverrides.root.textTransform).toBe('none');
  });

  it('the app and the popup entry points both use the shared theme', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(read('app.jsx')).toMatch(/import appTheme from '\.\/theme'/);
    expect(read('app.jsx')).not.toContain('createTheme(');
    expect(read('popup.jsx')).toMatch(/import appTheme from '\.\/theme'/);
    expect(read('popup.jsx')).toMatch(/<ThemeProvider theme=\{appTheme\}>/);
  });

  it('the popup renders "Open LCSH tool" without upper-casing', () => {
    const html = renderToString(React.createElement(ThemeProvider, { theme: appTheme },
      React.createElement(PopupView, { state: { status: 'ready', label: 'Ready' }, onOpen: () => {}, onSettings: () => {} })));
    const buttons = html.split('<button').slice(1);
    expect(buttons.some((b) => b.includes('>Open LCSH tool<'))).toBe(true);
    // MUI writes its default first; the theme's later declaration wins in each button rule
    const buttonRules = (html.match(/\.css-[a-z0-9]+-MuiButton-root\{[^}]*\}/g) || []);
    expect(buttonRules.length).toBeGreaterThan(0);
    for (const rule of buttonRules) {
      const transforms = rule.match(/text-transform:[a-z]+/g);
      expect(transforms[transforms.length - 1]).toBe('text-transform:none');
    }
  });

  it('history buttons and dialog titles are sentence case', () => {
    const html = renderHistory([V110_ENTRY]);
    expect(html).toContain('Start new search');
    expect(html).toContain('Clear all history');
    expect(html).not.toMatch(/Start New Search|Clear All History/);
    expect(renderHistory([])).toContain('Start new search');
  });
});
