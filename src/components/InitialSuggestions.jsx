import React, { useState } from 'react';
import {
    Box,
    Typography,
    Paper,
    Button,
    List,
    ListItem,
    ListItemText,
    Chip,
    CircularProgress,
    Alert,
    Card,
    CardContent,
    Grid,
    LinearProgress
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { validateMultipleTerms } from '../services/locService';
import ImageIcon from '@mui/icons-material/Image';

const InitialSuggestions = () => {
    const {
        initialSuggestions,
        bibliographicInfo,
        setActiveStep,
        setScrapedResults,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    const [progress, setProgress] = useState({ completed: 0, total: 0 });

    // Handle back button
    const handleBack = () => {
        setActiveStep(0);
    };

    // Handle continue button — now uses API instead of web scraping
    const handleContinue = async () => {
        try {
            setIsLoading(true);
            setError(null);

            const terms = initialSuggestions.candidateTerms;
            setProgress({ completed: 0, total: terms.length });

            // Validate terms using LOC suggest2 API with progress tracking
            const results = await validateMultipleTerms(terms, (completed, total) => {
                setProgress({ completed, total });
            });

            // Store the results in the context
            setScrapedResults(results);

            // Move to the next step
            setActiveStep(2);
        } catch (err) {
            setError(err.message || 'Failed to validate terms with LOC');
            console.error('Error validating terms:', err);
        } finally {
            setIsLoading(false);
            setProgress({ completed: 0, total: 0 });
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

    const progressPercent = progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;

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

            {/* Display bibliographic information summary */}
            <Card variant="outlined" sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="subtitle1" gutterBottom>
                        Bibliographic Information Used
                    </Typography>

                    <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                            <Typography variant="body2">
                                <strong>Title:</strong> {bibliographicInfo.title || 'N/A'}
                            </Typography>
                        </Grid>

                        <Grid item xs={12} sm={6}>
                            <Typography variant="body2">
                                <strong>Author:</strong> {bibliographicInfo.author || 'N/A'}
                            </Typography>
                        </Grid>

                        {bibliographicInfo.abstract && (
                            <Grid item xs={12}>
                                <Typography variant="body2">
                                    <strong>Abstract:</strong> {bibliographicInfo.abstract.substring(0, 100)}
                                    {bibliographicInfo.abstract.length > 100 ? '...' : ''}
                                </Typography>
                            </Grid>
                        )}

                        {bibliographicInfo.images && bibliographicInfo.images.length > 0 && (
                            <Grid item xs={12}>
                                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center' }}>
                                    <ImageIcon fontSize="small" sx={{ mr: 0.5 }} />
                                    <strong>Images:</strong>&nbsp;{bibliographicInfo.images.length} image(s) uploaded
                                </Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                                    {bibliographicInfo.images.map((image, index) => (
                                        <Chip
                                            key={index}
                                            label={image.name || `Image ${index + 1}`}
                                            size="small"
                                            variant="outlined"
                                        />
                                    ))}
                                </Box>
                            </Grid>
                        )}
                    </Grid>
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
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <CircularProgress size={20} sx={{ mr: 1 }} />
                            Validating {progress.completed}/{progress.total} terms...
                        </Box>
                    ) : (
                        'Validate Terms with LOC'
                    )}
                </Button>
            </Box>

            {/* Progress bar during validation */}
            {isLoading && progress.total > 0 && (
                <Box sx={{ mt: 2 }}>
                    <LinearProgress variant="determinate" value={progressPercent} />
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                        Validating term {progress.completed} of {progress.total} via LOC API...
                    </Typography>
                </Box>
            )}
        </Box>
    );
};

export default InitialSuggestions;
