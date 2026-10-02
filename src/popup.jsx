import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material';
import appTheme from './theme';
import PopupLauncher from './components/PopupLauncher';

const container = document.getElementById('root');
const root = createRoot(container);
// SPEC-UI2 §11, §12: the popup uses the same theme as the app
root.render(
  <ThemeProvider theme={appTheme}>
    <PopupLauncher />
  </ThemeProvider>
);
