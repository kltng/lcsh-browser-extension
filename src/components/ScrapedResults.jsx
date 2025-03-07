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
    Grid,
    Tooltip
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppContext } from '../context/AppContext';
import SimilarityScore from './SimilarityScore';
import { findBestMatch, calculateSimilarity } from '../utils/similarityUtils';

const ScrapedResults = () => {
    const {
        initialSuggestions,
        bibliographicInfo,
        scrapedResults,
        setActiveStep,
        setFinalRecommendations,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    const [processedResults, setProcessedResults] = useState({});
    const [similarityScores, setSimilarityScores] = useState({});
    const [averageSimilarity, setAverageSimilarity] = useState(0);

    // Process the scraped results when the component mounts
    useEffect(() => {
        console.log('ScrapedResults component mounted with results:', scrapedResults);

        // Process the scraped results to make them easier to display
        const processed = {};
        const scores = {};
        let totalScore = 0;
        let validTerms = 0;

        Object.entries(scrapedResults).forEach(([term, result]) => {
            processed[term] = {
                success: result?.success || false,
                error: result?.error || 'No results found',
                items: result?.items || []
            };

            // Calculate similarity score for this term
            if (result?.items && result.items.length > 0) {
                const bestMatch = findBestMatch(term, result.items);
                scores[term] = bestMatch.similarity;
                totalScore += bestMatch.similarity;
                validTerms++;
            } else {
                scores[term] = 0;
            }
        });

        // Calculate average similarity score
        const avgScore = validTerms > 0 ? Math.round(totalScore / validTerms) : 0;

        setProcessedResults(processed);
        setSimilarityScores(scores);
        setAverageSimilarity(avgScore);
    }, [scrapedResults]);

    // Handle back button
    const handleBack = () => {
        setActiveStep(1);
    };

    // Handle continue button
    const handleContinue = () => {
        try {
            // Combine the initial suggestions with the scraped results and similarity scores
            const finalRecommendations = initialSuggestions.recommendedTerms.map(term => {
                const scrapedResult = processedResults[term.term] || { items: [] };
                const similarity = similarityScores[term.term] || 0;

                // Find the best match from scraped results
                let bestMatch = null;
                if (scrapedResult.items && scrapedResult.items.length > 0) {
                    const { item } = findBestMatch(term.term, scrapedResult.items);
                    bestMatch = item;
                }

                return {
                    ...term,
                    scrapedItems: scrapedResult.items || [],
                    verified: scrapedResult.items && scrapedResult.items.length > 0,
                    similarity,
                    bestMatch
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

            {/* Overall similarity score */}
            <Card variant="outlined" sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="subtitle1" gutterBottom>
                        Overall Validation Score
                    </Typography>
                    <Box sx={{ maxWidth: 400, mx: 'auto', my: 2 }}>
                        <SimilarityScore
                            score={averageSimilarity}
                            label="Average similarity between suggested terms and LOC results"
                            showTooltip={false}
                        />
                    </Box>
                    <Typography variant="body2" color="text.secondary" align="center">
                        This score indicates how well the suggested terms match the actual Library of Congress Subject Headings.
                    </Typography>
                </CardContent>
            </Card>

            {Object.entries(processedResults).map(([term, result], index) => (
                <Accordion key={index} defaultExpanded={index === 0}>
                    <AccordionSummary
                        expandIcon={<ExpandMoreIcon />}
                        aria-controls={`panel${index}-content`}
                        id={`panel${index}-header`}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                            <Typography sx={{ flexGrow: 1 }}>{term}</Typography>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 180 }}>
                                {result && result.items && result.items.length > 0 ? (
                                    <>
                                        <Chip
                                            label={`${result.items.length} results`}
                                            color="success"
                                            size="small"
                                        />
                                        <Tooltip title={`Similarity score: ${similarityScores[term]}%`}>
                                            <Chip
                                                label={`${similarityScores[term]}% match`}
                                                color={similarityScores[term] >= 70 ? "success" : similarityScores[term] >= 50 ? "warning" : "error"}
                                                size="small"
                                            />
                                        </Tooltip>
                                    </>
                                ) : (
                                    <Chip
                                        label="No results"
                                        color="error"
                                        size="small"
                                    />
                                )}
                            </Box>
                        </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                        {result && result.items && result.items.length > 0 ? (
                            <>
                                <Box sx={{ mb: 3 }}>
                                    <Typography variant="subtitle2" gutterBottom>
                                        Similarity Score
                                    </Typography>
                                    <Box sx={{ maxWidth: 300 }}>
                                        <SimilarityScore score={similarityScores[term]} />
                                    </Box>
                                </Box>

                                <Typography variant="subtitle2" gutterBottom>
                                    LOC Results
                                </Typography>
                                <List>
                                    {result.items.map((item, itemIndex) => {
                                        // Calculate individual similarity for this item
                                        const itemSimilarity = calculateSimilarity(term, item.heading);

                                        return (
                                            <ListItem key={itemIndex} divider>
                                                <Grid container spacing={2}>
                                                    <Grid item xs={12} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                                        <Box>
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
                                                        </Box>
                                                        <Tooltip title={`Similarity to "${term}"`}>
                                                            <Chip
                                                                label={`${itemSimilarity}% match`}
                                                                color={itemSimilarity >= 70 ? "success" : itemSimilarity >= 50 ? "warning" : "error"}
                                                                size="small"
                                                            />
                                                        </Tooltip>
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
                                        );
                                    })}
                                </List>
                            </>
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