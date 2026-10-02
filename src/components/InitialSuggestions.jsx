import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Button, List, ListItem, ListItemText, Chip, Alert, Card, CardContent, TextField, MenuItem, Stack
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { TEXT_FALLBACK_NOTICE, MAX_SUGGESTIONS } from '../services/pipeline/suggest';
import { EDITABLE_KINDS, KIND_LABELS } from '../services/pipeline/suggestionEdits';
import { SUGGESTION_NOTE, SUGGESTIONS_HEADING, DOWNSTREAM_WARNING, authorLabel } from './pipelineText';
import {
  shownText, LOADING_TEXT, documentKeys, valueHasKey, textFields, keysState
} from '../services/keyGuard';
import { useKnownKeys, KeysUnavailableNotice } from './useKnownKeys';

/** The kinds the editor offers for one suggestion (`unknown` only if it already has it). */
const kindOptions = (current) => (current === 'unknown' ? ['unknown', ...EDITABLE_KINDS] : EDITABLE_KINDS);

/** Shown in the editor of a heading the key guard hides (ui-2b item 1). */
export const HIDDEN_HEADING_NOTE = 'The original text is hidden because it repeats an API key.';
/** The same, while the saved keys are still loading (the list shows "Loading…"). */
export const LOADING_HEADING_NOTE = 'The original text is hidden until your saved settings have loaded.';
/** Shown after a TYPED draft was emptied because it repeats an API key (ui-2c item 1). */
export const DRAFT_HIDDEN_NOTE = 'The text was removed because it repeats an API key.';
/** The same, after the saved keys could not be read (ui-2c item 3). */
export const KEY_READ_FAILED_HEADING_NOTE = 'Your saved settings could not be read, so the original text is hidden.';

/**
 * The editor's note: why the input does not show the text, or null.
 * @param {string} heading - The stored heading
 * @param {boolean} hidden - The list hides the heading now
 * @param {boolean} blanked - A typed draft was emptied because it repeats a key
 * @returns {string|null}
 */
const keyNoteFor = (heading, hidden, blanked) => {
  if (!hidden && !blanked) return null;
  const state = keysState();
  if (state === 'failed') return KEY_READ_FAILED_HEADING_NOTE;
  if (state === 'loading' && shownText(heading) === LOADING_TEXT) return LOADING_HEADING_NOTE;
  return hidden ? HIDDEN_HEADING_NOTE : DRAFT_HIDDEN_NOTE;
};

/**
 * Whether the key guard hides this heading in the list (hidden, or "Loading…"
 * while the keys are not known yet).
 * @param {string} heading - The stored heading
 * @returns {boolean}
 */
export const isHeadingHidden = (heading) => shownText(heading) !== heading;

/**
 * Whether a draft as DISPLAYED would repeat a known key, by the display
 * guard's own fields and length rules (ui-2c item 1).
 * @param {string} value - The draft
 * @param {string[]} [keys] - Keys to check (default: every known key)
 * @returns {boolean}
 */
export const draftShowsKey = (value, keys = documentKeys()) => typeof value === 'string' && value !== ''
  && valueHasKey(textFields(value), keys);

/**
 * The value shown in the editor input. The stored text of a hidden heading
 * never appears there, and neither does ANY draft — untouched or typed —
 * that repeats a known key, initially, after typing, or after the keys
 * change while the editor is open. Such a value becomes EMPTY; a replacement
 * text (hidden / "Loading…") is never used as a value.
 * @param {string|null} draft - What the user typed, or null when untouched
 * @param {string} heading - The stored heading
 * @param {boolean} hidden - isHeadingHidden(heading) now
 * @param {string[]} [keys] - Keys to check (default: every known key)
 * @returns {string}
 */
export const editorHeadingValue = (draft, heading, hidden, keys = documentKeys()) => {
  const value = draft ?? heading;
  if (hidden && value === heading) return '';
  return draftShowsKey(value, keys) ? '' : value;
};

/**
 * The draft editor of ONE suggestion (SPEC-UI2 §2). Opening or cancelling it
 * changes nothing in the run; Apply sends one edit.
 * @param {{suggestion:object, onApply:Function, onCancel:Function, showWarning:boolean}} props - Suggestion and callbacks
 * @returns {JSX.Element}
 */
const SuggestionEditor = ({ suggestion, onApply, onCancel, showWarning }) => {
  // ui-2b item 1: the editor input is a display exit too. It follows the key
  // registry (re-rendered when the keys change).
  useKnownKeys();
  const hidden = isHeadingHidden(suggestion.heading);
  // null = the user has not typed; the draft then starts from the heading,
  // unless that heading is hidden, when it starts EMPTY.
  const [draft, setDraft] = useState(() => (hidden ? '' : null));
  const heading = editorHeadingValue(draft, suggestion.heading, hidden);
  // A typed draft that was emptied because it repeats a key stays empty, even
  // if that key is later removed (the text is never shown again).
  const blanked = draft !== null && draft !== '' && heading === '';
  const [draftWasHidden, setDraftWasHidden] = useState(false);
  useEffect(() => {
    if (!blanked) return;
    setDraft('');
    setDraftWasHidden(true);
  }, [blanked]);
  const noteText = keyNoteFor(suggestion.heading, hidden, blanked || draftWasHidden);
  const [kind, setKind] = useState(suggestion.kind);
  const [error, setError] = useState(null);
  const onChange = (e) => {
    setDraft(e.target.value);
    setDraftWasHidden(false);
    setError(null);
  };
  const apply = () => {
    // The replacement text is never sent: a hidden heading needs new text.
    const result = onApply({ type: 'edit', id: suggestion.id, heading, kind });
    if (result?.ok === false) setError(result.error);
  };
  return (
    <Box sx={{ width: '100%' }}>
      {showWarning && <Alert severity="warning" sx={{ mb: 1 }}>{DOWNSTREAM_WARNING}</Alert>}
      {noteText && <Alert severity="info" sx={{ mb: 1 }}>{noteText}</Alert>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          size="small" fullWidth label="Search heading" value={heading} onChange={onChange}
          error={Boolean(error)} helperText={error || ' '} inputProps={{ 'aria-label': 'Search heading' }}
        />
        <TextField select size="small" label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} sx={{ minWidth: 160 }}>
          {kindOptions(suggestion.kind).map((k) => <MenuItem key={k} value={k}>{KIND_LABELS[k]}</MenuItem>)}
        </TextField>
        <Button variant="contained" onClick={apply}>Apply</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Stack>
    </Box>
  );
};

/**
 * "Add a heading" (SPEC-UI2 §2): the user's own heading, with a required kind.
 * @param {{onAdd:Function, full:boolean, showWarning:boolean}} props - Callback and limits
 * @returns {JSX.Element}
 */
const AddHeading = ({ onAdd, full, showWarning }) => {
  const [heading, setHeading] = useState('');
  const [kind, setKind] = useState('');
  const [error, setError] = useState(null);
  const add = () => {
    const result = onAdd({ type: 'add', heading, kind });
    if (result?.ok === false) setError(result.error);
    else {
      setHeading('');
      setKind('');
      setError(null);
    }
  };
  if (full) return <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>At most {MAX_SUGGESTIONS} suggestions.</Typography>;
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom>Add a heading</Typography>
      {showWarning && <Alert severity="warning" sx={{ mb: 1 }}>{DOWNSTREAM_WARNING}</Alert>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          size="small" fullWidth label="Your heading" value={heading} onChange={(e) => { setHeading(e.target.value); setError(null); }}
          error={Boolean(error)} helperText={error || ' '} inputProps={{ 'aria-label': 'Your heading' }}
        />
        <TextField select size="small" label="Kind" value={kind} onChange={(e) => { setKind(e.target.value); setError(null); }} sx={{ minWidth: 160 }}>
          {EDITABLE_KINDS.map((k) => <MenuItem key={k} value={k}>{KIND_LABELS[k]}</MenuItem>)}
        </TextField>
        <Button variant="outlined" onClick={add}>Add</Button>
      </Stack>
    </Box>
  );
};

/**
 * Step 2 content: the AI analysis and the suggestions (also used read-only by
 * history). `editable` (the live view only) adds Edit, Remove and Add.
 * @param {{suggest:object, editable?:boolean, onEdit?:Function, hasDownstream?:boolean,
 *   editingId?:string|null, onEditingChange?:Function}} props - Step 1 result and the edit controls
 * @returns {JSX.Element}
 */
export const SuggestionsPanel = ({
  suggest, editable = false, onEdit, hasDownstream = false, editingId = null, onEditingChange = () => {}
}) => {
  // P6 fix 14: every model-written value is checked when shown (this panel is
  // also the history view), and the view follows changes of the known keys.
  useKnownKeys();
  const [removeError, setRemoveError] = useState(null);
  const apply = (edit) => {
    const result = onEdit(edit);
    if (result?.ok !== false) onEditingChange(null);
    return result;
  };
  const remove = (id) => {
    const result = onEdit({ type: 'remove', id });
    setRemoveError(result?.ok === false ? result.error : null);
  };
  return (
  <Box>
    {suggest.suggestMode === 'text-fallback' && (
      <Alert severity="warning" sx={{ mb: 2 }}>{TEXT_FALLBACK_NOTICE}</Alert>
    )}
    {suggest.subjectAnalysis && (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          {/* The original analysis stays the AI's; editing headings does not regenerate it. */}
          <Typography variant="subtitle1" gutterBottom>AI analysis of the work</Typography>
          <Typography variant="body2" color="text.secondary">{shownText(suggest.subjectAnalysis)}</Typography>
        </CardContent>
      </Card>
    )}
    <Alert severity="info" sx={{ mb: 2 }}>{SUGGESTION_NOTE}</Alert>
    {editable && hasDownstream && <Alert severity="warning" sx={{ mb: 2 }}>{DOWNSTREAM_WARNING}</Alert>}
    {removeError && <Alert severity="error" sx={{ mb: 2 }}>{removeError}</Alert>}
    {suggest.suggestions.length === 0 && (
      <Typography color="text.secondary" sx={{ mb: 1 }}>No suggestions. Add a heading to look it up.</Typography>
    )}
    <List>
      {suggest.suggestions.map((s) => (
        <ListItem key={s.id} divider sx={{ flexWrap: 'wrap' }} id={`suggestion-${s.id}`}>
          {editable && editingId === s.id ? (
            <SuggestionEditor
              suggestion={s}
              onApply={apply}
              onCancel={() => onEditingChange(null)}
              showWarning={hasDownstream}
            />
          ) : (
            <>
              <ListItemText
                primary={(
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body1">{shownText(s.heading)}</Typography>
                    <Chip size="small" variant="outlined" label={shownText(`${authorLabel(s.source)} · ${s.kind}`)} />
                  </Box>
                )}
                secondary={shownText(s.reason) || null}
              />
              {editable && (
                <Stack direction="row" spacing={1}>
                  <Button size="small" onClick={() => onEditingChange(s.id)}>Edit</Button>
                  <Button size="small" color="error" onClick={() => remove(s.id)}>Remove</Button>
                </Stack>
              )}
            </>
          )}
        </ListItem>
      ))}
    </List>
    {editable && (
      <AddHeading onAdd={apply} full={suggest.suggestions.length >= MAX_SUGGESTIONS} showWarning={hasDownstream} />
    )}
  </Box>
  );
};

/**
 * Whether the run has results that an applied edit would clear (SPEC-UI2 §2).
 * @param {object} run - Run state
 * @returns {boolean}
 */
export const hasDownstreamResults = (run) => Object.keys(run.lookup.results).length > 0
  || Object.keys(run.lookup.pending).length > 0
  || run.select.pending || run.select.mode !== null || Object.keys(run.select.manual).length > 0
  || run.recommendations !== null;

const InitialSuggestions = () => {
  const {
    run, workflow, setActiveStep, focusRequest = null, clearFocusRequest = () => {}
  } = useAppContext();
  const [editingId, setEditingId] = useState(null);
  const [notice, setNotice] = useState(null);
  const ready = Boolean(run.suggest) && run.run.stage !== 'idle' && run.run.stage !== 'suggesting';

  // "Edit search heading" (SPEC-UI2 §5): open that suggestion's draft editor.
  // Opening issues no request and invalidates nothing.
  useEffect(() => {
    if (!focusRequest || focusRequest.view !== 'suggestions') return;
    clearFocusRequest();
    if ((run.suggest?.suggestions || []).some((s) => s.id === focusRequest.suggestionId)) {
      setEditingId(focusRequest.suggestionId);
      setNotice(null);
    } else {
      setNotice('That suggestion is no longer in the list.');
    }
  }, [focusRequest]);

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
      <Typography variant="h6" gutterBottom>{SUGGESTIONS_HEADING}</Typography>
      <KeysUnavailableNotice />
      {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
      <SuggestionsPanel
        suggest={run.suggest}
        editable={ready}
        onEdit={workflow.editSuggestions}
        hasDownstream={hasDownstreamResults(run)}
        editingId={editingId}
        onEditingChange={setEditingId}
      />
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
        <Button variant="outlined" onClick={handleBack}>Back</Button>
        <Button variant="contained" onClick={handleLookup} disabled={run.suggest.suggestions.length === 0}>
          Look up at the Library of Congress
        </Button>
      </Box>
    </Box>
  );
};

export default InitialSuggestions;
