import React from 'react';
import {
  Box, Typography, Button, List, ListItem, ListItemText, Chip, Alert, Card, CardContent
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { TEXT_FALLBACK_NOTICE } from '../services/pipeline/suggest';
import { SUGGESTION_NOTE } from './pipelineText';

/**
 * Step 2 content: the subject analysis and the AI suggestions (also used read-only by history).
 * @param {{suggest:{subjectAnalysis:string, suggestions:object[], suggestMode:string}}} props - Step 1 result
 * @returns {JSX.Element}
 */
export const SuggestionsPanel = ({ suggest }) => (
  <Box>
    {suggest.suggestMode === 'text-fallback' && (
      <Alert severity="warning" sx={{ mb: 2 }}>{TEXT_FALLBACK_NOTICE}</Alert>
    )}
    {suggest.subjectAnalysis && (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>Subject analysis</Typography>
          <Typography variant="body2" color="text.secondary">{suggest.subjectAnalysis}</Typography>
        </CardContent>
      </Card>
    )}
    <Alert severity="info" sx={{ mb: 2 }}>{SUGGESTION_NOTE}</Alert>
    <List>
      {suggest.suggestions.map((s) => (
        <ListItem key={s.id} divider>
          <ListItemText
            primary={(
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body1">{s.heading}</Typography>
                <Chip size="small" variant="outlined" label={`AI suggestion · ${s.kind}`} />
              </Box>
            )}
            secondary={s.reason || null}
          />
        </ListItem>
      ))}
    </List>
  </Box>
);

const InitialSuggestions = () => {
  const { run, workflow, setActiveStep } = useAppContext();

  const handleBack = () => setActiveStep(0);

  // Start the lookups and move to the Matches step, where the results arrive
  const handleLookup = () => {
    workflow.lookupAll();
    setActiveStep(2);
  };

  if (!run.suggest) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="h6" color="text.secondary">
          No suggestions yet. Go back and describe the work first.
        </Typography>
        <Button variant="contained" onClick={handleBack} sx={{ mt: 2 }}>Back</Button>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>AI suggestions</Typography>
      <SuggestionsPanel suggest={run.suggest} />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
        <Button variant="outlined" onClick={handleBack}>Back</Button>
        <Button variant="contained" onClick={handleLookup}>Look up at the Library of Congress</Button>
      </Box>
    </Box>
  );
};

export default InitialSuggestions;
