import React, { useState } from 'react';
import {
  Box, Typography, Paper, Button, Divider, List, ListItem, Chip, Alert, IconButton, Dialog, DialogTitle,
  DialogContent, DialogContentText, DialogActions, Accordion, AccordionSummary, AccordionDetails, Snackbar
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useAppContext, EMPTY_BIBLIOGRAPHIC_INFO } from '../context/AppContext';
import {
  runViewOf, adaptLegacyEntry, legacyMarcCopyText, LEGACY_HEADER, LEGACY_MARC_LABEL, LEGACY_TEXT_LABEL
} from '../services/history';
import { getSimilarityColor } from '../utils/similarityUtils';
import { SuggestionsPanel } from './InitialSuggestions';
import { MatchesPanel } from './ScrapedResults';
import { RecommendationsPanel } from './FinalRecommendations';

const formatDate = (dateString) => (dateString ? new Date(dateString).toLocaleString() : '');

// A provenance field ({providerId, model} or null; missing in v1.1.0 entries)
const formatProvenance = (label, provenance) => (
  provenance ? `${label}: ${provenance.providerId} (${provenance.model})` : ''
);

const Section = ({ title, children }) => (
  <Accordion sx={{ mt: 1 }}>
    <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>{title}</Typography></AccordionSummary>
    <AccordionDetails>{children}</AccordionDetails>
  </Accordion>
);

/**
 * A v2 entry: steps 2–4 re-rendered read-only.
 * @param {{entry:object}} props - Rebuilt v2 entry
 * @returns {JSX.Element}
 */
export const V2EntryView = ({ entry }) => {
  const view = runViewOf(entry);
  const { suggest, select } = entry.provenance;
  return (
    <Box>
      {(suggest || select) && (
        <Typography variant="caption" color="text.secondary">
          {[formatProvenance('Suggestions', suggest), formatProvenance('Selection', select)].filter(Boolean).join(' · ')}
        </Typography>
      )}
      <Section title="AI suggestions"><SuggestionsPanel suggest={view.suggest} /></Section>
      <Section title="Matches">
        <MatchesPanel
          suggestions={view.suggest.suggestions}
          results={view.results}
          selections={view.selections}
          mode={view.selectMode}
          readOnly
        />
      </Section>
      <Section title="Recommendations">
        <RecommendationsPanel recommendations={view.recommendations} selections={view.selections} suggestions={view.suggest.suggestions} />
      </Section>
    </Box>
  );
};

/**
 * An entry saved by v1.1.0 or P3, read-only, with the older-version labels.
 * @param {{entry:object, onCopy:Function}} props - Stored legacy entry and a copy callback
 * @returns {JSX.Element}
 */
export const LegacyEntryView = ({ entry, onCopy }) => {
  const legacy = adaptLegacyEntry(entry);
  return (
    <Box>
      <Alert severity="warning" sx={{ mb: 1 }}>{LEGACY_HEADER}</Alert>
      {(legacy.suggestionProvenance || legacy.marcProvenance) && (
        <Typography variant="caption" color="text.secondary">
          {[formatProvenance('Suggestions', legacy.suggestionProvenance), formatProvenance('MARC', legacy.marcProvenance)]
            .filter(Boolean).join(' · ')}
        </Typography>
      )}
      {legacy.averageSimilarity !== null && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">Spelling score saved by the older version: </Typography>
          <Chip size="small" label={`${legacy.averageSimilarity}%`} sx={{ bgcolor: getSimilarityColor(legacy.averageSimilarity), color: 'white' }} />
        </Box>
      )}
      <Section title={`Headings (older version, ${legacy.items.length})`}>
        {legacy.items.length === 0 && <Typography color="text.secondary">No headings saved.</Typography>}
        <List dense>
          {legacy.items.map((item, index) => (
            <ListItem key={index} divider sx={{ display: 'block' }}>
              <Typography variant="body2" fontWeight="medium">{item.heading}</Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {LEGACY_TEXT_LABEL}: identifier {item.identifier || 'none'}; link {item.link || 'none'}
                {item.similarity !== null ? `; spelling score ${item.similarity}%` : ''}
              </Typography>
              {item.justification && (
                <Typography variant="caption" color="text.secondary" component="div">
                  {LEGACY_TEXT_LABEL}: {item.justification}
                </Typography>
              )}
              {item.marc && (
                <Box sx={{ mt: 0.5 }}>
                  <Typography variant="caption" color="warning.main" component="div">{LEGACY_MARC_LABEL}</Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{item.marc}</Typography>
                    <IconButton size="small" aria-label="Copy unverified MARC" onClick={() => onCopy(legacyMarcCopyText(item.marc))}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </Box>
                </Box>
              )}
            </ListItem>
          ))}
        </List>
      </Section>
      {legacy.specialConsiderations && (
        <Section title="Special considerations (older version)">
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{legacy.specialConsiderations}</Typography>
        </Section>
      )}
    </Box>
  );
};

const ConversationHistory = () => {
  const {
    conversationHistory, deleteConversation, clearConversationHistory, setActiveStep, setBibliographicInfo, error, setError
  } = useAppContext();
  const [deleteId, setDeleteId] = useState(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  const handleNewSearch = () => {
    setBibliographicInfo(EMPTY_BIBLIOGRAPHIC_INFO);
    setActiveStep(0);
  };

  const confirmDelete = () => {
    const id = deleteId;
    setDeleteId(null);
    deleteConversation(id).catch((err) => setError(err?.message || 'The entry could not be deleted.'));
  };

  const confirmClear = () => {
    setClearOpen(false);
    clearConversationHistory().catch((err) => setError(err?.message || 'The history could not be cleared.'));
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => setSnackbar('Copied to clipboard'))
      .catch(() => setSnackbar('Failed to copy to clipboard'));
  };

  if (!conversationHistory || conversationHistory.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="h6" color="text.secondary">No history yet.</Typography>
        <Button variant="contained" onClick={handleNewSearch} sx={{ mt: 2 }}>Start New Search</Button>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>History</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Button variant="contained" onClick={handleNewSearch}>Start New Search</Button>
        <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={() => setClearOpen(true)}>Clear All History</Button>
      </Box>
      <List>
        {conversationHistory.slice().reverse().map((entry) => (
          <Paper key={String(entry.id)} variant="outlined" sx={{ mb: 3, overflow: 'hidden' }}>
            <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', bgcolor: 'rgba(0, 0, 0, 0.03)' }}>
              <Box>
                <Typography variant="subtitle1">{entry.bibliographicInfo?.title || '(no title)'}</Typography>
                <Typography variant="body2" color="text.secondary">{entry.bibliographicInfo?.author || ''}</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography variant="caption" color="text.secondary">{formatDate(entry.timestamp)}</Typography>
                <IconButton size="small" color="error" aria-label="Delete entry" onClick={() => setDeleteId(entry.id)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            </Box>
            <Divider />
            <Box sx={{ p: 2 }}>
              {entry.v === 2 ? <V2EntryView entry={entry} /> : <LegacyEntryView entry={entry} onCopy={handleCopy} />}
            </Box>
          </Paper>
        ))}
      </List>
      <Dialog open={deleteId !== null} onClose={() => setDeleteId(null)}>
        <DialogTitle>Delete entry</DialogTitle>
        <DialogContent><DialogContentText>Delete this history entry? This cannot be undone.</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button onClick={confirmDelete} color="error">Delete</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={clearOpen} onClose={() => setClearOpen(false)}>
        <DialogTitle>Clear All History</DialogTitle>
        <DialogContent><DialogContentText>Clear the whole history? This cannot be undone.</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setClearOpen(false)}>Cancel</Button>
          <Button onClick={confirmClear} color="error">Clear All</Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={Boolean(snackbar)} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
};

export default ConversationHistory;
