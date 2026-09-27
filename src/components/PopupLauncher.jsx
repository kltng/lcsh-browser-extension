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

/**
 * The popup body for a computed status (presentational).
 * @param {{state:object|null, onOpen:Function, onSettings:Function}} props - Status and handlers
 * @returns {JSX.Element}
 */
export const PopupView = ({ state, onOpen, onSettings }) => {
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
          Open LCSH Tool
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

  useEffect(() => {
    let alive = true;
    computeLauncherStatus()
      .catch(() => ({ status: 'error', label: LAUNCHER_STATUS.error, providerName: null, model: null }))
      .then((next) => {
        if (alive) setState(next);
      });
    return () => { alive = false; };
  }, []);

  const handleOpen = async () => {
    await openAppTab();
    window.close();
  };

  const handleSettings = async () => {
    await openAppTab({ settings: true });
    window.close();
  };

  return <PopupView state={state} onOpen={handleOpen} onSettings={handleSettings} />;
};

export default PopupLauncher;
