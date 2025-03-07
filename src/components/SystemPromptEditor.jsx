import React, { useState } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Paper,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Snackbar,
    Alert
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppContext } from '../context/AppContext';

const SystemPromptEditor = () => {
    const {
        systemPromptRules,
        setSystemPromptRules,
        resetSystemPromptRules,
        DEFAULT_SYSTEM_PROMPT_RULES
    } = useAppContext();

    const [expanded, setExpanded] = useState(false);
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('success');

    // Handle accordion expansion
    const handleAccordionChange = (event, isExpanded) => {
        setExpanded(isExpanded);
    };

    // Handle text changes
    const handleTextChange = (e) => {
        setSystemPromptRules(e.target.value);
    };

    // Handle save
    const handleSave = () => {
        // Save to Chrome storage
        chrome.storage.local.set({ systemPromptRules }, () => {
            showSnackbar('System prompt rules saved successfully', 'success');
        });
    };

    // Handle reset
    const handleReset = () => {
        resetSystemPromptRules();
        showSnackbar('System prompt rules reset to default', 'info');
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

    return (
        <Accordion expanded={expanded} onChange={handleAccordionChange}>
            <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls="system-prompt-content"
                id="system-prompt-header"
            >
                <Typography variant="subtitle1">LCSH Selection Rules (Advanced)</Typography>
            </AccordionSummary>
            <AccordionDetails>
                <Box>
                    <Typography variant="body2" color="text.secondary" paragraph>
                        These rules guide the AI in selecting appropriate Library of Congress Subject Headings.
                        Edit them to customize the behavior of the recommendation system.
                    </Typography>

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
                            Reset to Default
                        </Button>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={handleSave}
                        >
                            Save Rules
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
            </AccordionDetails>
        </Accordion>
    );
};

export default SystemPromptEditor; 