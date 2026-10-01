import React, { useState } from 'react';
import {
  Box, Typography, Button, Chip, Alert, Card, CardContent, IconButton, Snackbar, Link, List, ListItem, ListItemText,
  CircularProgress
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useAppContext } from '../context/AppContext';
import { selectionsOf } from '../services/pipeline/run';
import { subdivisionNote } from '../services/pipeline/select';
import { copyAllText, recommendationsCsv, marcUnavailableText } from '../services/pipeline/exports';
import { NONE_REASON_WORDS } from '../services/pipeline/types';
import { needsNameKey } from '../services/pipeline/nameKeys';
import { methodText, authorityLabel, lcLink, viaNote } from './pipelineText';

/**
 * Whether any recommendation is a local name whose MARC key is still missing
 * (SPEC-P5 §7: the Recommendations step then offers "Retry name MARC keys").
 * @param {object[]} recommendations - Recommendations
 * @returns {boolean}
 */
export const hasUnresolvedNameKeys = (recommendations = []) =>
  recommendations.some((rec) => needsNameKey(rec) && rec.marc?.status !== 'from-authority');

/**
 * Step 4 content: one card per Recommendation, then the suggestions without
 * an LC heading (also used read-only by history).
 * @param {{recommendations:object[], selections:object[], suggestions:object[], onCopy?:Function}} props - Results
 * @returns {JSX.Element}
 */
export const RecommendationsPanel = ({ recommendations, selections, suggestions, onCopy }) => {
  const withoutHeading = selections.filter((s) => !s.cid);
  const headingOf = (id) => suggestions.find((s) => s.id === id)?.heading || id;
  return (
    <Box>
      {recommendations.length === 0 && (
        <Typography color="text.secondary" sx={{ mb: 2 }}>No LC heading was chosen.</Typography>
      )}
      {recommendations.map((rec) => {
        const note = subdivisionNote(rec, selections);
        return (
          <Card key={rec.cid} variant="outlined" sx={{ mb: 2 }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="subtitle1">{rec.label}</Typography>
                <Chip size="small" label={authorityLabel(rec.authority)} />
              </Box>
              <Typography variant="body2" color="text.secondary">
                LC ID: {rec.localId} · <Link href={lcLink(rec.uri)} target="_blank" rel="noopener noreferrer">{lcLink(rec.uri)}</Link>
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {rec.selections.map((s) => methodText(s)).join(' · ')}
              </Typography>
              {viaNote(rec) && (
                <Typography variant="caption" color="text.secondary">{viaNote(rec)}</Typography>
              )}
              {rec.marc.status === 'from-authority' ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                  <Typography variant="caption" color="text.secondary">MARC field (text form):</Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{rec.marc.text}</Typography>
                  {onCopy && (
                    <IconButton size="small" aria-label="Copy MARC field" onClick={() => onCopy(rec.marc.text)}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {marcUnavailableText(rec.marc.reason)}
                </Typography>
              )}
              {note && <Alert severity="info" sx={{ mt: 1 }}>{note}</Alert>}
            </CardContent>
          </Card>
        );
      })}
      {withoutHeading.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle1">Suggestions without an LC heading</Typography>
          <List dense>
            {withoutHeading.map((s) => (
              <ListItem key={s.suggestionId} divider>
                <ListItemText
                  primary={`${headingOf(s.suggestionId)} (AI suggestion)`}
                  secondary={NONE_REASON_WORDS[s.noneReason] || 'no candidate was chosen'}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Box>
  );
};

const FinalRecommendations = () => {
  const { run, workflow, setActiveStep, saveRunToHistory } = useAppContext();
  const [snackbar, setSnackbar] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const recommendations = run.recommendations || [];
  const selections = selectionsOf(run);

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => setSnackbar('Copied to clipboard'))
      .catch(() => setSnackbar('Failed to copy to clipboard'));
  };

  const handleExportCsv = () => {
    const blob = new Blob([recommendationsCsv(recommendations, selections)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', 'lcsh_recommendations.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      URL.revokeObjectURL(url);
    }
    setSnackbar('CSV file downloaded');
  };

  // "Saved" is shown only after the storage write is confirmed
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveRunToHistory();
      setSnackbar('Saved');
      setActiveStep(4);
    } catch (err) {
      setSaveError(err?.message || 'The history could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (run.recommendations === null) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="h6" color="text.secondary">No recommendations yet. Go back and choose headings first.</Typography>
        <Button variant="contained" onClick={() => setActiveStep(2)} sx={{ mt: 2 }}>Back to Matches</Button>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Recommendations</Typography>
      {saveError && <Alert severity="error" sx={{ mb: 2 }}>{saveError}</Alert>}
      {hasUnresolvedNameKeys(recommendations) && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={(
            <Button size="small" disabled={run.nameKeys?.pending} onClick={() => workflow.retryNameKeys()}>
              Retry name MARC keys
            </Button>
          )}
        >
          The MARC key of a name is looked up at the Library of Congress.
        </Alert>
      )}
      <RecommendationsPanel
        recommendations={recommendations}
        selections={selections}
        suggestions={run.suggest?.suggestions || []}
        onCopy={handleCopy}
      />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Button variant="outlined" onClick={() => setActiveStep(2)}>Back</Button>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="outlined" onClick={() => handleCopy(copyAllText(recommendations, selections))} disabled={recommendations.length === 0}>
            Copy all
          </Button>
          <Button variant="outlined" onClick={handleExportCsv} disabled={recommendations.length === 0}>Export CSV</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving}>
            {saving ? <><CircularProgress size={18} sx={{ mr: 1 }} />Saving…</> : 'Save to history'}
          </Button>
        </Box>
      </Box>
      <Snackbar open={Boolean(snackbar)} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
};

export default FinalRecommendations;
