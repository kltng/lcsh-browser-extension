import React, { useState } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Grid,
    Paper,
    Divider,
    Alert,
    CircularProgress
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { generateLcshSuggestions, parseLcshSuggestions } from '../services/geminiService';

const BibliographicInfoForm = () => {
    const {
        bibliographicInfo,
        setBibliographicInfo,
        systemPromptRules,
        apiKey,
        setActiveStep,
        setInitialSuggestions,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    // Handle form input changes
    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setBibliographicInfo({
            ...bibliographicInfo,
            [name]: value
        });
    };

    // Validate form
    const validateForm = () => {
        // At minimum, we need a title
        if (!bibliographicInfo.title.trim()) {
            setError('Title is required');
            return false;
        }

        // Clear any previous errors
        setError(null);
        return true;
    };

    // Handle form submission
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!validateForm()) {
            return;
        }

        try {
            setIsLoading(true);

            // Generate LCSH suggestions using the Gemini API
            const response = await generateLcshSuggestions(
                apiKey,
                bibliographicInfo,
                systemPromptRules
            );

            // Parse the response
            const parsedSuggestions = parseLcshSuggestions(response);

            // Store the suggestions in the context
            setInitialSuggestions(parsedSuggestions);

            // Move to the next step
            setActiveStep(1);
        } catch (err) {
            setError(err.message || 'Failed to generate LCSH suggestions');
            console.error('Error generating LCSH suggestions:', err);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Box component="form" onSubmit={handleSubmit} noValidate>
            <Typography variant="h6" gutterBottom>
                Enter Bibliographic Information
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <TextField
                        required
                        fullWidth
                        label="Title"
                        name="title"
                        value={bibliographicInfo.title}
                        onChange={handleInputChange}
                        variant="outlined"
                        helperText="Required"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Author"
                        name="author"
                        value={bibliographicInfo.author}
                        onChange={handleInputChange}
                        variant="outlined"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Abstract"
                        name="abstract"
                        value={bibliographicInfo.abstract}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="A brief summary of the work"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Table of Contents"
                        name="tableOfContents"
                        value={bibliographicInfo.tableOfContents}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="List of chapters or sections"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Additional Notes"
                        name="notes"
                        value={bibliographicInfo.notes}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="Any other relevant information"
                    />
                </Grid>
            </Grid>

            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="large"
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <>
                            <CircularProgress size={24} sx={{ mr: 1 }} />
                            Generating Suggestions...
                        </>
                    ) : (
                        'Generate LCSH Suggestions'
                    )}
                </Button>
            </Box>
        </Box>
    );
};

export default BibliographicInfoForm; 