import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
    CssBaseline,
    ThemeProvider,
    createTheme,
    Box,
    Container,
    Paper,
    Typography,
    Stepper,
    Step,
    StepLabel,
    Button,
    Alert
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import SettingsPage from './components/SettingsPage';
import { AppProvider } from './context/AppContext';
import BibliographicInfoForm from './components/BibliographicInfoForm';
import SystemPromptEditor from './components/SystemPromptEditor';
import InitialSuggestions from './components/InitialSuggestions';
import ScrapedResults from './components/ScrapedResults';
import FinalRecommendations from './components/FinalRecommendations';
import ConversationHistory from './components/ConversationHistory';
import { useAppContext } from './context/AppContext';

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

// Step labels
const steps = [
    'Describe the work',
    'AI suggestions',
    'Matches',
    'Recommendations',
    'History'
];

const SETTINGS_HASH = '#settings';

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

// Main App component
const App = () => {
    const { activeStep, settingsStatus, settingsError } = useAppContext();
    const hash = useHashRoute();
    const showSettings = hash === SETTINGS_HASH;

    // Handle the header Settings button
    const handleOpenSettings = () => {
      window.location.hash = 'settings';
    };

    // Leave Settings and return to the workflow
    const handleCloseSettings = () => {
      window.location.hash = '';
    };

    // Render the current step
    const renderStep = () => {
        switch (activeStep) {
            case 0:
                return <BibliographicInfoForm />;
            case 1:
                return <InitialSuggestions />;
            case 2:
                return <ScrapedResults />;
            case 3:
                return <FinalRecommendations />;
            case 4:
                return <ConversationHistory />;
            default:
                return <BibliographicInfoForm />;
        }
    };

    return (
        <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5', py: 4 }}>
            <Container maxWidth="lg">
                <Paper elevation={3} sx={{ p: 4 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                      <Box sx={{ width: 120 }} />
                      <Typography variant="h4" component="h1" align="center">
                        LCSH Recommendation Tool
                      </Typography>
                      <Box sx={{ width: 120, display: 'flex', justifyContent: 'flex-end' }}>
                        {!showSettings && (
                          <Button variant="outlined" startIcon={<SettingsIcon />} onClick={handleOpenSettings}>
                            Settings
                          </Button>
                        )}
                      </Box>
                    </Box>

                    {settingsStatus === 'error' && (
                      <Alert severity="error" sx={{ my: 2 }}>
                        {settingsError}
                      </Alert>
                    )}

                    {showSettings && <SettingsPage onClose={handleCloseSettings} />}

                    {/* The workflow stays mounted while Settings is open, so no step loses its state */}
                    <Box sx={{ display: showSettings ? 'none' : 'block' }}>
                        <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4, mt: 2 }}>
                            {steps.map((label) => (
                                <Step key={label}>
                                    <StepLabel>{label}</StepLabel>
                                </Step>
                            ))}
                        </Stepper>

                        <Box sx={{ mt: 2 }}>
                            {renderStep()}
                        </Box>
                    </Box>
                </Paper>

                <Box sx={{ mt: 4, display: showSettings ? 'none' : 'block' }}>
                    <SystemPromptEditor />
                </Box>
            </Container>
        </Box>
    );
};

// Wrap the App component with the AppProvider
const AppWithProvider = () => (
    <ThemeProvider theme={theme}>
        <CssBaseline />
        <AppProvider>
            <App />
        </AppProvider>
    </ThemeProvider>
);

// Render the App
const container = document.getElementById('root');
const root = createRoot(container);
root.render(<AppWithProvider />);
