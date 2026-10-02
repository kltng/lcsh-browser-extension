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
  Divider,
  Tooltip,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getSettings, onSettingsChanged, setSubfieldDelimiter } from '../services/settings';
import { nanoAvailability, TEXT_OPTS } from '../services/providers/geminiNano';
import {
  isProviderConfigured, isNanoAvailable, CONFIGURED_LABEL, CONFIGURED_TOOLTIP, NANO_AVAILABLE_LABEL
} from './providerStatus';
import { useSubfieldDelimiter } from './useSubfieldDelimiter';
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
  // SPEC-UI2 §7: Nano's availability, read with availability() only — no
  // session is created and no download is started.
  const [nanoAvailabilityResult, setNanoAvailability] = useState(null);
  useEffect(() => {
    let alive = true;
    nanoAvailability(TEXT_OPTS).then((result) => { if (alive) setNanoAvailability(result); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
                  primary={(
                    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {p.name}
                      <ProviderMark entry={p} stored={settings.providers[p.id]} nanoAvailability={nanoAvailabilityResult} />
                    </Box>
                  )}
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
      <SettingsSection title="Output"><OutputSettings /></SettingsSection>
      <SettingsSection title="Selection rules (advanced)"><SystemPromptEditor /></SettingsSection>
    </Box>
  );
};

/**
 * The ✓ "Configured" / Nano "Available" mark of one provider (SPEC-UI2 §7).
 * @param {{entry:object, stored:object, nanoAvailability:any}} props - Entry, saved value, Nano result
 * @returns {JSX.Element|null}
 */
export const ProviderMark = ({ entry, stored, nanoAvailability: availability }) => {
  if (entry.adapter === 'chrome-nano') {
    return isNanoAvailable(availability)
      ? <Typography component="span" variant="caption" color="success.dark">{NANO_AVAILABLE_LABEL}</Typography>
      : null;
  }
  if (!isProviderConfigured(entry, stored)) return null;
  return (
    <Tooltip title={CONFIGURED_TOOLTIP} describeChild>
      <Typography component="span" variant="body2" color="success.dark" role="img" aria-label={CONFIGURED_LABEL} tabIndex={0}>
        ✓
      </Typography>
    </Tooltip>
  );
};

/**
 * Settings → Output (SPEC-UI2 §4): the subfield delimiter of MARC fields. It
 * is saved on its own; open views follow it without a new lookup or selection.
 * @returns {JSX.Element}
 */
export const OutputSettings = () => {
  const delimiter = useSubfieldDelimiter();
  const [error, setError] = useState(null);
  const choose = (value) => {
    setError(null);
    setSubfieldDelimiter(value).catch(() => setError('The setting could not be saved.'));
  };
  return (
    <FormControl>
      <FormLabel id="subfield-delimiter-label">Subfield delimiter</FormLabel>
      <RadioGroup row aria-labelledby="subfield-delimiter-label" value={delimiter} onChange={(e) => choose(e.target.value)}>
        <FormControlLabel value="$" control={<Radio />} label="$ (default)" />
        <FormControlLabel value="‡" control={<Radio />} label="‡" />
      </RadioGroup>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </FormControl>
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
