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

const storageSet = (values, onSuccess, onError) => {
    chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) {
            onError(chrome.runtime.lastError.message || 'Failed to save settings');
            return;
        }

        onSuccess();
    });
};

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
            if (chrome.runtime.lastError) {
                showSnackbar(chrome.runtime.lastError.message || 'Failed to load API key', 'error');
                return;
            }

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

        // Gemini API keys typically start with "AI" and are ~39 chars
        if (!apiKey.startsWith('AI') || apiKey.trim().length < 30) {
            showSnackbar('Invalid API key format. Gemini API keys start with "AI" and are about 39 characters.', 'warning');
            return;
        }

        // Save API key to Chrome storage
        storageSet({ geminiApiKey: apiKey.trim() }, () => {
            setIsApiKeyValid(true);
            showSnackbar('API key saved successfully', 'success');
        }, (message) => {
            showSnackbar(message, 'error');
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

                <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block', textAlign: 'center' }}>
                    v1.1.0 &middot;{' '}
                    <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://www.cataloguer.name/privacy' }); }}
                        style={{ color: 'inherit' }}
                    >
                        Privacy Policy
                    </a>
                </Typography>
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
