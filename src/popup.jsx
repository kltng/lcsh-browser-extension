import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Box,
    TextField,
    Button,
    Typography,
    Container,
    Paper,
    FormControlLabel,
    Switch,
    IconButton,
    InputAdornment,
    Snackbar,
    Alert
} from '@mui/material';
import { Visibility, VisibilityOff, Launch } from '@mui/icons-material';

const Popup = () => {
    const [apiKey, setApiKey] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    const [isApiKeyValid, setIsApiKeyValid] = useState(false);
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('success');

    useEffect(() => {
        // Load API key from storage when component mounts
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            if (result.geminiApiKey) {
                setApiKey(result.geminiApiKey);
                setIsApiKeyValid(true);
            }
        });
    }, []);

    const handleSaveApiKey = () => {
        if (!apiKey.trim()) {
            showSnackbar('API key cannot be empty', 'error');
            return;
        }

        // Simple validation - Gemini API keys typically start with "AI"
        if (!apiKey.startsWith('AI')) {
            showSnackbar('Invalid API key format', 'warning');
            return;
        }

        // Save API key to Chrome storage
        chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
            setIsApiKeyValid(true);
            showSnackbar('API key saved successfully', 'success');
        });
    };

    const handleLaunchApp = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    };

    const showSnackbar = (message, severity) => {
        setSnackbarMessage(message);
        setSnackbarSeverity(severity);
        setSnackbarOpen(true);
    };

    const handleCloseSnackbar = () => {
        setSnackbarOpen(false);
    };

    return (
        <Container maxWidth="sm" sx={{ p: 2 }}>
            <Paper elevation={3} sx={{ p: 3 }}>
                <Typography variant="h5" component="h1" gutterBottom align="center">
                    LCSH Recommendation Tool
                </Typography>

                <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                        Gemini API Key
                    </Typography>
                    <TextField
                        fullWidth
                        variant="outlined"
                        size="small"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="Enter your Gemini API key"
                        InputProps={{
                            endAdornment: (
                                <InputAdornment position="end">
                                    <IconButton
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        edge="end"
                                    >
                                        {showApiKey ? <VisibilityOff /> : <Visibility />}
                                    </IconButton>
                                </InputAdornment>
                            ),
                        }}
                    />
                    <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button
                            variant="contained"
                            color="primary"
                            size="small"
                            onClick={handleSaveApiKey}
                        >
                            Save API Key
                        </Button>
                    </Box>
                </Box>

                <Button
                    fullWidth
                    variant="contained"
                    color="primary"
                    size="large"
                    startIcon={<Launch />}
                    onClick={handleLaunchApp}
                    disabled={!isApiKeyValid}
                >
                    Launch LCSH Tool
                </Button>

                {!isApiKeyValid && (
                    <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
                        Please enter and save a valid Gemini API key to continue
                    </Typography>
                )}
            </Paper>

            <Snackbar
                open={snackbarOpen}
                autoHideDuration={6000}
                onClose={handleCloseSnackbar}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                <Alert onClose={handleCloseSnackbar} severity={snackbarSeverity} sx={{ width: '100%' }}>
                    {snackbarMessage}
                </Alert>
            </Snackbar>
        </Container>
    );
};

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<Popup />); 