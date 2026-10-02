import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Button, Chip, Alert, Card, CardContent, Link, CircularProgress, Stack
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { selectionsOf, lookupsComplete } from '../services/pipeline/run';
import { FALLBACK_BANNER } from '../services/pipeline/select';
import { fallbackNotice } from '../services/lookup/index';
import { getSettings } from '../services/settings';
import {
  outcomeLine, choiceText, authorityLabel, lcLink, sourceLine, viaNote, replacementNoteText,
  matchClassLabel, similarityText, matchesSummary, authorLabel
} from './pipelineText';
import { shownText } from '../services/keyGuard';
import ConfidenceBadge from './ConfidenceBadge';
import { isWorkflowRoute } from './route';
import { useKnownKeys, KeysUnavailableNotice } from './useKnownKeys';

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
      <Chip size="small" variant="outlined" label={matchClassLabel(candidate.matchClass)} />
      {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
      {chosen && similarityText(similarity) && (
        <Typography variant="caption" color="text.secondary">{similarityText(similarity)}</Typography>
      )}
      {!readOnly && !chosen && (
        <Button size="small" onClick={() => onUse(candidate.cid)}>Use this heading</Button>
      )}
    </Box>
  );
};

/**
 * Whether a card can start collapsed: its ONLY candidate is an exact match,
 * that candidate is the current choice, and nothing else needs attention.
 * @param {object|undefined} result - LookupResult
 * @param {object|undefined} selection - The suggestion's selection
 * @returns {boolean}
 */
export const startsCollapsed = (result, selection) => {
  const candidates = result?.candidates || [];
  return result?.outcome === 'found'
    && candidates.length === 1
    && candidates[0].matchClass === 'exact-full'
    && selection?.cid === candidates[0].cid
    && (result.replacementNotes || []).length === 0;
};

/**
 * Whether a card is shown expanded (UI round 1b). A choice the user made by
 * hand (true = expanded, false = collapsed) wins for that card in this run;
 * without one, the card is collapsed exactly while the collapse rule holds,
 * so it collapses as soon as the AI's choice makes the rule true.
 * @param {boolean|null} userExpanded - The user's own choice, or null
 * @param {boolean} collapsible - Whether the rule (startsCollapsed) holds now
 * @returns {boolean}
 */
export const cardExpanded = (userExpanded, collapsible) => {
  if (!collapsible) return true;
  return userExpanded ?? false;
};

/**
 * One suggestion card (UI round 1). An exact-only card starts collapsed to one
 * line with an expand control; every other card starts expanded.
 * @param {object} props - The suggestion, its result and selection, and the panel's callbacks
 * @returns {JSX.Element}
 */
const SuggestionCard = ({
  s, result, selection, pending, mode, manual, readOnly, onChoose, onRetry, showSource
}) => {
  // UI round 1b: the card follows the rule (it collapses as soon as the AI's
  // choice makes it true), unless the user expanded or collapsed it by hand.
  const [userExpanded, setUserExpanded] = useState(null);
  const collapsible = startsCollapsed(result, selection);
  const expanded = cardExpanded(userExpanded, collapsible);
  const candidates = result?.candidates || [];
  // The finished line, and the heading alone (a 1-character key matches only
  // a whole value). A replacement (hidden, or "Loading…" before the keys
  // have loaded) is shown instead of the whole line.
  const author = authorLabel(s.source);
  const line = `${s.heading} (${author} · ${s.kind})`;
  const lineShown = shownText(line);
  const headingShown = shownText(s.heading);
  const headingReplacement = lineShown !== line ? lineShown : (headingShown !== s.heading ? headingShown : null);
  const droppedNote = selection?.cid && selection.droppedSubdivisions.length > 0
    ? shownText(`The selected heading does not include these suggested subdivisions: ${selection.droppedSubdivisions.join(', ')}`)
    : null;
  const headingLine = headingReplacement !== null ? headingReplacement : (
    <>
      {s.heading} <Typography component="span" variant="caption" color="text.secondary">({author} · {s.kind})</Typography>
    </>
  );

  if (!expanded) {
    const chosen = candidates[0];
    return (
      <Card variant="outlined" sx={{ mb: 2 }} id={`match-card-${s.id}`} tabIndex={-1}>
        <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {/* ui-2b item 4: the collapsed line keeps the authorship, the method and the AI confidence. */}
            <Typography variant="subtitle1">{headingLine}</Typography>
            <Typography variant="body2" color="text.secondary">→ {chosen.label}</Typography>
            <Chip size="small" variant="outlined" label={matchClassLabel(chosen.matchClass)} />
            <Typography variant="body2">
              {choiceText(selection, { mode, hasManual: Object.hasOwn(manual, s.id) })}
              <ConfidenceBadge method={selection?.method} confidence={selection?.confidence} />
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={() => setUserExpanded(true)} aria-expanded="false">Show details</Button>
          </Box>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outlined" sx={{ mb: 2 }} id={`match-card-${s.id}`} tabIndex={-1}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1">{headingLine}</Typography>
          <Box sx={{ flex: 1 }} />
          {collapsible && (
            <Button size="small" onClick={() => setUserExpanded(false)} aria-expanded="true">Hide details</Button>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          {pending && <CircularProgress size={14} />}
          <Typography variant="body2" color={result?.outcome === 'failed' ? 'error' : 'text.secondary'}>
            {outcomeLine(result, Boolean(pending))}
          </Typography>
          {!readOnly && result?.outcome === 'failed' && (
            <Button size="small" variant="outlined" onClick={() => onRetry(s.id)}>Retry lookup</Button>
          )}
        </Box>
        {result && showSource && (
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
              <ConfidenceBadge method={selection?.method} confidence={selection?.confidence} />
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
};

/**
 * The one source of every result, or null when the results' sources differ.
 * @param {Object<string,object>} results - LookupResult by suggestionId
 * @returns {string|null}
 */
export const commonSourceLine = (results) => {
  const lines = new Set(Object.values(results).filter(Boolean).map((r) => sourceLine(r.provenance)));
  return lines.size === 1 ? [...lines][0] : null;
};

/**
 * Step 3 content, per suggestion (also used read-only by history).
 * @param {{suggestions:object[], results:Object<string,object>, pending?:Object<string,boolean>, selections:object[],
 *   mode:string|null, manual?:object, readOnly?:boolean, onChoose?:Function, onRetry?:Function,
 *   runId?:string|null}} props - State and callbacks (runId: the run the cards belong to)
 * @returns {JSX.Element}
 */
export const MatchesPanel = ({
  suggestions, results, pending = {}, selections, mode, manual = {}, readOnly = false, onChoose, onRetry, runId = null
}) => {
  // P6 fix 14: finished display strings are checked against the known keys,
  // and the view re-renders when those keys change.
  useKnownKeys();
  // UI round 1: one summary line, and "Source" once when every result agrees.
  const shown = Object.fromEntries(suggestions.filter((s) => results[s.id]).map((s) => [s.id, results[s.id]]));
  const commonSource = commonSourceLine(shown);
  return (
  <Box>
    {suggestions.length > 0 && (
      <Box sx={{ mb: 2 }}>
        <Typography variant="body2">{matchesSummary(suggestions, results, pending)}</Typography>
        {commonSource && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Source: {commonSource}</Typography>
        )}
      </Box>
    )}
    {suggestions.map((s) => (
      <SuggestionCard
        // Keyed by run: a choice made by hand lasts for that card in THIS run only.
        key={`${runId ?? ''}:${s.id}`}
        s={s}
        result={results[s.id]}
        selection={selections.find((x) => x.suggestionId === s.id)}
        pending={Boolean(pending[s.id])}
        mode={mode}
        manual={manual}
        readOnly={readOnly}
        onChoose={onChoose}
        onRetry={onRetry}
        showSource={commonSource === null}
      />
    ))}
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
  const {
    run, workflow, setActiveStep, localDbClient, viewEpoch = () => 0, focusRequest = null, clearFocusRequest = () => {},
    noteNavigation = () => {}, isHistoryOpen = () => false
  } = useAppContext();
  const [notice, setNotice] = useState(null);
  const [focusNotice, setFocusNotice] = useState(null);
  const suggestions = run.suggest?.suggestions || [];
  const selections = selectionsOf(run);
  const selecting = run.select.pending;
  // SPEC-UI2 §1: Next needs a completed lookup for every current suggestion,
  // nothing pending, and at least one suggestion.
  const canNext = lookupsComplete(run);
  const selectionCompleted = Boolean(run.select.mode) && !selecting;

  // "Back to Matches" (SPEC-UI2 §5): scroll to the card of that suggestion.
  useEffect(() => {
    if (!focusRequest || focusRequest.view !== 'matches') return;
    clearFocusRequest();
    const card = typeof document !== 'undefined' ? document.getElementById(`match-card-${focusRequest.suggestionId}`) : null;
    if (card) {
      card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      card.focus?.();
      setFocusNotice(null);
    } else {
      setFocusNotice('That suggestion is no longer in the list.');
    }
  }, [focusRequest]);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((settings) => alive && setNotice(fallbackNotice(settings, localDbClient)))
      .catch(() => {});
    return () => { alive = false; };
  }, [localDbClient, run.run.runId]);

  // ui-2b item 2: a navigation ends the Next ownership AT ONCE, before the hash change is handled.
  const handleSettings = () => {
    noteNavigation();
    window.location.hash = 'settings';
  };
  const advance = () => setActiveStep(3);
  // The Next continuation owns the Matches view only while no navigation
  // happened (the epoch) AND, read live when it resumes, the location still
  // shows the workflow and History is closed (ui-2c item 2): a browser hash
  // change whose hashchange event is not delivered yet ends it too.
  const handleNext = () => {
    const epoch = viewEpoch();
    workflow.next({
      onAdvance: advance,
      stillOwned: () => viewEpoch() === epoch && isWorkflowRoute() && !isHistoryOpen()
    });
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Matches</Typography>
      <KeysUnavailableNotice />
      {/* A backend fallback is never silent (HOUSE_RULES 10). */}
      {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
      {focusNotice && <Alert severity="info" sx={{ mb: 2 }}>{focusNotice}</Alert>}
      {run.select.mode === 'exact-fallback' && <Alert severity="warning" sx={{ mb: 2 }}>{FALLBACK_BANNER}</Alert>}
      {run.select.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {run.select.error.message}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" onClick={handleNext}>Retry</Button>
            <Button size="small" variant="outlined" onClick={handleSettings}>Settings</Button>
            <Button size="small" variant="outlined" onClick={() => workflow.continueWithoutAiAndAdvance({ onAdvance: advance })}>
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
        runId={run.run.runId}
      />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center' }}>
        <Button variant="outlined" onClick={() => setActiveStep(1)}>Back</Button>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {selecting && (
            <>
              <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center' }}>
                <CircularProgress size={18} sx={{ mr: 1 }} />Choosing headings…
              </Typography>
              <Button onClick={() => workflow.cancelSelect()}>Cancel</Button>
            </>
          )}
          {selectionCompleted && (
            <Button variant="outlined" onClick={() => workflow.askAgain()}>Ask the AI again</Button>
          )}
          <Button variant="contained" onClick={handleNext} disabled={!canNext}>
            Next: recommendations
          </Button>
        </Box>
      </Box>
    </Box>
  );
};

export default ScrapedResults;
