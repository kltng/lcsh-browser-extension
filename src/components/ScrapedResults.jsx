import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Button, Chip, Alert, Card, CardContent, Link, CircularProgress, Stack
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { selectionsOf } from '../services/pipeline/run';
import { FALLBACK_BANNER } from '../services/pipeline/select';
import { fallbackNotice } from '../services/lookup/index';
import { getSettings } from '../services/settings';
import { outcomeLine, choiceText, authorityLabel, lcLink, sourceLine, viaNote, replacementNoteText } from './pipelineText';
import { shownText } from '../services/keyGuard';
import { useKnownKeys } from './useKnownKeys';

/**
 * One candidate row: label, authority badge, LC link, match class, how the
 * record was reached (SPEC-P5 §8), and the "Use this heading" control.
 * @param {{candidate:object, chosen:boolean, similarity:number|null, readOnly:boolean, onUse:Function}} props - Candidate and state
 * @returns {JSX.Element}
 */
const CandidateRow = ({ candidate, chosen, similarity, readOnly, onUse }) => {
  const note = viaNote(candidate);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, flexWrap: 'wrap', bgcolor: chosen ? 'rgba(25,118,210,0.08)' : 'transparent' }}>
      <Typography variant="body2" sx={{ fontWeight: chosen ? 'bold' : 'normal' }}>{candidate.label}</Typography>
      <Chip size="small" label={authorityLabel(candidate.authority)} />
      <Link href={lcLink(candidate.uri)} target="_blank" rel="noopener noreferrer" variant="caption">
        LC record {candidate.localId}
      </Link>
      <Chip size="small" variant="outlined" label={candidate.matchClass} />
      {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
      {chosen && similarity !== null && (
        <Typography variant="caption" color="text.secondary">{similarity}% similar spelling</Typography>
      )}
      {!readOnly && !chosen && (
        <Button size="small" onClick={() => onUse(candidate.cid)}>Use this heading</Button>
      )}
    </Box>
  );
};

/**
 * Step 3 content, per suggestion (also used read-only by history).
 * @param {{suggestions:object[], results:Object<string,object>, pending?:Object<string,boolean>, selections:object[],
 *   mode:string|null, manual?:object, readOnly?:boolean, onChoose?:Function, onRetry?:Function}} props - State and callbacks
 * @returns {JSX.Element}
 */
export const MatchesPanel = ({
  suggestions, results, pending = {}, selections, mode, manual = {}, readOnly = false, onChoose, onRetry
}) => {
  // P6 fix 14: finished display strings are checked against the known keys,
  // and the view re-renders when those keys change.
  useKnownKeys();
  return (
  <Box>
    {suggestions.map((s) => {
      const result = results[s.id];
      const selection = selections.find((x) => x.suggestionId === s.id);
      const candidates = result?.candidates || [];
      // The finished line, and the heading alone (a 1-character key matches only
      // a whole value). A replacement (hidden, or "Loading…" before the keys
      // have loaded) is shown instead of the whole line.
      const line = `${s.heading} (AI suggestion · ${s.kind})`;
      const lineShown = shownText(line);
      const headingShown = shownText(s.heading);
      const headingReplacement = lineShown !== line ? lineShown : (headingShown !== s.heading ? headingShown : null);
      const droppedNote = selection?.cid && selection.droppedSubdivisions.length > 0
        ? shownText(`The selected heading does not include these suggested subdivisions: ${selection.droppedSubdivisions.join(', ')}`)
        : null;
      return (
        <Card key={s.id} variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1">
              {headingReplacement !== null ? headingReplacement : (
                <>
                  {s.heading} <Typography component="span" variant="caption" color="text.secondary">(AI suggestion · {s.kind})</Typography>
                </>
              )}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              {pending[s.id] && <CircularProgress size={14} />}
              <Typography variant="body2" color={result?.outcome === 'failed' ? 'error' : 'text.secondary'}>
                {outcomeLine(result, Boolean(pending[s.id]))}
              </Typography>
              {!readOnly && result?.outcome === 'failed' && (
                <Button size="small" variant="outlined" onClick={() => onRetry(s.id)}>Retry lookup</Button>
              )}
            </Box>
            {result && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Source: {sourceLine(result.provenance)}
              </Typography>
            )}
            {(result?.replacementNotes || []).map((note) => (
              <Alert key={`${note.fromLocalId}-${note.targetLocalId}`} severity="info" sx={{ mb: 1 }}>
                {replacementNoteText(note)}
              </Alert>
            ))}
            {candidates.map((c) => (
              <CandidateRow
                key={c.cid}
                candidate={c}
                chosen={selection?.cid === c.cid}
                similarity={selection?.cid === c.cid ? selection.lexicalSimilarity : null}
                readOnly={readOnly}
                onUse={(cid) => onChoose(s.id, cid)}
              />
            ))}
            {candidates.length > 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                <Typography variant="body2">
                  <strong>Current choice:</strong> {choiceText(selection, { mode, hasManual: Object.hasOwn(manual, s.id) })}
                </Typography>
                {!readOnly && <Button size="small" color="inherit" onClick={() => onChoose(s.id, null)}>Use none</Button>}
              </Box>
            )}
            {droppedNote && (
              <Alert severity="info" sx={{ mt: 1 }}>{droppedNote}</Alert>
            )}
          </CardContent>
        </Card>
      );
    })}
  </Box>
  );
};

/**
 * "Build recommendations": build them, then show the Recommendations step.
 * Leaving the Matches step right after the build must NOT stop the name-key
 * operation the build just started (SPEC-P5 §7).
 * @param {object} workflow - The workflow controller
 * @param {(step:number)=>void} setActiveStep - The context's step setter
 */
export const buildAndShowRecommendations = (workflow, setActiveStep) => {
  workflow.build();
  setActiveStep(3);
};

const ScrapedResults = () => {
  const { run, workflow, setActiveStep, localDbClient } = useAppContext();
  const [notice, setNotice] = useState(null);
  const suggestions = run.suggest?.suggestions || [];
  const selections = selectionsOf(run);
  const lookingUp = Object.keys(run.lookup.pending).length > 0;
  const selecting = run.select.pending;
  const canBuild = run.run.stage === 'selected' || run.run.stage === 'built';

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((settings) => alive && setNotice(fallbackNotice(settings, localDbClient)))
      .catch(() => {});
    return () => { alive = false; };
  }, [localDbClient, run.run.runId]);

  const handleSettings = () => { window.location.hash = 'settings'; };
  const handleBuild = () => buildAndShowRecommendations(workflow, setActiveStep);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Matches</Typography>
      {/* A backend fallback is never silent (HOUSE_RULES 10). */}
      {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
      {run.select.mode === 'exact-fallback' && <Alert severity="warning" sx={{ mb: 2 }}>{FALLBACK_BANNER}</Alert>}
      {run.select.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {run.select.error.message}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" onClick={() => workflow.select()}>Retry</Button>
            <Button size="small" variant="outlined" onClick={handleSettings}>Settings</Button>
            <Button size="small" variant="outlined" onClick={() => workflow.continueWithoutAi()}>
              Continue without AI (exact matches only)
            </Button>
          </Stack>
        </Alert>
      )}
      <MatchesPanel
        suggestions={suggestions}
        results={run.lookup.results}
        pending={run.lookup.pending}
        selections={selections}
        mode={run.select.mode}
        manual={run.select.manual}
        onChoose={workflow.choose}
        onRetry={workflow.retryLookup}
      />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Button variant="outlined" onClick={() => setActiveStep(1)}>Back</Button>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="outlined" onClick={() => workflow.select()} disabled={lookingUp || selecting}>
            {selecting ? <><CircularProgress size={18} sx={{ mr: 1 }} />Choosing…</> : 'Choose headings'}
          </Button>
          <Button variant="contained" onClick={handleBuild} disabled={!canBuild || lookingUp || selecting}>
            Build recommendations
          </Button>
        </Box>
      </Box>
    </Box>
  );
};

export default ScrapedResults;
