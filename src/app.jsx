import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { AppProvider } from './context/AppContext';
import { createLocalDbClient } from './services/localdb/client';
import { createUpdateChecker } from './services/localdb/pointer';
import { localDbUpdateCheck, getSettings } from './services/settings';
import AppShell from './components/AppShell';

// Create a theme
const theme = createTheme({
    palette: {
        primary: {
            main: '#1976d2',
        },
        secondary: {
            main: '#dc004e',
        },
    },
    typography: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
});

// SPEC-P5 §3.1: ONE local-database client per app document, created at module
// level ABOVE the hash-route components, so the workflow and #settings share
// it and hash navigation never terminates it. The popup never creates one.
const localDbOptions = {
  createWorker: () => new Worker(new URL('./services/localdb/worker.js', import.meta.url), { type: 'module' })
};
let localDbClient;
// SPEC-P5 §21: only the fault-injection test build loads the fault helper and
// reads a fault plan, once, from this document's own query. The shipped build
// compiles this branch out and takes the ordinary call below.
if (__LCSH_FAULTS__) {
  const { createDocumentFaults } = require('./services/localdb/faults');
  localDbClient = createLocalDbClient(localDbOptions, createDocumentFaults({ search: window.location.search }));
} else {
  localDbClient = createLocalDbClient(localDbOptions);
}
// The owner Web Lock is requested before the worker exists; a tab that does
// not get it simply uses the Library of Congress online.
localDbClient.start().catch(() => {});

// §4.6: the throttled update check belongs to the DOCUMENT, not to the
// Settings panel — it runs once when the owner page opens, and the validated
// pointer stays available however often Settings is mounted.
const localDbUpdates = createUpdateChecker({
  readCheck: () => localDbUpdateCheck(),
  writeCheck: (value) => localDbUpdateCheck(value)
});
getSettings()
  .then((settings) => localDbUpdates.checkOnOpen(settings.localDb))
  .catch(() => {});

// Track the location hash, so #settings opens the Settings screen
const useHashRoute = () => {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return hash;
};

// Main App component: the frame lives in AppShell (testable without this entry file)
const App = () => {
    const hash = useHashRoute();
    return <AppShell hash={hash} onNavigate={(next) => { window.location.hash = next; }} />;
};

// Wrap the App component with the AppProvider
const AppWithProvider = () => (
    <ThemeProvider theme={theme}>
        <CssBaseline />
        <AppProvider localDbClient={localDbClient} localDbUpdates={localDbUpdates}>
            <App />
        </AppProvider>
    </ThemeProvider>
);

// Render the App
const container = document.getElementById('root');
const root = createRoot(container);
root.render(<AppWithProvider />);
