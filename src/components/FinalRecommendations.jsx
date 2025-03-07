import React, { useState } from 'react';
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
    Tooltip
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { useAppContext } from '../context/AppContext';

const FinalRecommendations = () => {
    const {
        bibliographicInfo,
        initialSuggestions,
        finalRecommendations,
        setActiveStep,
        saveConversation,
        error,
        setError
    } = useAppContext();

    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [selectedRecommendations, setSelectedRecommendations] = useState([]);

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
                finalRecommendations,
                selectedRecommendations: selectedRecommendations.length > 0 ? selectedRecommendations : finalRecommendations
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
        const recommendations = selectedRecommendations.length > 0 ? selectedRecommendations : finalRecommendations;

        const text = recommendations.map(rec => {
            return `${rec.term}\n${rec.marc}\n${rec.justification}\n`;
        }).join('\n');

        handleCopyToClipboard(text);
    };

    // Handle export as CSV
    const handleExportCsv = () => {
        const recommendations = selectedRecommendations.length > 0 ? selectedRecommendations : finalRecommendations;

        const csvContent = [
            ['Term', 'MARC', 'API ID', 'URL', 'Justification', 'Verified'],
            ...recommendations.map(rec => [
                rec.term,
                rec.marc,
                rec.apiId,
                rec.url,
                rec.justification,
                rec.verified ? 'Yes' : 'No'
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

            <Box sx={{ mb: 3 }}>
                <Typography variant="body2" color="text.secondary" paragraph>
                    Below are the final LCSH recommendations based on the bibliographic information and LOC validation.
                    You can select recommendations to include in the export or copy to clipboard.
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

            <List>
                {finalRecommendations.map((recommendation, index) => {
                    const isSelected = selectedRecommendations.some(rec => rec.term === recommendation.term);

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
                                <Grid item xs={12} sx={{ display: 'flex', alignItems: 'center' }}>
                                    <Typography variant="h6" sx={{ flexGrow: 1 }}>
                                        {recommendation.term}
                                    </Typography>

                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        {recommendation.verified ? (
                                            <Tooltip title="Verified in LOC">
                                                <CheckCircleIcon color="success" />
                                            </Tooltip>
                                        ) : (
                                            <Tooltip title="Not found in LOC">
                                                <ErrorIcon color="error" />
                                            </Tooltip>
                                        )}

                                        <Tooltip title="Copy to clipboard">
                                            <IconButton
                                                size="small"
                                                onClick={() => handleCopyToClipboard(recommendation.term)}
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

                                <Grid item xs={12}>
                                    <Typography variant="subtitle2">MARC Format:</Typography>
                                    <TextField
                                        fullWidth
                                        variant="outlined"
                                        size="small"
                                        value={recommendation.marc}
                                        InputProps={{
                                            readOnly: true,
                                            endAdornment: (
                                                <IconButton
                                                    size="small"
                                                    onClick={() => handleCopyToClipboard(recommendation.marc)}
                                                >
                                                    <ContentCopyIcon fontSize="small" />
                                                </IconButton>
                                            )
                                        }}
                                        sx={{ fontFamily: 'monospace', mb: 2 }}
                                    />
                                </Grid>

                                <Grid item xs={12} sm={6}>
                                    <Typography variant="subtitle2">API ID:</Typography>
                                    <Typography variant="body2">{recommendation.apiId}</Typography>
                                </Grid>

                                <Grid item xs={12} sm={6}>
                                    <Typography variant="subtitle2">URL:</Typography>
                                    <Typography variant="body2">
                                        <a
                                            href={recommendation.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {recommendation.url}
                                        </a>
                                    </Typography>
                                </Grid>

                                <Grid item xs={12}>
                                    <Typography variant="subtitle2">Justification:</Typography>
                                    <Typography variant="body2">{recommendation.justification}</Typography>
                                </Grid>

                                {recommendation.scrapedItems && recommendation.scrapedItems.length > 0 && (
                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">
                                            LOC Validation Results ({recommendation.scrapedItems.length}):
                                        </Typography>
                                        <List dense>
                                            {recommendation.scrapedItems.slice(0, 3).map((item, itemIndex) => (
                                                <ListItem key={itemIndex} dense>
                                                    <ListItemText
                                                        primary={item.heading}
                                                        secondary={item.details}
                                                    />
                                                </ListItem>
                                            ))}
                                            {recommendation.scrapedItems.length > 3 && (
                                                <ListItem dense>
                                                    <ListItemText
                                                        primary={`${recommendation.scrapedItems.length - 3} more results...`}
                                                        secondary="Select to view all"
                                                    />
                                                </ListItem>
                                            )}
                                        </List>
                                    </Grid>
                                )}
                            </Grid>
                        </Paper>
                    );
                })}
            </List>

            {initialSuggestions && initialSuggestions.specialConsiderations && (
                <Box sx={{ mt: 3, mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                        Special Considerations
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <Typography variant="body2">
                            {initialSuggestions.specialConsiderations}
                        </Typography>
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