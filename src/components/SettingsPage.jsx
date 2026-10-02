import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Alert,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  CircularProgress,
  Divider
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getSettings, onSettingsChanged } from '../services/settings';
import LocalDbPanel from './LocalDbSettings';
import { PROVIDERS } from '../services/providers/registry';
import ProviderSettings from './ProviderSettings';
import NanoStatus from './NanoStatus';
import SystemPromptEditor from './SystemPromptEditor';

/**
 * Settings screen: the AI provider (list and form), the lookup source and
 * offline database, and the selection rules (advanced).
 * Changes saved in another tab appear here through onSettingsChanged.
 * @param {{onClose:Function}} props - Called by the Back button
 * @returns {JSX.Element}
 */
const SettingsPage = ({ onClose }) => {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getSettings()
        .then((next) => {
          if (!alive) return;
          setSettings(next);
          setLoadError(null);
          setSelectedId((id) => id || next.activeProviderId);
        })
        .catch(() => { if (alive) setLoadError('Settings could not be loaded.'); });
    };
    load();
    const unsubscribe = onSettingsChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const providerSection = () => {
    if (loadError) return <Alert severity="error">{loadError}</Alert>;
    if (!settings) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      );
    }
    const entry = PROVIDERS.find((p) => p.id === selectedId) || PROVIDERS[0];
    const stored = settings.providers[entry.id] || {};
    const isActive = settings.activeProviderId === entry.id;
    return (
      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
        <Paper variant="outlined" sx={{ minWidth: 240 }}>
          <List dense>
            {PROVIDERS.map((p) => (
              <ListItemButton key={p.id} selected={p.id === entry.id} onClick={() => setSelectedId(p.id)}>
                <ListItemText
                  primary={p.name}
                  secondary={p.id === settings.activeProviderId ? 'In use' : null}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {entry.adapter === 'chrome-nano' ? (
            <NanoStatus key={entry.id} entry={entry} stored={stored} isActive={isActive} />
          ) : (
            <ProviderSettings
              key={entry.id}
              entry={entry}
              stored={stored}
              modelMeta={settings.modelMeta}
              isActive={isActive}
            />
          )}
        </Box>
      </Box>
    );
  };

  // UI round 1: three sections with headings. The local-database panel and
  // the selection rules do not wait for the provider settings.
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h5" component="h2">Settings</Typography>
        <Button startIcon={<ArrowBackIcon />} onClick={onClose}>Back to the workflow</Button>
      </Box>
      <SettingsSection title="AI provider">{providerSection()}</SettingsSection>
      <SettingsSection title="Lookup source and offline database"><LocalDbPanel /></SettingsSection>
      <SettingsSection title="Selection rules (advanced)"><SystemPromptEditor /></SettingsSection>
    </Box>
  );
};

/**
 * One headed section of the Settings page.
 * @param {{title:string, children:any}} props - Heading and content
 * @returns {JSX.Element}
 */
export const SettingsSection = ({ title, children }) => (
  <Box component="section" sx={{ mb: 4 }}>
    <Typography variant="h6" component="h3" gutterBottom>{title}</Typography>
    <Divider sx={{ mb: 2 }} />
    {children}
  </Box>
);

export default SettingsPage;
