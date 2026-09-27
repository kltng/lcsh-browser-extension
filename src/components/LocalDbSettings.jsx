import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Typography, Button, Alert, Radio, RadioGroup, FormControlLabel, FormControl, FormLabel, LinearProgress,
  Accordion, AccordionSummary, AccordionDetails, Link, Stack, Dialog, DialogTitle, DialogContent, DialogActions,
  List, ListItem, ListItemText
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { getSettings, setLookupBackend } from '../services/settings';
import { useAppContext } from '../context/AppContext';

/** Human sizes; the values always come from the pointer, never from a guess. */
export const formatBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
};

export const KEEP_TAB_OPEN = 'Keep this tab open until it finishes.';
export const FULL_WARNING = 'Large download (about 1.9 GB) and about 5.4 GB of disk space.';
export const COMMITTING_TEXT = 'Finishing install…';

/** The §3.4 / §3.1 states in words, with what the user can do about them. */
export const STATE_TEXT = {
  'other-tab': 'The local database is open in another tab of this extension.',
  'repair-needed': 'The local database is damaged or missing.',
  'recovery-unavailable': 'Local database settings could not be read.',
  'worker-failed': 'The local database could not be started in this tab.',
  starting: 'Opening the local database…'
};

/**
 * The confirmation text of an install (SPEC-P5 §4.3): the additional space the
 * install needs, and the peak while both databases exist.
 * @param {{profile:string, entry:object, release:string, installed:object|null}} args - The selected install
 * @returns {string[]}
 */
export const confirmationLines = ({ profile, entry, release, installed }) => [
  `Profile: ${profile}`,
  `Release: ${release}`,
  `Download: ${formatBytes(entry.gzSize)}`,
  `Database size: ${formatBytes(entry.dbSize)}`,
  `Additional space needed now: ${formatBytes(entry.dbSize)}`,
  `Peak database storage during the install: ${formatBytes((installed?.dbSize || 0) + entry.dbSize)}`,
  KEEP_TAB_OPEN,
  ...(profile === 'full' ? [FULL_WARNING] : [])
];

/**
 * A profile's install offer, from the pointer.
 * @param {{profile:string, entry:object|undefined, title:string, note?:string, disabled:boolean, onInstall:Function}} props - Offer
 * @returns {JSX.Element}
 */
const ProfileOffer = ({ profile, entry, title, note, disabled, onInstall }) => (
  <Box sx={{ my: 1 }}>
    <Typography variant="body2">
      {title} (download {formatBytes(entry?.gzSize)}, disk {formatBytes(entry?.dbSize)})
      {note ? ` ${note}` : ''}
    </Typography>
    <Button size="small" variant="outlined" disabled={disabled} onClick={() => onInstall(profile)} sx={{ mt: 0.5 }}>
      Download
    </Button>
  </Box>
);

/**
 * The §4.3 confirmation, shown BEFORE any download. Its numbers come from the
 * pointer and the installed record only.
 * @param {{pending:{profile:string, entry:object, repair:boolean}|null, release:string, installed:object|null,
 *   onConfirm:Function, onClose:Function}} props - The pending install
 * @returns {JSX.Element}
 */
export const ConfirmationBody = ({ pending, release, installed, onConfirm, onClose }) => {
  if (!pending) return null;
  return (
    <>
      <DialogTitle id="localdb-confirm-title">
        {pending.repair ? 'Repair the local database' : 'Download the local database'}
      </DialogTitle>
      <DialogContent>
        <List dense>
          {confirmationLines({ profile: pending.profile, entry: pending.entry, release, installed }).map((line) => (
            <ListItem key={line} disableGutters>
              <ListItemText primary={line} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={onConfirm}>Download</Button>
      </DialogActions>
    </>
  );
};

/** The confirmation in its dialog. */
export const InstallConfirmation = (props) => (
  <Dialog open={Boolean(props.pending)} onClose={props.onClose} aria-labelledby="localdb-confirm-title">
    <ConfirmationBody {...props} />
  </Dialog>
);

/**
 * Settings → "Lookup source" (SPEC-P5 §8). Every number comes from the pointer
 * or from the installed record; nothing is estimated here.
 * @param {object} props - State and callbacks
 * @returns {JSX.Element}
 */
export const LocalDbSettings = ({
  lookupBackend, installed, state, pointer, pointerError, operation, progress, update, cleanupPending,
  errorMessage, storageEstimate, onBackendChange, onInstall, onRepair, onUninstall, onCancel, onRetryOwnership,
  onCheckUpdate
}) => {
  const busy = Boolean(operation);
  const committing = operation?.phase === 'committing' || operation?.phase === 'cleaning';
  const stateText = STATE_TEXT[state];
  return (
    <Box sx={{ mt: 3 }}>
      <FormControl>
        <FormLabel id="lookup-source-label">Lookup source</FormLabel>
        <RadioGroup
          aria-labelledby="lookup-source-label"
          value={lookupBackend || 'loc-api'}
          onChange={(event) => onBackendChange(event.target.value)}
        >
          <FormControlLabel value="loc-api" control={<Radio />} label="Library of Congress (online)" />
          <FormControlLabel value="local-db" control={<Radio />} label="Local database" />
        </RadioGroup>
      </FormControl>

      {lookupBackend === 'local-db' && !installed && (
        <Alert severity="info" sx={{ my: 1 }}>Local database not installed; using the Library of Congress online.</Alert>
      )}
      {stateText && (
        <Alert
          severity={state === 'other-tab' ? 'info' : 'warning'}
          sx={{ my: 1 }}
          action={state === 'other-tab' ? <Button size="small" onClick={onRetryOwnership}>Try again</Button> : null}
        >
          {stateText}
          {state === 'other-tab' ? ' Use the Library of Congress online in this tab.' : ''}
        </Alert>
      )}
      {errorMessage && (
        <Alert severity="error" sx={{ my: 1 }} action={<Button size="small" onClick={() => onInstall(installed?.profile || 'core')}>Try again</Button>}>
          {errorMessage}
        </Alert>
      )}
      {pointerError && <Alert severity="warning" sx={{ my: 1 }}>{pointerError}</Alert>}
      {update && (
        <Alert severity="info" sx={{ my: 1 }}>
          New LCSH data available (release {update.release}).{' '}
          <Link href={update.changesUrl} target="_blank" rel="noopener noreferrer">What changed</Link>
        </Alert>
      )}

      {installed && (
        <Box sx={{ my: 2 }}>
          <Typography variant="body2">
            Installed: {installed.profile} · release {installed.release} · {formatBytes(installed.dbSize)} ·
            {' '}installed {installed.installedAt.slice(0, 10)}
          </Typography>
          {cleanupPending && <Alert severity="info" sx={{ my: 1 }}>Cleanup pending: an old database file could not be deleted yet.</Alert>}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" disabled={busy} onClick={onRepair}>Repair</Button>
            <Button size="small" variant="outlined" color="error" disabled={busy} onClick={onUninstall}>Uninstall</Button>
          </Stack>
        </Box>
      )}

      {busy && (
        <Box sx={{ my: 2 }}>
          <Typography variant="body2">
            {committing ? COMMITTING_TEXT : `${progress?.phase === 'verifying' ? 'Verifying' : 'Downloading'}: ${formatBytes(progress?.done)} of ${formatBytes(progress?.total)}`}
          </Typography>
          <LinearProgress
            variant={progress?.total ? 'determinate' : 'indeterminate'}
            value={progress?.total ? Math.min(100, (100 * progress.done) / progress.total) : 0}
            sx={{ my: 1 }}
          />
          <Typography variant="caption" color="text.secondary">{KEEP_TAB_OPEN}</Typography>
          <Box sx={{ mt: 1 }}>
            <Button size="small" disabled={committing} onClick={() => onCancel(operation.operationId)}>
              {committing ? COMMITTING_TEXT : 'Cancel'}
            </Button>
          </Box>
        </Box>
      )}

      {/*
        Review finding 13: the download and check controls are ALWAYS here, with
        or without a cached pointer. Sizes still come only from a validated
        pointer; without one they read "—" and the §4.3 confirmation fetches it
        before anything is downloaded.
      */}
      {!busy && (
        <Box sx={{ my: 2 }}>
          <ProfileOffer
            profile="core"
            entry={pointer?.profiles.core}
            title="Core — subjects and genres"
            note="Names are looked up online."
            disabled={busy}
            onInstall={onInstall}
          />
          <Accordion disableGutters elevation={0}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">Advanced</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <ProfileOffer
                profile="full"
                entry={pointer?.profiles.full}
                title="Full — also 12 million names"
                note={FULL_WARNING}
                disabled={busy}
                onInstall={onInstall}
              />
            </AccordionDetails>
          </Accordion>
          {onCheckUpdate && (
            <Button size="small" onClick={onCheckUpdate} sx={{ mt: 1 }}>Check for a new release</Button>
          )}
        </Box>
      )}

      {storageEstimate && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Estimated storage used by this extension: {formatBytes(storageEstimate.usage)} of a{' '}
          {formatBytes(storageEstimate.quota)} quota. This is not free disk space.
        </Typography>
      )}
    </Box>
  );
};

/**
 * Wire one MOUNTED panel to the document-owned client and update checker.
 *
 * N3: the mutation belongs to the document, so the panel that is mounted when
 * it FINISHES must reload the settings — the panel that started it may have
 * been unmounted by a hash navigation, and its reload would then update
 * nothing. Every callback is silenced by the returned unsubscribe.
 *
 * @param {{client:object|null, updates:object|null, onStatus:Function, onRelease:Function,
 *   onSettings:Function, readSettings?:Function}} deps - The client, the checker and the panel's setters
 * @returns {()=>void} - Unsubscribe
 */
export const subscribePanel = ({
  client, updates, onStatus, onRelease, onSettings, readSettings = getSettings
}) => {
  let alive = true;
  let lastOperationId = client?.operation()?.operationId ?? null;
  const refreshSettings = () => {
    Promise.resolve()
      .then(readSettings)
      .then((merged) => {
        if (alive) onSettings(merged);
      })
      .catch(() => {});
  };
  refreshSettings();
  const onSnapshot = (next) => {
    if (!alive) return;
    onStatus(next);
    const operationId = next.operation?.operationId ?? null;
    if (lastOperationId !== null && operationId === null) refreshSettings();
    lastOperationId = operationId;
  };
  // Both subscriptions deliver a snapshot immediately, so a remount during an
  // install restores the operation, the phase and the progress.
  const stopState = client?.onChange(onSnapshot) || (() => {});
  const stopProgress = client?.onProgress(onSnapshot) || (() => {});
  const stopRelease = updates?.subscribe((next) => alive && onRelease(next)) || (() => {});
  return () => {
    alive = false;
    stopState();
    stopProgress();
    stopRelease();
  };
};

/**
 * The container. Review findings 9 and 13: it owns NO long-lived operation
 * state and no update throttle. The running mutation and its progress come
 * from the document-owned client (so leaving and returning to Settings during
 * an install shows the same thing), and the pointer comes from the
 * document-owned update checker.
 * @returns {JSX.Element|null}
 */
export const LocalDbPanel = () => {
  const { localDbClient, localDbUpdates } = useAppContext();
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(() => localDbClient?.snapshot() || { state: 'other-tab', record: null });
  const [release, setRelease] = useState(() => localDbUpdates?.snapshot() || { pointer: null, error: null, update: null });
  const [errorMessage, setErrorMessage] = useState(null);
  const [storageEstimate, setStorageEstimate] = useState(null);
  const [pending, setPending] = useState(null);

  // Unmount protection: `run()` may outlive the panel that started it.
  const mounted = useRef(true);
  const reload = useCallback(async () => {
    const merged = await getSettings();
    if (mounted.current) setSettings(merged);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const stop = subscribePanel({
      client: localDbClient, updates: localDbUpdates, onStatus: setStatus, onRelease: setRelease, onSettings: setSettings
    });
    return () => {
      mounted.current = false;
      stop();
    };
  }, [localDbClient, localDbUpdates]);

  const run = async (fn) => {
    setErrorMessage(null);
    try {
      await fn(crypto.randomUUID());
    } catch (err) {
      if (mounted.current) setErrorMessage(err?.message || 'The local database operation failed.');
    } finally {
      await reload();
    }
  };

  if (!settings) return null;

  const pointer = release.pointer;

  // §4.3: nothing is downloaded before the confirmation is shown and accepted.
  // The pointer is fetched here when it is not cached, so the numbers shown in
  // the confirmation always come from a validated pointer.
  const ask = async (profile, repair = false) => {
    setErrorMessage(null);
    const value = pointer || await localDbUpdates?.refresh(settings.localDb);
    if (!value?.profiles[profile]) return;
    setPending({ profile, repair, entry: value.profiles[profile], release: value.release, pointer: value });
  };

  const confirm = () => {
    const chosen = pending;
    setPending(null);
    return run(async (operationId) => {
      // The confirming click also asks for persistent storage; the result is
      // shown, not required.
      await navigator.storage?.persist?.().catch(() => false);
      setStorageEstimate(await navigator.storage?.estimate?.().catch(() => null));
      await localDbClient.install({
        pointer: chosen.pointer, profile: chosen.profile, operationId, repair: chosen.repair
      });
    });
  };

  return (
    <>
      <InstallConfirmation
        pending={pending}
        release={pending?.release}
        installed={settings.localDb}
        onConfirm={confirm}
        onClose={() => setPending(null)}
      />
      <LocalDbSettings
        lookupBackend={settings.lookupBackend}
        installed={settings.localDb}
        state={status.state === 'ready' ? null : status.state}
        pointer={pointer}
        pointerError={release.error}
        operation={status.operation}
        progress={status.progress}
        update={release.update}
        cleanupPending={settings.localDbPendingDeletes.length > 0}
        errorMessage={errorMessage}
        storageEstimate={storageEstimate}
        onBackendChange={async (id) => {
          await setLookupBackend(id);
          await reload();
        }}
        onInstall={(profile) => ask(profile)}
        onRepair={() => ask(settings.localDb.profile, true)}
        onUninstall={() => run((operationId) => localDbClient.uninstall({ operationId }))}
        onCancel={(operationId) => localDbClient.cancel(operationId).catch(() => {})}
        onRetryOwnership={() => localDbClient.retryOwnership()}
        onCheckUpdate={() => localDbUpdates?.refresh(settings.localDb)}
      />
    </>
  );
};

export default LocalDbPanel;
