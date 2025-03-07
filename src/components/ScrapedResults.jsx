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
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Link,
    Grid
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppContext } from '../context/AppContext';

const ScrapedResults = () => {
    const {
        initialSuggestions,
        scrapedResults,
        setActiveStep,
        setFinalRecommendations,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    const [processedResults, setProcessedResults] = useState({});

    // Process the scraped results when the component mounts
    useEffect(() => {
        console.log('ScrapedResults component mounted with results:', scrapedResults);

        // Process the scraped results to make them easier to display
        const processed = {};

        Object.entries(scrapedResults).forEach(([term, result]) => {
            processed[term] = {
                success: result?.success || false,
                error: result?.error || 'No results found',
                items: result?.items || []
            };
        });

        setProcessedResults(processed);
    }, [scrapedResults]);

    // Handle back button
    const handleBack = () => {
        setActiveStep(1);
    };

    // Handle continue button
    const handleContinue = () => {
        try {
            // Combine the initial suggestions with the scraped results
            const finalRecommendations = initialSuggestions.recommendedTerms.map(term => {
                const scrapedResult = processedResults[term.term] || { items: [] };
                return {
                    ...term,
                    scrapedItems: scrapedResult.items || [],
                    verified: scrapedResult.items && scrapedResult.items.length > 0
                };
            });

            // Store the final recommendations in the context
            setFinalRecommendations(finalRecommendations);

            // Move to the next step
            setActiveStep(3);
        } catch (err) {
            setError(err.message || 'Failed to process final recommendations');
            console.error('Error processing final recommendations:', err);
        }
    };

    // If there are no scraped results, show a message
    if (!scrapedResults || Object.keys(scrapedResults).length === 0) {
        return (
            <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary">
                    No scraped results available. Please go back and validate terms first.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleBack}
                    sx={{ mt: 2 }}
                >
                    Back to Initial Suggestions
                </Button>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                LOC Validation Results
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            {Object.entries(processedResults).map(([term, result], index) => (
                <Accordion key={index} defaultExpanded={index === 0}>
                    <AccordionSummary
                        expandIcon={<ExpandMoreIcon />}
                        aria-controls={`panel${index}-content`}
                        id={`panel${index}-header`}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                            <Typography sx={{ flexGrow: 1 }}>{term}</Typography>
                            {result && result.items && result.items.length > 0 ? (
                                <Chip
                                    label={`${result.items.length} results`}
                                    color="success"
                                    size="small"
                                    sx={{ ml: 2 }}
                                />
                            ) : (
                                <Chip
                                    label="No results"
                                    color="error"
                                    size="small"
                                    sx={{ ml: 2 }}
                                />
                            )}
                        </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                        {result && result.items && result.items.length > 0 ? (
                            <List>
                                {result.items.map((item, itemIndex) => (
                                    <ListItem key={itemIndex} divider>
                                        <Grid container spacing={2}>
                                            <Grid item xs={12}>
                                                <Typography variant="subtitle1">
                                                    {item.heading}
                                                </Typography>
                                                {item.uri && (
                                                    <Link
                                                        href={`http://id.loc.gov${item.uri}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        View on LOC
                                                    </Link>
                                                )}
                                            </Grid>

                                            {item.details && (
                                                <Grid item xs={12}>
                                                    <Typography variant="body2" color="text.secondary">
                                                        {item.details}
                                                    </Typography>
                                                </Grid>
                                            )}

                                            {item.datasetType && (
                                                <Grid item xs={12} sm={6}>
                                                    <Typography variant="caption" color="text.secondary">
                                                        Dataset Type: {item.datasetType}
                                                    </Typography>
                                                </Grid>
                                            )}

                                            {item.identifier && (
                                                <Grid item xs={12} sm={6}>
                                                    <Typography variant="caption" color="text.secondary">
                                                        Identifier: {item.identifier}
                                                    </Typography>
                                                </Grid>
                                            )}

                                            {item.broaderTerms && item.broaderTerms.length > 0 && (
                                                <Grid item xs={12} sm={4}>
                                                    <Typography variant="caption" color="text.secondary">
                                                        Broader Terms:
                                                    </Typography>
                                                    <List dense>
                                                        {item.broaderTerms.map((term, termIndex) => (
                                                            <ListItem key={termIndex} dense>
                                                                <ListItemText primary={term} />
                                                            </ListItem>
                                                        ))}
                                                    </List>
                                                </Grid>
                                            )}

                                            {item.narrowerTerms && item.narrowerTerms.length > 0 && (
                                                <Grid item xs={12} sm={4}>
                                                    <Typography variant="caption" color="text.secondary">
                                                        Narrower Terms:
                                                    </Typography>
                                                    <List dense>
                                                        {item.narrowerTerms.map((term, termIndex) => (
                                                            <ListItem key={termIndex} dense>
                                                                <ListItemText primary={term} />
                                                            </ListItem>
                                                        ))}
                                                    </List>
                                                </Grid>
                                            )}

                                            {item.relatedTerms && item.relatedTerms.length > 0 && (
                                                <Grid item xs={12} sm={4}>
                                                    <Typography variant="caption" color="text.secondary">
                                                        Related Terms:
                                                    </Typography>
                                                    <List dense>
                                                        {item.relatedTerms.map((term, termIndex) => (
                                                            <ListItem key={termIndex} dense>
                                                                <ListItemText primary={term} />
                                                            </ListItem>
                                                        ))}
                                                    </List>
                                                </Grid>
                                            )}
                                        </Grid>
                                    </ListItem>
                                ))}
                            </List>
                        ) : (
                            <Typography color="text.secondary">
                                No results found for this term in the Library of Congress Subject Headings.
                                {result.error && result.error !== 'No results found' && (
                                    <Box component="span" sx={{ display: 'block', mt: 1 }}>
                                        Error: {result.error}
                                    </Box>
                                )}
                            </Typography>
                        )}
                    </AccordionDetails>
                </Accordion>
            ))}

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
                >
                    Continue to Final Recommendations
                </Button>
            </Box>
        </Box>
    );
};

export default ScrapedResults; 