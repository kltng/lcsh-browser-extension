import React, { useState, useEffect } from 'react';
import {
    Box,
    Typography,
    Paper,
    Button,
    Divider,
    List,
    ListItem,
    ListItemText,
    Chip,
    CircularProgress,
    Alert,
    Card,
    CardContent,
    CardActions
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { scrapeMultipleTerms } from '../services/locService';

const InitialSuggestions = () => {
    const {
        initialSuggestions,
        setActiveStep,
        setScrapedResults,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    // Handle back button
    const handleBack = () => {
        setActiveStep(0);
    };

    // Handle continue button
    const handleContinue = async () => {
        try {
            setIsLoading(true);

            // Scrape LOC website for each candidate term
            const scrapedResults = await scrapeMultipleTerms(initialSuggestions.candidateTerms);

            // Store the scraped results in the context
            setScrapedResults(scrapedResults);

            // Move to the next step
            setActiveStep(2);
        } catch (err) {
            setError(err.message || 'Failed to scrape LOC website');
            console.error('Error scraping LOC website:', err);
        } finally {
            setIsLoading(false);
        }
    };

    // If there are no initial suggestions, show a message
    if (!initialSuggestions || !initialSuggestions.candidateTerms) {
        return (
            <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary">
                    No suggestions available. Please go back and generate suggestions first.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleBack}
                    sx={{ mt: 2 }}
                >
                    Back to Bibliographic Information
                </Button>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                Initial LCSH Suggestions
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            <Card variant="outlined" sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="subtitle1" gutterBottom>
                        Subject Analysis
                    </Typography>
                    <Typography variant="body2" color="text.secondary" paragraph>
                        {initialSuggestions.subjectAnalysis}
                    </Typography>
                </CardContent>
            </Card>

            <Typography variant="subtitle1" gutterBottom>
                Candidate Terms for Validation
            </Typography>

            <List>
                {initialSuggestions.candidateTerms.map((term, index) => (
                    <ListItem key={index} divider>
                        <ListItemText primary={term} />
                    </ListItem>
                ))}
            </List>

            <Box sx={{ mt: 4 }}>
                <Typography variant="subtitle1" gutterBottom>
                    Raw Response from Gemini API
                </Typography>
                <Paper
                    variant="outlined"
                    sx={{
                        p: 2,
                        maxHeight: '300px',
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.875rem',
                        whiteSpace: 'pre-wrap'
                    }}
                >
                    {initialSuggestions.rawResponse}
                </Paper>
            </Box>

            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
                <Button
                    variant="outlined"
                    color="primary"
                    onClick={handleBack}
                >
                    Back
                </Button>

                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleContinue}
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <>
                            <CircularProgress size={24} sx={{ mr: 1 }} />
                            Scraping LOC Website...
                        </>
                    ) : (
                        'Validate Terms with LOC'
                    )}
                </Button>
            </Box>
        </Box>
    );
};

export default InitialSuggestions; 