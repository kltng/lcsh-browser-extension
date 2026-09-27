import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Button,
  Typography,
  Alert,
  LinearProgress,
  CircularProgress
} from '@mui/material';
import { saveProviderAndActivate } from '../services/settings';
import { resolveConfigFromDraft, testConnection, ProviderError } from '../services/providers/index';
import {
  TEXT_OPTS, IMAGE_OPTS, hasNanoApi, nanoAvailability, startNanoDownload
} from '../services/providers/geminiNano';

const STATE_LABELS = {
  available: 'Ready',
  downloadable: 'Download needed',
  downloading: 'Downloading',
  unavailable: 'Not available on this device'
};

const messageOf = (err) => (err instanceof ProviderError ? err.message : 'Something went wrong. Try again.');

/**
 * Gemini Nano status, downloads and test (SPEC-P3 §4.3 Download, §6).
 * Nano never touches host permissions.
 * @param {{entry:object, stored:object, isActive:boolean}} props - Registry entry and saved value
 * @returns {JSX.Element}
 */
const NanoStatus = ({ entry, stored, isActive }) => {
  const [states, setStates] = useState({ text: null, image: null });
  const [download, setDownload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]);
  const jobRef = useRef(null);

  const recheck = async () => {
    const [text, image] = await Promise.all([nanoAvailability(TEXT_OPTS), nanoAvailability(IMAGE_OPTS)]);
    setStates({ text, image });
  };

  useEffect(() => {
    recheck();
    return () => jobRef.current?.cancel();
  }, []);

  // LanguageModel.create() runs synchronously inside startNanoDownload, inside the click gesture
  const handleDownload = (kind) => () => {
    const job = startNanoDownload(kind === 'image' ? IMAGE_OPTS : TEXT_OPTS, (loaded) => {
      setDownload((d) => (d ? { ...d, progress: loaded } : d));
    });
    jobRef.current = job;
    setDownload({ kind, progress: 0 });
    setMessages([]);
    job.promise
      .catch((err) => {
        if (err?.name !== 'AbortError') setMessages([{ severity: 'error', text: 'The download did not finish. Try again.' }]);
      })
      .finally(() => {
        jobRef.current = null;
        setDownload(null);
        recheck();
      });
  };

  const handleCancel = () => {
    jobRef.current?.cancel();
  };

  const handleSaveAndUse = async () => {
    setBusy(true);
    try {
      const result = await saveProviderAndActivate(entry.id, {}, stored);
      setMessages([result.saved
        ? { severity: 'success', text: 'Gemini Nano is now used for the workflow.' }
        : { severity: 'warning', text: 'Settings changed in another tab — reload them.' }]);
    } catch (err) {
      setMessages([{ severity: 'error', text: messageOf(err) }]);
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      const cfg = await resolveConfigFromDraft(entry, {}, { purpose: 'generate' });
      const text = await testConnection(cfg, { mode: 'text' });
      const lines = [text.ok ? { severity: 'success', text: 'Connection OK' } : { severity: 'error', text: text.error.message }];
      setMessages([...lines]);
      const json = await testConnection(cfg, { mode: 'json' });
      lines.push(json.ok
        ? { severity: 'success', text: `Structured output OK (${json.effectiveJsonMode})` }
        : { severity: 'error', text: `Structured output failed: ${json.error.message}` });
      setMessages(lines);
    } catch (err) {
      setMessages([{ severity: 'error', text: messageOf(err) }]);
    } finally {
      setBusy(false);
    }
  };

  const renderReadiness = (kind, label, buttonLabel) => {
    const state = states[kind];
    const canDownload = state === 'downloadable' || state === 'downloading';
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <Typography variant="body2" sx={{ minWidth: 140 }}>{label}</Typography>
        <Typography variant="body2" color="text.secondary">{state ? STATE_LABELS[state] || state : 'Checking…'}</Typography>
        {canDownload && !download && (
          <Button size="small" variant="outlined" onClick={handleDownload(kind)}>{buttonLabel}</Button>
        )}
      </Box>
    );
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        {entry.name} {isActive && <Typography component="span" color="primary">(in use)</Typography>}
      </Typography>
      <Typography variant="body2" color="text.secondary" paragraph>
        Runs on this computer inside Chrome. No API key and no internet connection to an AI provider are needed.
      </Typography>

      {!hasNanoApi() ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Gemini Nano is not available in this browser. It needs Chrome 138 or later on a supported device.
        </Alert>
      ) : (
        <Box sx={{ mb: 2 }}>
          {renderReadiness('text', 'Text input', 'Download for text')}
          {renderReadiness('image', 'Image input', 'Enable image input')}
        </Box>
      )}

      {download && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2">Downloading ({download.kind})… {Math.round((download.progress || 0) * 100)}%</Typography>
          <LinearProgress variant="determinate" value={Math.round((download.progress || 0) * 100)} sx={{ my: 1 }} />
          <Button size="small" onClick={handleCancel}>Cancel</Button>
        </Box>
      )}

      {messages.map((m, i) => (
        <Alert key={`${m.text}-${i}`} severity={m.severity} sx={{ mb: 1 }}>{m.text}</Alert>
      ))}

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2 }}>
        <Button variant="outlined" onClick={handleTest} disabled={busy || !!download}>Test connection</Button>
        <Button variant="contained" onClick={handleSaveAndUse} disabled={busy}>Save &amp; use</Button>
        {busy && <CircularProgress size={20} />}
      </Box>
    </Box>
  );
};

export default NanoStatus;
