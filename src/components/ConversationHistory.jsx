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
    Grid
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppContext } from '../context/AppContext';

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
            notes: ''
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
                                            {conversation.finalRecommendations.length} headings
                                        </Typography>
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
                                            {conversation.finalRecommendations.map((rec, index) => (
                                                <ListItem key={index} divider>
                                                    <ListItemText
                                                        primary={rec.term}
                                                        secondary={rec.justification}
                                                    />
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
        </Box>
    );
};

export default ConversationHistory; 