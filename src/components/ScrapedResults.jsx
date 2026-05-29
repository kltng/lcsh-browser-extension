import React, { useState, useEffect } from 'react';
import {
    Box,
    Typography,
    Button,
    List,
    ListItem,
    Chip,
    Alert,
    Card,
    CardContent,
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
        scrapedResults,
        setActiveStep,
        setFinalRecommendations,
        error,
        setError
    } = useAppContext();

    const [processedResults, setProcessedResults] = useState({});
    const [similarityScores, setSimilarityScores] = useState({});
    const [averageSimilarity, setAverageSimilarity] = useState(0);

    // Process results when component mounts
    useEffect(() => {
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

            if (result?.items && result.items.length > 0) {
                const bestMatch = findBestMatch(term, result.items);
                scores[term] = bestMatch.similarity;
                totalScore += bestMatch.similarity;
                validTerms++;
            } else {
                scores[term] = 0;
            }
        });

        const avgScore = validTerms > 0 ? Math.round(totalScore / validTerms) : 0;

        setProcessedResults(processed);
        setSimilarityScores(scores);
        setAverageSimilarity(avgScore);
    }, [scrapedResults]);

    const handleBack = () => {
        setActiveStep(1);
    };

    const handleContinue = () => {
        try {
            const finalRecommendations = initialSuggestions.recommendedTerms.map(term => {
                const scrapedResult = processedResults[term.term] || { items: [] };
                const similarity = similarityScores[term.term] || 0;

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

            setFinalRecommendations(finalRecommendations);
            setActiveStep(3);
        } catch (err) {
            setError(err.message || 'Failed to process final recommendations');
        }
    };

    if (!scrapedResults || Object.keys(scrapedResults).length === 0) {
        return (
            <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary">
                    No validation results available. Please go back and validate terms first.
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
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 220 }}>
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
                                        const itemSimilarity = calculateSimilarity(term, item.heading);
                                        const sourceBadge = item.source === 'lcnaf' ? 'LCNAF' : 'LCSH';

                                        return (
                                            <ListItem key={itemIndex} divider>
                                                <Grid container spacing={2}>
                                                    <Grid item xs={12} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                                        <Box>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Typography variant="subtitle1">
                                                                    {item.heading}
                                                                </Typography>
                                                                <Chip
                                                                    label={sourceBadge}
                                                                    size="small"
                                                                    variant="outlined"
                                                                    color={item.source === 'lcnaf' ? 'secondary' : 'primary'}
                                                                />
                                                            </Box>
                                                            {item.uri && (
                                                                <Link
                                                                    href={item.uri.startsWith('http') ? item.uri : `https://id.loc.gov${item.uri}`}
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

                                                    {item.datasetType && (
                                                        <Grid item xs={12} sm={6}>
                                                            <Typography variant="caption" color="text.secondary">
                                                                Dataset: {item.datasetType}
                                                            </Typography>
                                                        </Grid>
                                                    )}

                                                    {item.identifier && (
                                                        <Grid item xs={12} sm={6}>
                                                            <Typography variant="caption" color="text.secondary">
                                                                ID: {item.identifier}
                                                            </Typography>
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
                                No results found for this term in the Library of Congress.
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
