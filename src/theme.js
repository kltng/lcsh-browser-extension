/**
 * The ONE theme of the app and the popup (SPEC-UI2 §11, §12).
 *  - §12: buttons keep their sentence-case source labels (no forced capitals).
 *  - §11: every text colour used on a background meets WCAG 2.1 AA; the
 *    supported pairs are checked by contrast.test.js. `warning.dark` is the
 *    colour for warning-coloured TEXT (the default warning orange is about
 *    3:1 on white).
 */
import { createTheme } from '@mui/material/styles';

// The primary blue was #1976d2: 4.60:1 on white but 4.39:1 on its own hover
// tint (text and outlined buttons) and 4.15:1 on a selected row.
export const PALETTE = {
  primary: '#1565c0',
  secondary: '#dc004e',
  warningText: '#a14b00'
};

/** Text on the legacy similarity chip (its background colours come from getSimilarityColor). */
export const CHIP_TEXT_ON_SCORE = '#000000';

export const appTheme = createTheme({
  palette: {
    primary: { main: PALETTE.primary },
    secondary: { main: PALETTE.secondary },
    warning: { main: '#ed6c02', dark: PALETTE.warningText }
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  components: {
    MuiButton: { styleOverrides: { root: { textTransform: 'none' } } }
  }
});

export default appTheme;
