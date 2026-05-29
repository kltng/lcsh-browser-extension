import React from 'react';
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
    StepLabel
} from '@mui/material';
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
    'Enter Bibliographic Information',
    'Generate Initial Suggestions',
    'Review Scraped Results',
    'Final Recommendations',
    'Conversation History'
];

// Main App component
const App = () => {
    const { activeStep } = useAppContext();

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
                    <Typography variant="h4" component="h1" gutterBottom align="center">
                        LCSH Recommendation Tool
                    </Typography>

                    <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4 }}>
                        {steps.map((label) => (
                            <Step key={label}>
                                <StepLabel>{label}</StepLabel>
                            </Step>
                        ))}
                    </Stepper>

                    <Box sx={{ mt: 2 }}>
                        {renderStep()}
                    </Box>
                </Paper>

                <Box sx={{ mt: 4 }}>
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
