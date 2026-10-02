import React, { useState } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Snackbar,
    Alert
} from '@mui/material';
import { useAppContext } from '../context/AppContext';

const STALE_RULES_MESSAGE = 'The rules were changed in another tab — reload them. Your text is kept until you reload.';

const SystemPromptEditor = () => {
    const {
        systemPromptRules,
        setSystemPromptRules,
        saveSystemPromptRules,
        resetSystemPromptRules,
        reloadSystemPromptRules,
        systemPromptStale
    } = useAppContext();

    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('success');

    // Handle text changes
    const handleTextChange = (e) => {
        setSystemPromptRules(e.target.value);
    };

    // Handle save
    const handleSave = () => {
      // Save to Chrome storage (through settings.js, key systemPromptRules, stale-base checked)
      saveSystemPromptRules()
        .then((result) => (result.saved
          ? showSnackbar('System prompt rules saved successfully', 'success')
          : showSnackbar(STALE_RULES_MESSAGE, 'warning')))
        .catch(() => showSnackbar('Failed to save system prompt rules', 'error'));
    };

    // Handle reset (same stale rule as save)
    const handleReset = () => {
      resetSystemPromptRules()
        .then((result) => (result.saved
          ? showSnackbar('System prompt rules reset to default', 'info')
          : showSnackbar(STALE_RULES_MESSAGE, 'warning')))
        .catch(() => showSnackbar('Failed to reset system prompt rules', 'error'));
    };

    // Handle reload after a change in another tab
    const handleReload = () => {
      reloadSystemPromptRules().catch(() => showSnackbar('Failed to load system prompt rules', 'error'));
    };

    // Show snackbar
    const showSnackbar = (message, severity) => {
        setSnackbarMessage(message);
        setSnackbarSeverity(severity);
        setSnackbarOpen(true);
    };

    // Handle snackbar close
    const handleSnackbarClose = () => {
        setSnackbarOpen(false);
    };

    // UI round 1b: shown directly inside the Settings section "Selection
    // rules (advanced)", which is its one title (no inner accordion).
    return (
        <Box id="system-prompt-content">
                <Box>
                    <Typography variant="body2" color="text.secondary" paragraph>
                        These rules guide the AI when it suggests Library of Congress Subject Headings.
                        They are added after the fixed instructions of the tool, which win if the two conflict.
                    </Typography>

                    {systemPromptStale && (
                      <Alert
                        severity="warning"
                        sx={{ mb: 2 }}
                        action={<Button color="inherit" size="small" onClick={handleReload}>Reload</Button>}
                      >
                        {STALE_RULES_MESSAGE}
                      </Alert>
                    )}

                    <TextField
                        fullWidth
                        multiline
                        rows={10}
                        variant="outlined"
                        value={systemPromptRules}
                        onChange={handleTextChange}
                        sx={{ mb: 2, fontFamily: 'monospace' }}
                    />

                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                        <Button
                            variant="outlined"
                            color="secondary"
                            onClick={handleReset}
                        >
                            Reset to default
                        </Button>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={handleSave}
                        >
                            Save rules
                        </Button>
                    </Box>
                </Box>

                <Snackbar
                    open={snackbarOpen}
                    autoHideDuration={6000}
                    onClose={handleSnackbarClose}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
                >
                    <Alert onClose={handleSnackbarClose} severity={snackbarSeverity} sx={{ width: '100%' }}>
                        {snackbarMessage}
                    </Alert>
                </Snackbar>
        </Box>
    );
};

export default SystemPromptEditor;
