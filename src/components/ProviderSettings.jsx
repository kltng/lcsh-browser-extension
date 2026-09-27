import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  MenuItem,
  IconButton,
  InputAdornment,
  Autocomplete,
  FormControlLabel,
  Checkbox,
  Link,
  CircularProgress
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { saveProviderDraft, saveProviderAndActivate } from '../services/settings';
import {
  resolveConfigFromDraft, listModels, testConnection, probeJsonModes, ProviderError
} from '../services/providers/index';
import {
  regionFor, modelMetaKey, findModelMeta, resolveCapabilities
} from '../services/providers/capabilities';
import {
  initialDraftState, applyStoredChange, editDraft, afterSave, patchFromDraft, runGestureAction, watchSavedAccess
} from './providerDraft';

const STALE_MESSAGE = 'Settings changed in another tab — reload them.';
const JSON_MODE_LABELS = {
  json_schema: 'JSON Schema (strict)',
  json_object: 'JSON object',
  prompt: 'Prompt only (checked locally)'
};
const QWEN_HELP = 'Qwen workspace endpoints ({WorkspaceId}.<region>.maas.aliyuncs.com) are not supported here. '
  + 'The Custom provider can call them, but without Qwen\'s enable_thinking setting.';

const messageOf = (err) => (err instanceof ProviderError ? err.message : 'Something went wrong. Try again.');

const jsonLine = (result) => {
  if (!result.ok) return { severity: 'error', text: `Structured output failed: ${result.error?.message || 'unknown error'}` };
  if (result.effectiveJsonMode === 'prompt') return { severity: 'success', text: 'JSON checked locally (not enforced by the server)' };
  return { severity: 'success', text: `Structured output OK (${result.effectiveJsonMode})` };
};

/**
 * Draft form for one cloud or local provider (SPEC-P3 §5.4, §6).
 * @param {{entry:object, stored:object, modelMeta:object, isActive:boolean}} props - Registry entry and saved values
 * @returns {JSX.Element}
 */
const ProviderSettings = ({ entry, stored, modelMeta, isActive }) => {
  const [form, setForm] = useState(() => initialDraftState(stored));
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState(null);
  const [suggestedMode, setSuggestedMode] = useState(null);
  const [needsGrant, setNeedsGrant] = useState(false);
  const recheckRef = useRef(() => {});

  // Another tab saved: a clean form refreshes, a dirty form becomes stale
  useEffect(() => {
    setForm((state) => applyStoredChange(state, stored));
  }, [stored]);

  // Does the SAVED configuration have its host permission? Rechecked (read-only)
  // on chrome.permissions.onRemoved/onAdded and after a permission error.
  useEffect(() => {
    const watcher = watchSavedAccess(entry, stored, setNeedsGrant);
    recheckRef.current = watcher.recheck;
    return () => watcher.unsubscribe();
  }, [entry, stored]);

  const recheckOnPermissionError = (err) => {
    if (err?.kind === 'permission') recheckRef.current();
  };

  const { draft, locked } = form;
  const metaEntry = modelMeta[modelMetaKey(entry.id, regionFor(entry, draft))] || null;
  const effectiveModel = draft.model.trim() || entry.defaultModel || '';
  const caps = resolveCapabilities(entry, draft, findModelMeta(metaEntry, effectiveModel));
  const modelOptions = (models || metaEntry?.models || []).map((m) => m.id);
  const showMessages = form.stale ? [{ severity: 'warning', text: STALE_MESSAGE }, ...messages] : messages;

  const handleField = (field) => (e) => {
    setForm((state) => editDraft(state, field, e.target.value));
  };

  // The gesture rule: validation, origin and chrome.permissions.request happen first, synchronously.
  // A save also locks the form (fields and buttons) until it completes.
  // A denied request saves nothing and keeps the typed draft (runGestureAction)
  const runWithPermission = (value, work, { save = false } = {}) => runGestureAction(entry, value, work, {
    save,
    setForm,
    setBusy,
    setMessages,
    recheck: () => recheckRef.current(),
    onError: (err) => {
      recheckOnPermissionError(err);
      setMessages([{ severity: 'error', text: messageOf(err) }]);
    }
  });

  const handleSaveResult = (result, okText) => {
    setForm((state) => afterSave(state, result));
    setMessages(result.saved ? [{ severity: 'success', text: okText }] : []);
    if (result.saved) setNeedsGrant(false);
  };

  const handleSave = () => runWithPermission(form.draft, async () => {
    const result = await saveProviderDraft(entry.id, patchFromDraft(entry, form.draft), form.base);
    handleSaveResult(result, 'Saved.');
  }, { save: true });

  const handleSaveAndUse = () => runWithPermission(form.draft, async () => {
    const result = await saveProviderAndActivate(entry.id, patchFromDraft(entry, form.draft), form.base);
    handleSaveResult(result, `Saved. ${entry.name} is now used for the workflow.`);
  }, { save: true });

  const handleTest = () => runWithPermission(form.draft, async () => {
    let cfg;
    try {
      cfg = await resolveConfigFromDraft(entry, form.draft, { purpose: 'generate', modelMeta: metaEntry });
    } catch (err) {
      setMessages([{ severity: 'error', text: messageOf(err) }]);
      return;
    }
    const lines = [];
    const text = await testConnection(cfg, { mode: 'text' });
    recheckOnPermissionError(text.error);
    lines.push(text.ok ? { severity: 'success', text: 'Connection OK' } : { severity: 'error', text: text.error.message });
    setMessages([...lines]);
    if (entry.json === 'user-choice') {
      const probe = await probeJsonModes(cfg);
      probe.results.forEach((r) => {
        recheckOnPermissionError(r.error);
        const line = jsonLine(r);
        lines.push({ ...line, text: `${JSON_MODE_LABELS[r.jsonMode]}: ${line.text}` });
      });
      setSuggestedMode(probe.suggested);
    } else {
      const json = await testConnection(cfg, { mode: 'json' });
      recheckOnPermissionError(json.error);
      lines.push(jsonLine(json));
    }
    setMessages(lines);
  });

  const handleLoadModels = () => runWithPermission(form.draft, async () => {
    const cfg = await resolveConfigFromDraft(entry, form.draft, { purpose: 'list' });
    const result = await listModels(cfg);
    if (!result.supported) {
      setMessages([{ severity: 'info', text: `${entry.name} has no model list. Type the model name.` }]);
      return;
    }
    setModels(result.models);
    const note = result.partial ? ' (the list is long; only the first pages are shown)' : '';
    setMessages([{ severity: 'success', text: `Loaded ${result.models.length} models${note}.` }]);
  });

  // Grant access for the SAVED configuration (not the draft)
  const handleGrant = () => runWithPermission(stored, async () => {
    await recheckRef.current();
    setMessages([{ severity: 'success', text: 'Access granted.' }]);
  });

  const handleReload = () => {
    setForm(initialDraftState(stored));
    setMessages([]);
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        {entry.name} {isActive && <Typography component="span" color="primary">(in use)</Typography>}
      </Typography>

      {needsGrant && (
        <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={handleGrant} disabled={busy}>Grant access</Button>}>
          Chrome needs your permission to contact this provider.
        </Alert>
      )}

      {entry.regionSelectable && (
        <TextField select fullWidth size="small" label="Region" value={regionFor(entry, draft)} onChange={handleField('region')} disabled={locked} sx={{ mb: 2 }}>
          <MenuItem value="intl">International ({entry.regions.intl.baseURL})</MenuItem>
          <MenuItem value="cn">China ({entry.regions.cn.baseURL})</MenuItem>
        </TextField>
      )}

      {(entry.id === 'custom' || entry.id === 'lmstudio') && (
        <TextField
          fullWidth size="small" label="Server address (base URL)" value={draft.baseURL} onChange={handleField('baseURL')} disabled={locked}
          placeholder={entry.regions?.intl?.baseURL || 'https://example.com/v1'}
          helperText="https://…, or http:// only for localhost and 127.0.0.1" sx={{ mb: 2 }}
        />
      )}

      <TextField
        fullWidth size="small" label={entry.keyRequired === 'yes' ? 'API key' : 'API key (optional)'}
        type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={handleField('apiKey')} sx={{ mb: 1 }}
        autoComplete="off" disabled={locked}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowKey(!showKey)} edge="end" aria-label={showKey ? 'Hide key' : 'Show key'}>
                {showKey ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          )
        }}
      />
      {entry.keyHelpUrl && (
        <Typography variant="caption" sx={{ display: 'block', mb: 2 }}>
          <Link href={entry.keyHelpUrl} target="_blank" rel="noopener noreferrer">Get an API key</Link>
        </Typography>
      )}
      {entry.id === 'qwen' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{QWEN_HELP}</Typography>
      )}

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 2 }}>
        <Autocomplete
          freeSolo fullWidth size="small" options={modelOptions}
          inputValue={draft.model} disabled={locked}
          onInputChange={(e, value, reason) => {
            if (reason === 'reset' && !value) return;
            setForm((state) => (state.draft.model === value ? state : editDraft(state, 'model', value)));
          }}
          renderInput={(params) => (
            <TextField {...params} label="Model" placeholder={entry.defaultModel || 'Type or load a model name'} />
          )}
        />
        {entry.models !== 'none' && (
          <Button variant="outlined" onClick={handleLoadModels} disabled={busy} sx={{ whiteSpace: 'nowrap' }}>
            Load models
          </Button>
        )}
      </Box>

      {entry.json === 'user-choice' && (
        <TextField select fullWidth size="small" label="JSON mode" value={draft.jsonMode || 'json_schema'} onChange={handleField('jsonMode')} disabled={locked} sx={{ mb: 2 }}>
          {Object.entries(JSON_MODE_LABELS).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
      )}

      {!caps.imagesKnown && (
        <FormControlLabel
          sx={{ mb: 2 }}
          control={<Checkbox checked={draft.imagesOverride} disabled={locked} onChange={(e) => setForm((state) => editDraft(state, 'imagesOverride', e.target.checked))} />}
          label="This model can read images (the provider does not say)"
        />
      )}

      {showMessages.map((m, i) => (
        <Alert
          key={`${m.text}-${i}`} severity={m.severity} sx={{ mb: 1 }}
          action={m.text === STALE_MESSAGE ? <Button color="inherit" size="small" onClick={handleReload} disabled={busy}>Reload</Button> : undefined}
        >
          {m.text}
        </Alert>
      ))}
      {suggestedMode && entry.json === 'user-choice' && (
        <Alert severity="info" sx={{ mb: 1 }} action={<Button color="inherit" size="small" disabled={busy} onClick={() => setForm((state) => editDraft(state, 'jsonMode', suggestedMode))}>Use it</Button>}>
          Suggested JSON mode: {JSON_MODE_LABELS[suggestedMode]}. Save to keep it.
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mt: 2 }}>
        <Button variant="outlined" onClick={handleTest} disabled={busy}>Test connection</Button>
        <Button variant="outlined" onClick={handleSave} disabled={busy}>Save</Button>
        <Button variant="contained" onClick={handleSaveAndUse} disabled={busy}>Save &amp; use</Button>
        {busy && <CircularProgress size={20} />}
      </Box>
    </Box>
  );
};

export default ProviderSettings;
