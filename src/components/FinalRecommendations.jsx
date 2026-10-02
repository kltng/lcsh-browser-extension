import React, { useState } from 'react';
import {
  Box, Typography, Button, Chip, Alert, Card, CardContent, IconButton, Snackbar, Link, List, ListItem, ListItemText,
  CircularProgress, Stack
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useAppContext } from '../context/AppContext';
import { selectionsOf } from '../services/pipeline/run';
import { subdivisionNote, FALLBACK_BANNER } from '../services/pipeline/select';
import { copyAllText, recommendationsCsv, marcUnavailableText, marcTextOf } from '../services/pipeline/exports';
import { formatMarc, NOT_REFORMATTED_NOTE } from '../services/pipeline/marcFormat';
import ConfidenceBadge from './ConfidenceBadge';
import { useSubfieldDelimiter } from './useSubfieldDelimiter';
import { NONE_REASON_WORDS } from '../services/pipeline/types';
import { needsNameKey } from '../services/pipeline/nameKeys';
import { KeyEchoError, shownText } from '../services/keyGuard';
import { useKnownKeys, KeysUnavailableNotice } from './useKnownKeys';
import { methodText, authorityLabel, lcLink, viaNote, authorLabel } from './pipelineText';

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
export const RecommendationsPanel = ({
  recommendations, selections, suggestions, onCopy, onBackToMatches, onEditHeading, delimiter: fixedDelimiter, selectMode = null
}) => {
  // P6 fix 14: finished display strings are checked against the known keys,
  // and the view re-renders when those keys change.
  useKnownKeys();
  // SPEC-UI2 §4: the saved delimiter, applied to display only.
  const savedDelimiter = useSubfieldDelimiter();
  const delimiter = fixedDelimiter ?? savedDelimiter;
  const withoutHeading = selections.filter((s) => !s.cid);
  const suggestionOf = (id) => suggestions.find((s) => s.id === id);
  const withoutHeadingLine = (id) => {
    const suggestion = suggestionOf(id);
    const heading = suggestion?.heading || id;
    const shownHeading = shownText(heading);
    // The heading's own replacement (hidden, or "Loading…") wins; else the finished line's.
    return shownHeading !== heading ? shownHeading : shownText(`${heading} (${authorLabel(suggestion?.source)})`);
  };
  return (
    <Box>
      {/* ui-2b item 3: an exact-only fallback is disclosed for as long as its recommendations are shown (live and history). */}
      {selectMode === 'exact-fallback' && <Alert severity="warning" sx={{ mb: 2 }}>{FALLBACK_BANNER}</Alert>}
      {recommendations.length === 0 && (
        <Typography color="text.secondary" sx={{ mb: 2 }}>No LC heading was chosen.</Typography>
      )}
      {recommendations.map((rec) => {
        // The select.js join, checked as the FINISHED note (finding 2).
        const note = shownText(subdivisionNote(rec, selections));
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
              <Typography variant="body2" sx={{ mt: 0.5 }} component="div">
                {/* One method per selection, each with its OWN confidence (never aggregated). */}
                {rec.selections.map((s, i) => (
                  <React.Fragment key={`${s.suggestionId ?? 'additional'}-${i}`}>
                    {i > 0 && ' · '}
                    {methodText(s)}
                    <ConfidenceBadge method={s.method} confidence={s.confidence} />
                  </React.Fragment>
                ))}
              </Typography>
              {viaNote(rec) && (
                <Typography variant="caption" color="text.secondary">{viaNote(rec)}</Typography>
              )}
              {rec.marc.status === 'from-authority' ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                  <Typography variant="caption" color="text.secondary">MARC field (text form):</Typography>
                  {/* The finished, delimiter-formatted text goes through the display guard. */}
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{shownText(marcTextOf(rec, delimiter))}</Typography>
                  {onCopy && (
                    <IconButton size="small" aria-label="Copy MARC field" onClick={() => onCopy(marcTextOf(rec, delimiter))}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              ) : null}
              {/* ui-2b item 5: a stored field whose structure could not be used is shown as saved. */}
              {rec.marc.status === 'from-authority' && formatMarc(rec.marc, delimiter)?.reformatted === false && (
                <Typography variant="caption" color="text.secondary" component="div">{NOT_REFORMATTED_NOTE}</Typography>
              )}
              {rec.marc.status !== 'from-authority' && (
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
              <ListItem key={s.suggestionId} divider sx={{ flexWrap: 'wrap' }}>
                <ListItemText
                  primary={withoutHeadingLine(s.suggestionId)}
                  // The actual reason (failed lookup, AI chose none, manual none, …), never generalized.
                  secondary={NONE_REASON_WORDS[s.noneReason] || 'no candidate was chosen'}
                />
                {/* SPEC-UI2 §5: live view only (history passes no callbacks). */}
                {(onBackToMatches || onEditHeading) && (
                  <Stack direction="row" spacing={1}>
                    {onBackToMatches && <Button size="small" onClick={() => onBackToMatches(s.suggestionId)}>Back to Matches</Button>}
                    {onEditHeading && <Button size="small" onClick={() => onEditHeading(s.suggestionId)}>Edit search heading</Button>}
                  </Stack>
                )}
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Box>
  );
};

const FinalRecommendations = () => {
  const {
    run, workflow, setActiveStep, saveRunToHistory, openHistory = () => {}, requestFocus = () => {}
  } = useAppContext();
  const [snackbar, setSnackbar] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const recommendations = run.recommendations || [];
  const selections = selectionsOf(run);
  const suggestions = run.suggest?.suggestions || [];
  const delimiter = useSubfieldDelimiter();

  // SPEC-UI2 §5: go to the target view and focus that suggestion. A missing
  // target gives a local message and changes nothing.
  const goTo = (view, step) => (suggestionId) => {
    if (!suggestions.some((s) => s.id === suggestionId)) {
      setSnackbar('That suggestion is no longer in the list.');
      return;
    }
    requestFocus(view, suggestionId);
    setActiveStep(step);
  };

  // Exit (c), P6 fix 13: the FINAL text is checked before it leaves.
  const guardedText = (text) => {
    try {
      return workflow.guard('export', text);
    } catch (err) {
      setSnackbar(err instanceof KeyEchoError ? err.message : 'The text could not be exported.');
      return null;
    }
  };

  const handleCopy = (text) => {
    if (guardedText(text) === null) return;
    navigator.clipboard.writeText(text)
      .then(() => setSnackbar('Copied to clipboard'))
      .catch(() => setSnackbar('Failed to copy to clipboard'));
  };

  const handleExportCsv = () => {
    // The fully serialized CSV (delimiter, formula guard, quoting, BOM, CRLF) is what the guard sees.
    const csv = guardedText(recommendationsCsv(recommendations, selections, { suggestions, delimiter }));
    if (csv === null) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
      // History is a view, not a step: the workflow keeps its step and state.
      openHistory();
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
      <KeysUnavailableNotice />
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
        suggestions={suggestions}
        selectMode={run.select.mode}
        onCopy={handleCopy}
        delimiter={delimiter}
        onBackToMatches={goTo('matches', 2)}
        onEditHeading={goTo('suggestions', 1)}
      />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Button variant="outlined" onClick={() => setActiveStep(2)}>Back</Button>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="outlined" onClick={() => handleCopy(copyAllText(recommendations, selections, { delimiter }))} disabled={recommendations.length === 0}>
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
