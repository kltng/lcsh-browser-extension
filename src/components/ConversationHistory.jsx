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
    Dialog,
    DialogTitle,
    DialogContent,
    DialogContentText,
    DialogActions,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Grid,
    Tooltip,
    TextField,
    Snackbar
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useAppContext } from '../context/AppContext';
import SimilarityScore from './SimilarityScore';
import { getSimilarityColor, getSimilarityLabel } from '../utils/similarityUtils';
import ReactMarkdown from 'react-markdown';

const ConversationHistory = () => {
    const {
        conversationHistory,
        deleteConversation,
        clearConversationHistory,
        setActiveStep,
        setBibliographicInfo,
        setInitialSuggestions,
        setFinalRecommendations,
        error,
        setError
    } = useAppContext();

    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [clearDialogOpen, setClearDialogOpen] = useState(false);
    const [selectedConversationId, setSelectedConversationId] = useState(null);
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');

    // Handle back button
    const handleBack = () => {
        setActiveStep(3);
    };

    // Handle new search
    const handleNewSearch = () => {
        // Reset the state and go back to the first step
        setBibliographicInfo({
            title: '',
            author: '',
            abstract: '',
            tableOfContents: '',
            notes: '',
            images: []
        });
        setInitialSuggestions([]);
        setFinalRecommendations([]);
        setActiveStep(0);
    };

    // Handle delete conversation
    const handleDeleteConversation = (id) => {
        setSelectedConversationId(id);
        setDeleteDialogOpen(true);
    };

    // Confirm delete conversation
    const confirmDeleteConversation = () => {
        try {
            deleteConversation(selectedConversationId);
            setDeleteDialogOpen(false);
        } catch (err) {
            setError(err.message || 'Failed to delete conversation');
            console.error('Error deleting conversation:', err);
        }
    };

    // Handle clear all conversations
    const handleClearAllConversations = () => {
        setClearDialogOpen(true);
    };

    // Confirm clear all conversations
    const confirmClearAllConversations = () => {
        try {
            clearConversationHistory();
            setClearDialogOpen(false);
        } catch (err) {
            setError(err.message || 'Failed to clear conversation history');
            console.error('Error clearing conversation history:', err);
        }
    };

    // Format date
    const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toLocaleString();
    };

    // Handle copy to clipboard
    const handleCopyToClipboard = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => {
                showSnackbar('Copied to clipboard');
            })
            .catch((err) => {
                console.error('Failed to copy:', err);
                showSnackbar('Failed to copy to clipboard');
            });
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

    // If there are no conversations, show a message
    if (!conversationHistory || conversationHistory.length === 0) {
        return (
            <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary">
                    No conversation history available.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleNewSearch}
                    sx={{ mt: 2 }}
                >
                    Start New Search
                </Button>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                Conversation History
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleNewSearch}
                >
                    Start New Search
                </Button>

                <Button
                    variant="outlined"
                    color="error"
                    startIcon={<DeleteIcon />}
                    onClick={handleClearAllConversations}
                >
                    Clear All History
                </Button>
            </Box>

            <List>
                {conversationHistory.slice().reverse().map((conversation) => (
                    <Paper key={conversation.id} variant="outlined" sx={{ mb: 3, overflow: 'hidden' }}>
                        <Box sx={{
                            p: 2,
                            display: 'flex',
                            justifyContent: 'space-between',
                            bgcolor: 'rgba(0, 0, 0, 0.03)'
                        }}>
                            <Typography variant="subtitle1">
                                {conversation.bibliographicInfo.title}
                            </Typography>

                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                {conversation.averageSimilarity !== undefined && (
                                    <Tooltip title={`Validation score: ${conversation.averageSimilarity}% (${getSimilarityLabel(conversation.averageSimilarity)})`}>
                                        <Chip
                                            label={`${conversation.averageSimilarity}%`}
                                            size="small"
                                            sx={{
                                                bgcolor: getSimilarityColor(conversation.averageSimilarity),
                                                color: 'white',
                                                fontWeight: 'bold'
                                            }}
                                        />
                                    </Tooltip>
                                )}

                                <Typography variant="caption" color="text.secondary">
                                    {formatDate(conversation.timestamp)}
                                </Typography>

                                <IconButton
                                    size="small"
                                    color="error"
                                    onClick={() => handleDeleteConversation(conversation.id)}
                                >
                                    <DeleteIcon fontSize="small" />
                                </IconButton>
                            </Box>
                        </Box>

                        <Divider />

                        <Box sx={{ p: 2 }}>
                            <Grid container spacing={2}>
                                <Grid item xs={12} sm={6}>
                                    <Typography variant="subtitle2">Author:</Typography>
                                    <Typography variant="body2">
                                        {conversation.bibliographicInfo.author || 'N/A'}
                                    </Typography>
                                </Grid>

                                {conversation.finalRecommendations && (
                                    <Grid item xs={12} sm={6}>
                                        <Typography variant="subtitle2">
                                            Recommendations:
                                        </Typography>
                                        <Typography variant="body2">
                                            {conversation.finalRecommendations.filter(rec => rec.similarity > 30 && rec.bestMatch).length} headings
                                        </Typography>
                                    </Grid>
                                )}

                                {conversation.averageSimilarity !== undefined && (
                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2">Validation Score:</Typography>
                                        <Box sx={{ maxWidth: 300, mt: 1 }}>
                                            <SimilarityScore
                                                score={conversation.averageSimilarity}
                                                showTooltip={false}
                                            />
                                        </Box>
                                    </Grid>
                                )}
                            </Grid>

                            <Accordion sx={{ mt: 2 }}>
                                <AccordionSummary
                                    expandIcon={<ExpandMoreIcon />}
                                    aria-controls="recommendations-content"
                                    id="recommendations-header"
                                >
                                    <Typography>View Recommendations</Typography>
                                </AccordionSummary>
                                <AccordionDetails>
                                    {conversation.finalRecommendations && conversation.finalRecommendations.length > 0 ? (
                                        <List dense>
                                            {conversation.finalRecommendations
                                                .filter(rec => (rec.similarity || 0) > 30 && rec.bestMatch)
                                                .map((rec, index) => (
                                                    <ListItem key={index} divider>
                                                        <Grid container spacing={1}>
                                                            <Grid item xs={12} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                                                    <Typography variant="body2" fontWeight="medium">
                                                                        {rec.bestMatch.heading}
                                                                    </Typography>
                                                                    <Button
                                                                        size="small"
                                                                        href={`http://id.loc.gov${rec.bestMatch.uri}`}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        sx={{ ml: 1, minWidth: 'auto', p: '2px 8px', fontSize: '0.75rem' }}
                                                                    >
                                                                        View on LOC
                                                                    </Button>
                                                                </Box>

                                                                {rec.similarity !== undefined && (
                                                                    <Tooltip title={`Similarity: ${rec.similarity}% (${getSimilarityLabel(rec.similarity)})`}>
                                                                        <Chip
                                                                            label={`${rec.similarity}%`}
                                                                            size="small"
                                                                            sx={{
                                                                                bgcolor: getSimilarityColor(rec.similarity),
                                                                                color: 'white'
                                                                            }}
                                                                        />
                                                                    </Tooltip>
                                                                )}
                                                            </Grid>

                                                            <Grid item xs={12}>
                                                                <Typography variant="caption" color="text.secondary">
                                                                    LCSH ID: {rec.bestMatch.identifier || 'N/A'}
                                                                </Typography>
                                                            </Grid>

                                                            {conversation.marcRecords && conversation.marcRecords[rec.term] && (
                                                                <Grid item xs={12}>
                                                                    <Typography variant="caption" color="text.secondary">
                                                                        MARC Record:
                                                                    </Typography>
                                                                    <TextField
                                                                        fullWidth
                                                                        variant="outlined"
                                                                        size="small"
                                                                        value={conversation.marcRecords[rec.term]}
                                                                        InputProps={{
                                                                            readOnly: true,
                                                                            endAdornment: (
                                                                                <IconButton
                                                                                    size="small"
                                                                                    onClick={() => handleCopyToClipboard(conversation.marcRecords[rec.term])}
                                                                                >
                                                                                    <ContentCopyIcon fontSize="small" />
                                                                                </IconButton>
                                                                            )
                                                                        }}
                                                                        sx={{ fontFamily: 'monospace', my: 1 }}
                                                                    />
                                                                </Grid>
                                                            )}

                                                            <Grid item xs={12}>
                                                                <Typography variant="caption" color="text.secondary">
                                                                    {rec.justification}
                                                                </Typography>
                                                            </Grid>
                                                        </Grid>
                                                    </ListItem>
                                                ))}
                                        </List>
                                    ) : (
                                        <Typography color="text.secondary">
                                            No recommendations available
                                        </Typography>
                                    )}
                                </AccordionDetails>
                            </Accordion>

                            {conversation.initialSuggestions && conversation.initialSuggestions.specialConsiderations && (
                                <Accordion sx={{ mt: 1 }}>
                                    <AccordionSummary
                                        expandIcon={<ExpandMoreIcon />}
                                        aria-controls="special-considerations-content"
                                        id="special-considerations-header"
                                    >
                                        <Typography>Special Considerations</Typography>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <ReactMarkdown>
                                            {conversation.initialSuggestions.specialConsiderations}
                                        </ReactMarkdown>
                                    </AccordionDetails>
                                </Accordion>
                            )}

                            <Accordion sx={{ mt: 1 }}>
                                <AccordionSummary
                                    expandIcon={<ExpandMoreIcon />}
                                    aria-controls="bibliographic-content"
                                    id="bibliographic-header"
                                >
                                    <Typography>View Bibliographic Information</Typography>
                                </AccordionSummary>
                                <AccordionDetails>
                                    <Grid container spacing={2}>
                                        <Grid item xs={12}>
                                            <Typography variant="subtitle2">Title:</Typography>
                                            <Typography variant="body2">
                                                {conversation.bibliographicInfo.title}
                                            </Typography>
                                        </Grid>

                                        <Grid item xs={12}>
                                            <Typography variant="subtitle2">Author:</Typography>
                                            <Typography variant="body2">
                                                {conversation.bibliographicInfo.author || 'N/A'}
                                            </Typography>
                                        </Grid>

                                        {conversation.bibliographicInfo.abstract && (
                                            <Grid item xs={12}>
                                                <Typography variant="subtitle2">Abstract:</Typography>
                                                <Typography variant="body2">
                                                    {conversation.bibliographicInfo.abstract}
                                                </Typography>
                                            </Grid>
                                        )}

                                        {conversation.bibliographicInfo.tableOfContents && (
                                            <Grid item xs={12}>
                                                <Typography variant="subtitle2">Table of Contents:</Typography>
                                                <Typography variant="body2">
                                                    {conversation.bibliographicInfo.tableOfContents}
                                                </Typography>
                                            </Grid>
                                        )}

                                        {conversation.bibliographicInfo.notes && (
                                            <Grid item xs={12}>
                                                <Typography variant="subtitle2">Notes:</Typography>
                                                <Typography variant="body2">
                                                    {conversation.bibliographicInfo.notes}
                                                </Typography>
                                            </Grid>
                                        )}

                                        {conversation.bibliographicInfo.images && conversation.bibliographicInfo.images.length > 0 && (
                                            <Grid item xs={12}>
                                                <Typography variant="subtitle2">Images:</Typography>
                                                <Typography variant="body2">
                                                    {conversation.bibliographicInfo.images.length} image(s) uploaded
                                                </Typography>
                                            </Grid>
                                        )}
                                    </Grid>
                                </AccordionDetails>
                            </Accordion>
                        </Box>
                    </Paper>
                ))}
            </List>

            {/* Delete Conversation Dialog */}
            <Dialog
                open={deleteDialogOpen}
                onClose={() => setDeleteDialogOpen(false)}
            >
                <DialogTitle>Delete Conversation</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        Are you sure you want to delete this conversation? This action cannot be undone.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
                    <Button onClick={confirmDeleteConversation} color="error">Delete</Button>
                </DialogActions>
            </Dialog>

            {/* Clear All Conversations Dialog */}
            <Dialog
                open={clearDialogOpen}
                onClose={() => setClearDialogOpen(false)}
            >
                <DialogTitle>Clear All History</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        Are you sure you want to clear all conversation history? This action cannot be undone.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setClearDialogOpen(false)}>Cancel</Button>
                    <Button onClick={confirmClearAllConversations} color="error">Clear All</Button>
                </DialogActions>
            </Dialog>

            {/* Snackbar for copy notifications */}
            <Snackbar
                open={snackbarOpen}
                autoHideDuration={3000}
                onClose={handleSnackbarClose}
                message={snackbarMessage}
            />
        </Box>
    );
};

export default ConversationHistory; 