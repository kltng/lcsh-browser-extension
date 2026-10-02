import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Container,
  Paper,
  Alert,
  CircularProgress
} from '@mui/material';
import { Launch, Settings as SettingsIcon } from '@mui/icons-material';
import { computeLauncherStatus, openAppTab, LAUNCHER_STATUS } from '../services/launcher';
import { getSettings, onSettingsChanged } from '../services/settings';

/**
 * SPEC-UI2 §10: the popup's one database line, from the SAVED settings only.
 * It does not claim database health, offline completeness or the effective
 * lookup backend.
 * @param {object|null} settings - Result of getSettings(), or null when reading failed
 * @returns {string}
 */
export const offlineDatabaseLine = (settings) => {
  if (!settings) return 'Offline database: status unavailable';
  if (settings.localDbInvalid) return 'Offline database: saved record needs attention';
  const record = settings.localDb;
  if (!record) return 'Offline database: not installed';
  return `Offline database recorded: ${record.profile} (release ${record.release})`;
};

/**
 * The popup body for a computed status (presentational).
 * @param {{state:object|null, onOpen:Function, onSettings:Function}} props - Status and handlers
 * @returns {JSX.Element}
 */
export const PopupView = ({ state, onOpen, onSettings, dbLine = null }) => {
  const isReady = state?.status === 'ready';
  const severity = !state ? 'info' : (isReady ? 'success' : (state.status === 'error' ? 'error' : 'warning'));
  return (
    <Container maxWidth="sm" sx={{ p: 2 }}>
      <Paper elevation={3} sx={{ p: 3 }}>
        <Typography variant="h5" component="h1" gutterBottom align="center">
          LCSH Recommendation Tool
        </Typography>

        {!state ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <Box sx={{ mb: 2 }}>
            {state.providerName && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {state.providerName} · {state.model || 'no model chosen'}
              </Typography>
            )}
            <Alert severity={severity}>{state.label}</Alert>
          </Box>
        )}
        {dbLine && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{dbLine}</Typography>
        )}

        <Button
          fullWidth
          variant="contained"
          color="primary"
          size="large"
          startIcon={<Launch />}
          onClick={onOpen}
          disabled={!isReady}
          sx={{ mb: 1 }}
        >
          Open LCSH tool
        </Button>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<SettingsIcon />}
          onClick={onSettings}
        >
          Settings
        </Button>

        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block', textAlign: 'center' }}>
          v1.1.0 &middot;{' '}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://www.cataloguer.name/privacy' }); }}
            style={{ color: 'inherit' }}
          >
            Privacy Policy
          </a>
        </Typography>
      </Paper>
    </Container>
  );
};

/**
 * Popup launcher: shows the active provider and one status, and opens the app.
 * @returns {JSX.Element}
 */
const PopupLauncher = () => {
  const [state, setState] = useState(null);
  const [dbLine, setDbLine] = useState(null);

  useEffect(() => {
    let alive = true;
    computeLauncherStatus()
      .catch(() => ({ status: 'error', label: LAUNCHER_STATUS.error, providerName: null, model: null }))
      .then((next) => {
        if (alive) setState(next);
      });
    // SPEC-UI2 §10: read settings only (no database worker, no request), and
    // refresh when the installation settings change while the popup is open.
    const readDb = () => getSettings()
      .then((settings) => { if (alive) setDbLine(offlineDatabaseLine(settings)); })
      .catch(() => { if (alive) setDbLine(offlineDatabaseLine(null)); });
    readDb();
    const stop = onSettingsChanged((changes) => {
      if (Object.hasOwn(changes, 'localDb')) readDb();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const handleOpen = async () => {
    await openAppTab();
    window.close();
  };

  const handleSettings = async () => {
    await openAppTab({ settings: true });
    window.close();
  };

  return <PopupView state={state} onOpen={handleOpen} onSettings={handleSettings} dbLine={dbLine} />;
};

export default PopupLauncher;
