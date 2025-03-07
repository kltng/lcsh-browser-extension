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
    CardActions,
    IconButton,
    Snackbar,
    Grid,
    TextField,
    Tooltip,
    Link as MuiLink
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { useAppContext } from '../context/AppContext';
import SimilarityScore from './SimilarityScore';
import { generateMarcRecords } from '../services/geminiService';
import ReactMarkdown from 'react-markdown';

const FinalRecommendations = () => {
    const {
        bibliographicInfo,
        initialSuggestions,
        finalRecommendations,
        setActiveStep,
        saveConversation,
        error,
        setError,
        apiKey,
        isLoading,
        setIsLoading
    } = useAppContext();

    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [selectedRecommendations, setSelectedRecommendations] = useState([]);
    const [averageSimilarity, setAverageSimilarity] = useState(0);
    const [sortedRecommendations, setSortedRecommendations] = useState([]);
    const [marcRecords, setMarcRecords] = useState({});
    const [processingMarc, setProcessingMarc] = useState(false);

    // Sort recommendations and calculate average similarity when component mounts
    useEffect(() => {
        if (finalRecommendations && finalRecommendations.length > 0) {
            // Sort recommendations by similarity score in descending order
            const sorted = [...finalRecommendations].sort((a, b) =>
                (b.similarity || 0) - (a.similarity || 0)
            );
            setSortedRecommendations(sorted);

            // Calculate average similarity
            const validRecommendations = finalRecommendations.filter(rec => rec.similarity !== undefined);
            if (validRecommendations.length > 0) {
                const totalSimilarity = validRecommendations.reduce((sum, rec) => sum + (rec.similarity || 0), 0);
                setAverageSimilarity(Math.round(totalSimilarity / validRecommendations.length));
            }

            // Generate MARC records for high-scoring terms
            generateMarcRecordsForHighScoring(sorted);
        }
    }, [finalRecommendations]);

    // Generate MARC records for high-scoring terms
    const generateMarcRecordsForHighScoring = async (recommendations) => {
        try {
            setProcessingMarc(true);
            const result = await generateMarcRecords(apiKey, recommendations);
            setMarcRecords(result.marcRecords);
        } catch (err) {
            console.error('Error generating MARC records:', err);
            // Don't set error state here to avoid disrupting the UI
        } finally {
            setProcessingMarc(false);
        }
    };

    // Handle back button
    const handleBack = () => {
        setActiveStep(2);
    };

    // Handle save and view history
    const handleSaveAndViewHistory = () => {
        try {
            // Save the conversation to history
            saveConversation({
                bibliographicInfo,
                initialSuggestions,
                finalRecommendations: sortedRecommendations,
                selectedRecommendations: selectedRecommendations.length > 0 ? selectedRecommendations : sortedRecommendations,
                averageSimilarity,
                marcRecords
            });

            // Show success message
            showSnackbar('Conversation saved to history');

            // Move to the history step
            setActiveStep(4);
        } catch (err) {
            setError(err.message || 'Failed to save conversation');
            console.error('Error saving conversation:', err);
        }
    };

    // Handle copy to clipboard
    const handleCopyToClipboard = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => {
                showSnackbar('Copied to clipboard');
            })
            .catch((err) => {
                console.error('Failed to copy:', err);
                showSnackbar('Failed to copy to clipboard', 'error');
            });
    };

    // Handle copy all to clipboard
    const handleCopyAllToClipboard = () => {
        const recommendations = selectedRecommendations.length > 0 ? selectedRecommendations : sortedRecommendations;

        const text = recommendations
            .filter(rec => rec.similarity > 30 && rec.bestMatch)
            .map(rec => {
                const marc = marcRecords[rec.term] || rec.marc;
                return `${rec.bestMatch.heading}\n${marc}\n${rec.justification}\n`;
            }).join('\n');

        handleCopyToClipboard(text);
    };

    // Handle export as CSV
    const handleExportCsv = () => {
        const recommendations = selectedRecommendations.length > 0 ? selectedRecommendations : sortedRecommendations;

        const csvContent = [
            ['LCSH Term', 'MARC Record (Field 650)', 'LCSH ID', 'Justification', 'Similarity Score'],
            ...recommendations
                .filter(rec => rec.similarity > 30 && rec.bestMatch)
                .map(rec => [
                    rec.bestMatch.heading,
                    marcRecords[rec.term] || rec.marc,
                    rec.bestMatch.identifier || 'N/A',
                    rec.justification,
                    rec.similarity || 0
                ])
        ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', 'lcsh_recommendations.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showSnackbar('CSV file downloaded');
    };

    // Show snackbar
    const showSnackbar = (message) => {
        setSnackbarMessage(message);
        setSnackbarOpen(true);
    };

    // Handle snackbar close
    const handleSnackbarClose = () => {
        setSnackbarOpen(false);
    };

    // Toggle recommendation selection
    const toggleRecommendationSelection = (recommendation) => {
        const isSelected = selectedRecommendations.some(rec => rec.term === recommendation.term);

        if (isSelected) {
            setSelectedRecommendations(selectedRecommendations.filter(rec => rec.term !== recommendation.term));
        } else {
            setSelectedRecommendations([...selectedRecommendations, recommendation]);
        }
    };

    // If there are no final recommendations, show a message
    if (!finalRecommendations || finalRecommendations.length === 0) {
        return (
            <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary">
                    No final recommendations available. Please go back and process the scraped results first.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleBack}
                    sx={{ mt: 2 }}
                >
                    Back to Scraped Results
                </Button>
            </Box>
        );
    }

    // Filter recommendations with similarity score > 30 and that have a best match
    const highScoringRecommendations = sortedRecommendations.filter(rec =>
        (rec.similarity || 0) > 30 && rec.bestMatch
    );

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                Final LCSH Recommendations
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            {/* Overall similarity score */}
            <Card variant="outlined" sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="subtitle1" gutterBottom>
                        Overall Validation Score
                    </Typography>
                    <Box sx={{ maxWidth: 400, mx: 'auto', my: 2 }}>
                        <SimilarityScore
                            score={averageSimilarity}
                            label="Average similarity between recommended terms and LOC results"
                            showTooltip={false}
                        />
                    </Box>
                    <Typography variant="body2" color="text.secondary" align="center">
                        This score indicates how well the recommended terms match the actual Library of Congress Subject Headings.
                    </Typography>
                </CardContent>
            </Card>

            <Box sx={{ mb: 3 }}>
                <Typography variant="body2" color="text.secondary" paragraph>
                    Below are the final LCSH recommendations based on the best matches found in the Library of Congress database.
                    Only terms with similarity scores above 30% are shown. Results are sorted by similarity score in descending order.
                    MARC records are specifically for field 650 (Topical Terms).
                </Typography>

                <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                    <Button
                        variant="outlined"
                        startIcon={<ContentCopyIcon />}
                        onClick={handleCopyAllToClipboard}
                    >
                        Copy All
                    </Button>
                    <Button
                        variant="outlined"
                        onClick={handleExportCsv}
                    >
                        Export CSV
                    </Button>
                </Box>
            </Box>

            {processingMarc && (
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                    <CircularProgress size={24} sx={{ mr: 1 }} />
                    <Typography>Generating MARC records for high-scoring terms...</Typography>
                </Box>
            )}

            {highScoringRecommendations.length === 0 ? (
                <Alert severity="warning" sx={{ mb: 3 }}>
                    No recommendations with similarity scores above 30% and valid LOC matches were found. Consider refining your search or using different bibliographic information.
                </Alert>
            ) : (
                <List>
                    {highScoringRecommendations.map((recommendation, index) => {
                        const isSelected = selectedRecommendations.some(rec => rec.term === recommendation.term);
                        const marcRecord = marcRecords[recommendation.term] || recommendation.marc;
                        const bestMatch = recommendation.bestMatch;

                        return (
                            <Paper
                                key={index}
                                variant="outlined"
                                sx={{
                                    mb: 2,
                                    p: 2,
                                    border: isSelected ? '2px solid #1976d2' : '1px solid rgba(0, 0, 0, 0.12)'
                                }}
                            >
                                <Grid container spacing={2}>
                                    <Grid item xs={12} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <Typography variant="h6">
                                                {bestMatch.heading}
                                            </Typography>
                                            {bestMatch.uri && (
                                                <MuiLink
                                                    href={`http://id.loc.gov${bestMatch.uri}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    sx={{ ml: 1 }}
                                                >
                                                    View on LOC
                                                </MuiLink>
                                            )}
                                        </Box>

                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <Tooltip title={`Similarity score: ${recommendation.similarity}%`}>
                                                <Chip
                                                    label={`${recommendation.similarity}% match`}
                                                    color={recommendation.similarity >= 70 ? "success" : recommendation.similarity >= 50 ? "warning" : "error"}
                                                    size="small"
                                                />
                                            </Tooltip>

                                            <Tooltip title="Copy to clipboard">
                                                <IconButton
                                                    size="small"
                                                    onClick={() => handleCopyToClipboard(bestMatch.heading)}
                                                >
                                                    <ContentCopyIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>

                                            <Button
                                                variant={isSelected ? "contained" : "outlined"}
                                                size="small"
                                                onClick={() => toggleRecommendationSelection(recommendation)}
                                            >
                                                {isSelected ? 'Selected' : 'Select'}
                                            </Button>
                                        </Box>
                                    </Grid>

                                    {recommendation.similarity !== undefined && (
                                        <Grid item xs={12}>
                                            <Box sx={{ maxWidth: 300 }}>
                                                <SimilarityScore score={recommendation.similarity} label="Similarity to suggested term" />
                                            </Box>
                                        </Grid>
                                    )}

                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">LCSH ID:</Typography>
                                        <Typography variant="body2">{bestMatch.identifier || 'N/A'}</Typography>
                                    </Grid>

                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">MARC Record (Field 650):</Typography>
                                        <TextField
                                            fullWidth
                                            variant="outlined"
                                            size="small"
                                            value={marcRecord}
                                            InputProps={{
                                                readOnly: true,
                                                endAdornment: (
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => handleCopyToClipboard(marcRecord)}
                                                    >
                                                        <ContentCopyIcon fontSize="small" />
                                                    </IconButton>
                                                )
                                            }}
                                            sx={{ fontFamily: 'monospace', mb: 2 }}
                                        />
                                    </Grid>

                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">Justification:</Typography>
                                        <Typography variant="body2">{recommendation.justification}</Typography>
                                    </Grid>

                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">Original Suggested Term:</Typography>
                                        <Typography variant="body2">{recommendation.term}</Typography>
                                    </Grid>
                                </Grid>
                            </Paper>
                        );
                    })}
                </List>
            )}

            {initialSuggestions && initialSuggestions.specialConsiderations && (
                <Box sx={{ mt: 3, mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                        Special Considerations
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <ReactMarkdown>
                            {initialSuggestions.specialConsiderations}
                        </ReactMarkdown>
                    </Paper>
                </Box>
            )}

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
                    onClick={handleSaveAndViewHistory}
                >
                    Save & View History
                </Button>
            </Box>

            <Snackbar
                open={snackbarOpen}
                autoHideDuration={3000}
                onClose={handleSnackbarClose}
                message={snackbarMessage}
            />
        </Box>
    );
};

export default FinalRecommendations; 