import React, { useEffect, useState } from 'react';
import {
  Box, Container, Paper, Typography, Stepper, Step, StepLabel, Button, Alert
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import HistoryIcon from '@mui/icons-material/History';
import { useAppContext } from '../context/AppContext';
import SettingsPage from './SettingsPage';
import BibliographicInfoForm from './BibliographicInfoForm';
import InitialSuggestions from './InitialSuggestions';
import ScrapedResults from './ScrapedResults';
import FinalRecommendations from './FinalRecommendations';
import ConversationHistory from './ConversationHistory';

/** The workflow steps (UI round 1: History is a view, not a step). */
export const STEPS = ['Describe the work', 'AI suggestions', 'Matches', 'Recommendations'];
export const SETTINGS_HASH = '#settings';

const STEP_VIEWS = [BibliographicInfoForm, InitialSuggestions, ScrapedResults, FinalRecommendations];

/**
 * Listen to browser-driven hash changes (#settings typed, Back/Forward).
 * ui-2b item 2: the listener ends every Next ownership SYNCHRONOUSLY, in the
 * event itself, before the new hash reaches React state and an effect.
 * @param {EventTarget & {location:{hash:string}}} win - The window
 * @param {{onHash:(hash:string)=>void, noteNavigation:()=>void}} handlers - New hash, navigation note
 * @returns {()=>void} - Stop listening
 */
export const installHashRoute = (win, { onHash, noteNavigation }) => {
  const handleHashChange = () => {
    noteNavigation();
    onHash(win.location.hash);
  };
  win.addEventListener('hashchange', handleHashChange);
  return () => win.removeEventListener('hashchange', handleHashChange);
};

/**
 * The location hash as React state, for app.jsx (inside the AppProvider).
 * @returns {string}
 */
export const useHashRoute = () => {
  const { noteNavigation = () => {} } = useAppContext();
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => installHashRoute(window, { onHash: setHash, noteNavigation }), []);
  return hash;
};

/**
 * The app frame: the title, the Settings and History buttons, and the 4-step
 * workflow. Settings (`#settings`) and History open OVER the workflow, which
 * stays mounted and keeps its state; opening them leaves no workflow step.
 * @param {{hash:string, onNavigate:(hash:string)=>void}} props - The location hash and how to change it
 * @returns {JSX.Element}
 */
const AppShell = ({ hash, onNavigate }) => {
  const {
    activeStep, settingsStatus, settingsError, historyOpen, openHistory, noteNavigation = () => {}
  } = useAppContext();
  const showSettings = hash === SETTINGS_HASH;
  // Opening or closing Settings is a navigation too (SPEC-UI2 §1). It is noted
  // when REQUESTED (ui-2b item 2); this effect stays as a second line of defence.
  useEffect(() => { noteNavigation(); }, [showSettings]);
  const navigate = (next) => {
    noteNavigation();
    onNavigate(next);
  };
  const showHistory = historyOpen && !showSettings;
  const StepView = STEP_VIEWS[activeStep] || BibliographicInfoForm;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5', py: 4 }}>
      <Container maxWidth="lg">
        <Paper elevation={3} sx={{ p: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Box sx={{ width: 240 }} />
            <Typography variant="h4" component="h1" align="center">
              LCSH Recommendation Tool
            </Typography>
            <Box sx={{ width: 240, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              {!showHistory && !showSettings && (
                <Button variant="outlined" startIcon={<HistoryIcon />} onClick={openHistory}>
                  History
                </Button>
              )}
              {!showSettings && (
                <Button variant="outlined" startIcon={<SettingsIcon />} onClick={() => navigate('settings')}>
                  Settings
                </Button>
              )}
            </Box>
          </Box>

          {settingsStatus === 'error' && (
            <Alert severity="error" sx={{ my: 2 }}>
              {settingsError}
            </Alert>
          )}

          {showSettings && <SettingsPage onClose={() => navigate('')} />}
          {showHistory && <ConversationHistory />}

          {/* The workflow stays mounted while Settings or History is open, so no step loses its state */}
          <Box sx={{ display: showSettings || showHistory ? 'none' : 'block' }} data-testid="workflow">
            <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4, mt: 2 }}>
              {STEPS.map((label) => (
                <Step key={label}>
                  <StepLabel>{label}</StepLabel>
                </Step>
              ))}
            </Stepper>
            <Box sx={{ mt: 2 }}>
              <StepView />
            </Box>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default AppShell;
